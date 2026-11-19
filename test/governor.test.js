import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGovernor, DiagnosticCode } from '../index.js';

const GiB = 1024 ** 3;

function codes(result) {
  return result.diagnostics.map((d) => d.code);
}

function leaf(id, parentId, overrides = {}) {
  return {
    id,
    parentId,
    criticality: 'standard',
    overhead: { cpu: 0, memory: 0, pids: 0 },
    request: { cpu: 0, memory: 0, pids: 0 },
    metrics: {},
    ...overrides,
  };
}

test('hierarchical allocation: parent overhead deducted before children, critical wins', () => {
  const governor = createGovernor({ capacity: { cpu: 32, memory: 64 * GiB, pids: 4096 } });
  const result = governor.planCycle({
    nodes: [
      leaf('root', null, { overhead: { cpu: 2, memory: 2 * GiB, pids: 128 } }),
      leaf('parentA', 'root', {
        overhead: { cpu: 1, memory: 0, pids: 0 },
        request: { cpu: 10, memory: 8 * GiB, pids: 512 },
      }),
      leaf('parentB', 'root', { request: { cpu: 20, memory: 8 * GiB, pids: 512 } }),
      leaf('crit', 'parentA', { criticality: 'critical', request: { cpu: 8, memory: 0, pids: 0 } }),
      leaf('batch', 'parentA', { criticality: 'batch', request: { cpu: 8, memory: 0, pids: 0 } }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.quotas.root.cpu, 32);
  // Root overhead (2 cpu) deducted before granting to parents.
  assert.equal(result.quotas.parentA.cpu, 10);
  assert.equal(result.quotas.parentB.cpu, 20);
  // parentA keeps 1 cpu overhead, leaving 9 for 16 cpu of demand.
  assert.ok(codes(result).includes(DiagnosticCode.PARENT_BUDGET_INSUFFICIENT));
  assert.ok(codes(result).includes(DiagnosticCode.CRITICAL_PREEMPTION));
  const { crit, batch } = result.quotas;
  assert.ok(crit.cpu > batch.cpu, `critical ${crit.cpu} should beat batch ${batch.cpu}`);
  assert.ok(crit.cpu + batch.cpu <= 9 + 1e-9, 'children never exceed parent allocatable');
});

test('OOM approach: memory floor protected and OOM_RISK diagnosed', () => {
  const governor = createGovernor({ capacity: { cpu: 16, memory: 64 * GiB, pids: 4096 } });
  const result = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('hot', 'root', {
        request: { cpu: 1, memory: 6 * GiB, pids: 64 },
        metrics: { memoryUsage: 8 * GiB, memoryPressure: 0.95, oomCount: 3 },
      }),
    ],
  });

  assert.ok(codes(result).includes(DiagnosticCode.OOM_RISK));
  // Demand lifted to usage * oomMemoryHeadroom (1.2), well above the 6 GiB request.
  assert.ok(result.quotas.hot.memory >= 8 * GiB * 1.2 - 1e-6);

  // Next cycle the request collapses but the in-use memory floor still holds.
  const next = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('hot', 'root', {
        request: { cpu: 1, memory: 1 * GiB, pids: 64 },
        metrics: { memoryUsage: 8 * GiB, memoryPressure: 0.9, oomCount: 3 },
      }),
    ],
  });
  assert.ok(next.quotas.hot.memory >= 8 * GiB * 1.1 - 1e-6);
});

test('memory reclaim shortfall reported when floors exceed shrunken budget', () => {
  const governor = createGovernor({ capacity: { cpu: 16, memory: 64 * GiB, pids: 4096 } });
  const cycle1 = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('a', 'root', { request: { cpu: 1, memory: 30 * GiB, pids: 64 } }),
      leaf('b', 'root', { request: { cpu: 1, memory: 30 * GiB, pids: 64 } }),
    ],
  });
  assert.equal(cycle1.quotas.a.memory, 30 * GiB);

  const cycle2 = governor.planCycle({
    capacity: { cpu: 16, memory: 20 * GiB, pids: 4096 },
    nodes: [
      leaf('root', null),
      leaf('a', 'root', {
        request: { cpu: 1, memory: 30 * GiB, pids: 64 },
        metrics: { memoryUsage: 14 * GiB },
      }),
      leaf('b', 'root', {
        request: { cpu: 1, memory: 30 * GiB, pids: 64 },
        metrics: { memoryUsage: 14 * GiB },
      }),
    ],
  });
  // Floors (28 GiB of usage) alone exceed the 20 GiB budget.
  assert.ok(codes(cycle2).includes(DiagnosticCode.MEMORY_RECLAIM_SHORTFALL));
  const shortfall = cycle2.diagnostics.find(
    (d) => d.code === DiagnosticCode.MEMORY_RECLAIM_SHORTFALL,
  );
  assert.ok(shortfall.details.deficit > 0);
});

test('continuous jitter: temporary demotion recovers, never permanent', () => {
  const governor = createGovernor({
    capacity: { cpu: 16, memory: 64 * GiB, pids: 4096 },
    jitter: { decay: 0.6, maxPenalty: 0.5 },
  });
  const nodes = (overruns) => [
    leaf('root', null),
    leaf('spiky', 'root', {
      request: { cpu: 4, memory: 0, pids: 0 },
      metrics: { overruns: { cpu: overruns } },
    }),
  ];

  // Alternating bursts of overruns for several cycles.
  for (let cycle = 0; cycle < 6; cycle += 1) {
    governor.planCycle({ nodes: nodes(cycle % 2 === 0 ? 1 : 0) });
  }
  const midScore = governor.inspect().jitterScores.spiky.cpu;
  assert.ok(midScore > 0, 'overruns should demote the node temporarily');
  assert.ok(midScore < 1, 'jitter score stays bounded');

  // Calm cycles: the penalty must wash out, not stick.
  for (let cycle = 0; cycle < 8; cycle += 1) {
    governor.planCycle({ nodes: nodes(0) });
  }
  const finalScore = governor.inspect().jitterScores.spiky.cpu;
  assert.ok(finalScore < 0.05, `score ${finalScore} should decay toward zero`);

  // Quota returns to full demand once the jitter penalty fades.
  const settled = governor.planCycle({ nodes: nodes(0) });
  assert.equal(settled.quotas.spiky.cpu, 4);
});

test('PID ceiling: usage at ceiling diagnosed and headroom granted', () => {
  const governor = createGovernor({ capacity: { cpu: 16, memory: 64 * GiB, pids: 4096 } });
  const cycle1 = governor.planCycle({
    nodes: [leaf('root', null), leaf('worker', 'root', { request: { cpu: 1, memory: 0, pids: 100 } })],
  });
  assert.equal(cycle1.quotas.worker.pids, 100);

  const cycle2 = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('worker', 'root', {
        request: { cpu: 1, memory: 0, pids: 100 },
        metrics: { pidUsage: 95 },
      }),
    ],
  });
  assert.ok(codes(cycle2).includes(DiagnosticCode.PID_CEILING));
  // Demand raised to usage / pidHeadroom (0.7) to buy headroom.
  assert.ok(cycle2.quotas.worker.pids >= 95 / 0.7 - 1e-6);
});

test('parent-child conflict: insufficient budget plus critical preemption diagnostics', () => {
  const governor = createGovernor({ capacity: { cpu: 8, memory: 64 * GiB, pids: 4096 } });
  const result = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('parent', 'root', { overhead: { cpu: 1, memory: 0, pids: 0 }, request: { cpu: 8, memory: 0, pids: 0 } }),
      leaf('crit', 'parent', { criticality: 'critical', request: { cpu: 6, memory: 0, pids: 0 } }),
      leaf('batch', 'parent', { criticality: 'batch', request: { cpu: 6, memory: 0, pids: 0 } }),
    ],
  });

  assert.ok(codes(result).includes(DiagnosticCode.PARENT_BUDGET_INSUFFICIENT));
  const preemption = result.diagnostics.find((d) => d.code === DiagnosticCode.CRITICAL_PREEMPTION);
  assert.ok(preemption, 'expected critical preemption diagnostic');
  assert.deepEqual(preemption.details.preempted, ['batch']);
  // 7 cpu allocatable after overhead; critical takes its full 6, batch gets the scraps.
  assert.equal(result.quotas.crit.cpu, 6);
  assert.ok(result.quotas.batch.cpu <= 1 + 1e-9);
});

test('removed child budget freed exactly once, never double-distributed', () => {
  const governor = createGovernor({ capacity: { cpu: 12, memory: 64 * GiB, pids: 4096 } });
  const cycle1 = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('a', 'root', { request: { cpu: 4, memory: 0, pids: 0 } }),
      leaf('b', 'root', { request: { cpu: 4, memory: 0, pids: 0 } }),
      leaf('c', 'root', { request: { cpu: 4, memory: 0, pids: 0 } }),
    ],
  });
  assert.equal(cycle1.quotas.c.cpu, 4);

  const cycle2 = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('a', 'root', { request: { cpu: 8, memory: 0, pids: 0 } }),
      leaf('b', 'root', { request: { cpu: 8, memory: 0, pids: 0 } }),
    ],
  });
  assert.equal(cycle2.quotas.c, undefined, 'removed node must not appear in quotas');
  // The full 12 cpu is available to the survivors: freed budget counted once.
  assert.equal(cycle2.quotas.a.cpu + cycle2.quotas.b.cpu, 12);
  assert.equal(cycle2.quotas.a.cpu, 6);
  assert.equal(cycle2.quotas.b.cpu, 6);
  assert.deepEqual(Object.keys(governor.inspect().tombstones), ['c']);
});

test('stale node referencing a removed parent is rejected with diagnostic', () => {
  const governor = createGovernor({ capacity: { cpu: 12, memory: 64 * GiB, pids: 4096 } });
  const result = governor.planCycle({
    nodes: [
      leaf('root', null),
      leaf('orphan', 'ghost-parent', { request: { cpu: 1, memory: 0, pids: 0 } }),
    ],
  });
  assert.ok(codes(result).includes(DiagnosticCode.STALE_NODE));
  assert.equal(result.quotas.orphan, undefined);
});

test('concurrent state update: stale expectedVersion rejected', () => {
  const governor = createGovernor({ capacity: { cpu: 4, memory: 8 * GiB, pids: 1024 } });
  const first = governor.planCycle({ expectedVersion: 0, nodes: [leaf('root', null)] });
  assert.equal(first.ok, true);
  assert.equal(first.version, 1);

  const conflict = governor.planCycle({ expectedVersion: 0, nodes: [leaf('root', null)] });
  assert.equal(conflict.ok, false);
  assert.ok(codes(conflict).includes(DiagnosticCode.VERSION_CONFLICT));
  assert.equal(conflict.version, 1, 'failed cycle must not advance the version');

  const retry = governor.planCycle({ expectedVersion: 1, nodes: [leaf('root', null)] });
  assert.equal(retry.ok, true);
  assert.equal(retry.version, 2);
});

test('hysteresis: small demand changes hold the previous quota', () => {
  const governor = createGovernor({
    capacity: { cpu: 64, memory: 64 * GiB, pids: 4096 },
    hysteresis: { cpu: { scaleUp: 0.1, reclaim: 0.25 } },
  });
  const make = (request) => [
    leaf('root', null),
    leaf('svc', 'root', { request: { cpu: request, memory: 0, pids: 0 } }),
  ];
  const cycle1 = governor.planCycle({ nodes: make(10) });
  assert.equal(cycle1.quotas.svc.cpu, 10);

  // +5% is below the 10% scale-up threshold: quota holds.
  const cycle2 = governor.planCycle({ nodes: make(10.5) });
  assert.equal(cycle2.quotas.svc.cpu, 10);

  // +20% crosses the scale-up threshold: quota expands.
  const cycle3 = governor.planCycle({ nodes: make(12) });
  assert.equal(cycle3.quotas.svc.cpu, 12);

  // -10% is inside the 25% reclaim band: quota holds.
  const cycle4 = governor.planCycle({ nodes: make(10.8) });
  assert.equal(cycle4.quotas.svc.cpu, 12);

  // -50% crosses the reclaim threshold: quota is reclaimed.
  const cycle5 = governor.planCycle({ nodes: make(6) });
  assert.equal(cycle5.quotas.svc.cpu, 6);
});
