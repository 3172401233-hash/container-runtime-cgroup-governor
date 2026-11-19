# container-runtime-cgroup-governor

容器运行时 cgroup 资源治理器（JavaScript，Node.js ≥ 24.16.0）。

> **纯策略模拟**：本库只消费监控指标并计算下一周期的 CPU / 内存 / PID 配额，
> **不执行任何容器操作，不读写 cgroup 文件系统，不修改宿主机内核**。
> 输出仅为配额建议与诊断信息，由外部执行器自行落地。

## 能力

- 输入父子 cgroup 树：请求量、关键级别（`critical` / `standard` / `batch`）、
  近期超限、内存压力、OOM 次数、PID 使用率。
- 父节点先扣除自身 `overhead`，再向子节点做加权 max-min 公平分配；
  关键级别高的子节点优先满足，不足时抢占低级别节点。
- 短期抖动通过 EWMA 衰减的 jitter 分数处理：只临时降权，平静若干周期后自动恢复，
  不会永久降权。
- 扩容与回收使用不同的滞回门槛（`hysteresis.scaleUp` vs `hysteresis.reclaim`），
  需求在门槛之间波动时保持上一周期配额，避免抖动。
- 子节点删除后被打上 tombstone，其预算立即释放且只释放一次，
  不会重复分给兄弟节点；引用已删除父节点的节点会被拒绝并诊断。
- 诊断信息：`PARENT_BUDGET_INSUFFICIENT`（父预算不足）、`CRITICAL_PREEMPTION`
  （关键节点抢占）、`MEMORY_RECLAIM_SHORTFALL`（内存回收量不足）、
  `VERSION_CONFLICT`（并发状态更新，`expectedVersion` 乐观锁）、
  以及 `OOM_RISK`、`PID_CEILING`、`OVERHEAD_EXCEEDS_BUDGET`、`STALE_NODE`、
  `INVALID_TREE`。

## 用法

```js
import { createGovernor } from './index.js';

const governor = createGovernor({
  capacity: { cpu: 32, memory: 64 * 1024 ** 3, pids: 4096 },
});

const result = governor.planCycle({
  expectedVersion: 0, // 乐观并发控制，可选
  nodes: [
    { id: 'root', parentId: null, overhead: { cpu: 2, memory: 0, pids: 128 } },
    {
      id: 'web', parentId: 'root', criticality: 'critical',
      request: { cpu: 8, memory: 4 * 1024 ** 3, pids: 256 },
      metrics: { cpuUsage: 7.5, memoryUsage: 3.5 * 1024 ** 3, memoryPressure: 0.4,
                 oomCount: 0, pidUsage: 200, overruns: { cpu: 0.1 } },
    },
  ],
});
// result = { ok, version, quotas: { id: { cpu, memory, pids } }, diagnostics: [...] }
```

## 测试

```sh
node --test
```

覆盖层级分配、OOM 逼近、连续抖动恢复、PID 触顶、父子冲突、
节点删除预算释放、滞回门槛与并发版本冲突。
