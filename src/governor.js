import { DiagnosticCode, diagnostic } from './diagnostics.js';
import { weightedFairShare } from './allocate.js';

const RESOURCES = ['cpu', 'memory', 'pids'];
const TIERS = ['critical', 'standard', 'batch'];
const EPSILON = 1e-9;

const DEFAULT_CONFIG = Object.freeze({
  capacity: { cpu: 1, memory: 1, pids: 1 },
  criticalityWeights: { critical: 8, standard: 3, batch: 1 },
  // Expand and reclaim use deliberately different thresholds (hysteresis) so
  // quotas do not flap when demand hovers near the previous grant.
  hysteresis: {
    cpu: { scaleUp: 0.1, reclaim: 0.25 },
    memory: { scaleUp: 0.1, reclaim: 0.2 },
    pids: { scaleUp: 0.1, reclaim: 0.3 },
  },
  // Jitter scores decay every cycle, so a short burst of overruns only
  // demotes a node temporarily and never permanently.
  jitter: { decay: 0.6, maxPenalty: 0.5 },
  pidCeiling: 0.9,
  pidHeadroom: 0.7,
  oomPressureThreshold: 0.85,
  oomMemoryHeadroom: 1.2,
  oomMemoryFloor: 1.1,
  normalMemoryHeadroom: 1.05,
});

function mergeConfig(user = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...user,
    capacity: { ...DEFAULT_CONFIG.capacity, ...user.capacity },
    criticalityWeights: { ...DEFAULT_CONFIG.criticalityWeights, ...user.criticalityWeights },
    hysteresis: {
      cpu: { ...DEFAULT_CONFIG.hysteresis.cpu, ...user.hysteresis?.cpu },
      memory: { ...DEFAULT_CONFIG.hysteresis.memory, ...user.hysteresis?.memory },
      pids: { ...DEFAULT_CONFIG.hysteresis.pids, ...user.hysteresis?.pids },
    },
    jitter: { ...DEFAULT_CONFIG.jitter, ...user.jitter },
  };
}

function zeroBudget() {
  return { cpu: 0, memory: 0, pids: 0 };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function criticalityOf(node) {
  return TIERS.includes(node.criticality) ? node.criticality : 'standard';
}

function applyHysteresis(previous, target, { scaleUp, reclaim }) {
  if (previous === undefined || previous <= 0) return target;
  if (target > previous * (1 + scaleUp)) return target;
  if (target < previous * (1 - reclaim)) return target;
  return previous;
}

/**
 * Create a pure policy governor. It only consumes metrics and computes
 * next-cycle quotas; it never touches cgroups, containers, or the host kernel.
 */
export function createGovernor(userConfig = {}) {
  const config = mergeConfig(userConfig);
  const state = {
    version: 0,
    quotas: new Map(), // id -> { cpu, memory, pids }
    jitter: new Map(), // id -> { cpu, memory, pids } EWMA overrun scores
    tombstones: new Map(), // id -> version at which the node disappeared
  };

  function jitterScore(id, resource) {
    return state.jitter.get(id)?.[resource] ?? 0;
  }

  function updateJitter(node) {
    const previous = state.jitter.get(node.id) ?? zeroBudget();
    const overruns = node.metrics?.overruns ?? {};
    const next = {};
    for (const resource of RESOURCES) {
      const signal = clamp01(overruns[resource] ?? 0);
      next[resource] =
        config.jitter.decay * (previous[resource] ?? 0) + (1 - config.jitter.decay) * signal;
    }
    state.jitter.set(node.id, next);
  }

  function weightFor(node, resource) {
    const base = config.criticalityWeights[criticalityOf(node)] ?? 1;
    const multiplier = 1 - config.jitter.maxPenalty * clamp01(jitterScore(node.id, resource));
    return base * multiplier;
  }

  function isOomRisk(node) {
    const metrics = node.metrics ?? {};
    return (
      (metrics.memoryPressure ?? 0) >= config.oomPressureThreshold || (metrics.oomCount ?? 0) > 0
    );
  }

  function demandFor(node, resource) {
    const request = node.request?.[resource] ?? 0;
    const metrics = node.metrics ?? {};
    if (resource === 'cpu') return Math.max(request, metrics.cpuUsage ?? 0);
    if (resource === 'memory') {
      const headroom = isOomRisk(node) ? config.oomMemoryHeadroom : config.normalMemoryHeadroom;
      return Math.max(request, (metrics.memoryUsage ?? 0) * headroom);
    }
    let demand = Math.max(request, metrics.pidUsage ?? 0);
    const previous = state.quotas.get(node.id)?.pids;
    if (previous > 0 && (metrics.pidUsage ?? 0) / previous >= config.pidCeiling) {
      demand = Math.max(demand, (metrics.pidUsage ?? 0) / config.pidHeadroom);
    }
    return demand;
  }

  function floorFor(node, resource) {
    const metrics = node.metrics ?? {};
    if (resource === 'memory') {
      const usage = metrics.memoryUsage ?? 0;
      return isOomRisk(node) ? usage * config.oomMemoryFloor : usage;
    }
    if (resource === 'pids') return metrics.pidUsage ?? 0;
    return 0;
  }

  function planCycle(input = {}) {
    if (input.expectedVersion !== undefined && input.expectedVersion !== state.version) {
      return {
        ok: false,
        version: state.version,
        quotas: {},
        diagnostics: [
          diagnostic(
            DiagnosticCode.VERSION_CONFLICT,
            null,
            `concurrent state update: expected version ${input.expectedVersion} but governor is at ${state.version}`,
            { expectedVersion: input.expectedVersion, actualVersion: state.version },
          ),
        ],
      };
    }

    const diagnostics = [];
    const capacity = { ...config.capacity, ...input.capacity };
    const nodeList = input.nodes ?? [];

    const nodes = new Map();
    for (const node of nodeList) {
      if (nodes.has(node.id)) {
        diagnostics.push(
          diagnostic(
            DiagnosticCode.INVALID_TREE,
            node.id,
            `duplicate node id "${node.id}" ignored`,
          ),
        );
        continue;
      }
      nodes.set(node.id, node);
    }

    // Nodes referencing a parent that is not part of this cycle are stale
    // (e.g. their parent was removed concurrently); skip them loudly.
    const live = new Map();
    for (const node of nodes.values()) {
      if (node.parentId != null && !nodes.has(node.parentId)) {
        diagnostics.push(
          diagnostic(
            DiagnosticCode.STALE_NODE,
            node.id,
            `node "${node.id}" references missing parent "${node.parentId}"; skipped`,
            { parentId: node.parentId },
          ),
        );
        continue;
      }
      live.set(node.id, node);
    }

    const roots = [...live.values()].filter((node) => node.parentId == null);
    if (roots.length !== 1) {
      return {
        ok: false,
        version: state.version,
        quotas: {},
        diagnostics: [
          ...diagnostics,
          diagnostic(
            DiagnosticCode.INVALID_TREE,
            null,
            `expected exactly one root node, got ${roots.length}`,
            { roots: roots.map((node) => node.id) },
          ),
        ],
      };
    }

    const childrenOf = new Map();
    for (const node of live.values()) {
      if (node.parentId == null) continue;
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
      childrenOf.get(node.parentId).push(node);
    }

    // Tombstone removed nodes so their budgets are freed exactly once and
    // never double-distributed to siblings; drop their per-node state.
    for (const id of [...state.quotas.keys()]) {
      if (!live.has(id)) {
        state.quotas.delete(id);
        state.jitter.delete(id);
        state.tombstones.set(id, state.version);
      }
    }
    for (const id of live.keys()) state.tombstones.delete(id);

    for (const node of live.values()) updateJitter(node);

    for (const node of live.values()) {
      if (isOomRisk(node)) {
        diagnostics.push(
          diagnostic(
            DiagnosticCode.OOM_RISK,
            node.id,
            `node "${node.id}" is approaching OOM (pressure=${node.metrics?.memoryPressure ?? 0}, oomCount=${node.metrics?.oomCount ?? 0}); memory floor protected`,
            {
              memoryPressure: node.metrics?.memoryPressure ?? 0,
              oomCount: node.metrics?.oomCount ?? 0,
            },
          ),
        );
      }
      const previousPids = state.quotas.get(node.id)?.pids;
      const pidUsage = node.metrics?.pidUsage ?? 0;
      if (previousPids > 0 && pidUsage / previousPids >= config.pidCeiling) {
        diagnostics.push(
          diagnostic(
            DiagnosticCode.PID_CEILING,
            node.id,
            `node "${node.id}" PID usage ${pidUsage} reached ceiling of quota ${previousPids}`,
            { pidUsage, previousQuota: previousPids, ceiling: config.pidCeiling },
          ),
        );
      }
    }

    const nextQuotas = new Map();

    function allocateChildren(parent, allocatable) {
      const children = childrenOf.get(parent.id) ?? [];
      if (children.length === 0) return;

      for (const resource of RESOURCES) {
        const available = Math.max(0, allocatable[resource]);
        const items = children.map((child) => ({
          node: child,
          demand: demandFor(child, resource),
          floor: floorFor(child, resource),
          weight: weightFor(child, resource),
        }));
        const totalDemand = items.reduce((sum, item) => sum + item.demand, 0);

        if (totalDemand > available + EPSILON) {
          diagnostics.push(
            diagnostic(
              DiagnosticCode.PARENT_BUDGET_INSUFFICIENT,
              parent.id,
              `parent "${parent.id}" ${resource} budget ${available} cannot satisfy child demand ${totalDemand}`,
              { resource, available, demand: totalDemand, deficit: totalDemand - available },
            ),
          );
        }

        const criticalDemand = items
          .filter((item) => criticalityOf(item.node) === 'critical')
          .reduce((sum, item) => sum + item.demand, 0);
        if (criticalDemand > 0 && totalDemand > available + EPSILON) {
          const preempted = items
            .filter((item) => criticalityOf(item.node) !== 'critical' && item.demand > EPSILON)
            .map((item) => item.node.id);
          if (preempted.length > 0) {
            diagnostics.push(
              diagnostic(
                DiagnosticCode.CRITICAL_PREEMPTION,
                parent.id,
                `critical children of "${parent.id}" preempt ${resource} from: ${preempted.join(', ')}`,
                { resource, preempted, criticalDemand, available },
              ),
            );
          }
        }

        if (resource === 'memory') {
          const previousSum = children.reduce(
            (sum, child) => sum + (state.quotas.get(child.id)?.memory ?? 0),
            0,
          );
          if (available < previousSum - EPSILON) {
            const neededReclaim = previousSum - available;
            const reclaimable = items.reduce(
              (sum, item) =>
                sum +
                Math.max(
                  0,
                  (state.quotas.get(item.node.id)?.memory ?? 0) - Math.min(item.floor, item.demand),
                ),
              0,
            );
            if (reclaimable < neededReclaim - EPSILON) {
              diagnostics.push(
                diagnostic(
                  DiagnosticCode.MEMORY_RECLAIM_SHORTFALL,
                  parent.id,
                  `parent "${parent.id}" needs to reclaim ${neededReclaim} memory but only ${reclaimable} is reclaimable`,
                  { neededReclaim, reclaimable, deficit: neededReclaim - reclaimable },
                ),
              );
            }
          }
        }

        const grants = new Map();
        let remaining = available;
        for (const tier of TIERS) {
          const group = items.filter((item) => criticalityOf(item.node) === tier);
          if (group.length === 0) continue;
          const tierGrants = weightedFairShare(remaining, group);
          group.forEach((item, index) => grants.set(item.node.id, tierGrants[index]));
          remaining = Math.max(0, remaining - tierGrants.reduce((sum, grant) => sum + grant, 0));
        }

        for (const item of items) {
          const id = item.node.id;
          const previous = state.quotas.get(id)?.[resource];
          const target = grants.get(id) ?? 0;
          const hysteresis = config.hysteresis[resource];
          let quota = applyHysteresis(previous, target, hysteresis);
          quota = Math.max(quota, item.floor);
          if (!nextQuotas.has(id)) nextQuotas.set(id, zeroBudget());
          nextQuotas.get(id)[resource] = quota;
        }
      }

      for (const child of children) {
        allocateNode(child, nextQuotas.get(child.id) ?? zeroBudget());
      }
    }

    function allocateNode(node, budget) {
      if (!nextQuotas.has(node.id)) nextQuotas.set(node.id, { ...budget });
      const overhead = { ...zeroBudget(), ...node.overhead };
      const allocatable = {};
      for (const resource of RESOURCES) {
        allocatable[resource] = (budget[resource] ?? 0) - (overhead[resource] ?? 0);
        if (allocatable[resource] < -EPSILON) {
          diagnostics.push(
            diagnostic(
              DiagnosticCode.OVERHEAD_EXCEEDS_BUDGET,
              node.id,
              `node "${node.id}" ${resource} overhead ${overhead[resource]} exceeds its budget ${budget[resource]}`,
              { resource, overhead: overhead[resource], budget: budget[resource] },
            ),
          );
        }
        allocatable[resource] = Math.max(0, allocatable[resource]);
      }
      allocateChildren(node, allocatable);
    }

    allocateNode(roots[0], capacity);

    state.quotas = nextQuotas;
    state.version += 1;

    return {
      ok: true,
      version: state.version,
      quotas: Object.fromEntries(nextQuotas),
      diagnostics,
    };
  }

  function inspect() {
    return {
      version: state.version,
      quotas: Object.fromEntries(state.quotas),
      jitterScores: Object.fromEntries(state.jitter),
      tombstones: Object.fromEntries(state.tombstones),
    };
  }

  return { planCycle, inspect, config };
}
