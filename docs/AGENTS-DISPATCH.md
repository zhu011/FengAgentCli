# Agents 外派能力（P1 + P2 后端契约）

> 面向：P3 前端（已按本文契约实现）、验收方、后续接手的人。
> 代码：`packages/agent/src/acp-client.ts`、`packages/agent/src/agent-task-store.ts`、
> `packages/server/src/agent-runtimes.ts`、`packages/server/src/agent-task-service.ts`、
> `packages/server/src/routes/agent-tasks.ts`、`packages/tools/src/builtin/dispatch-task.ts`。

## 1. 能力边界

- **能做什么**：把一条任务派给本机另一个 ACP agent（`kimi` / `dsh` / `fengagent` …），拿回最终
  回复；界面能看到 runtime 卡片、任务 7 态、事件时间线与流式输出。
- **不做什么**（本阶段刻意不做）：跨机调度、常驻进程池、自动重试、拓扑图、Schedules。
- 目标 agent 的凭据由它自己管；本仓库只负责拉起进程 + 说 ACP。

## 2. 任务状态机（7 态，与 `web-ui/src/api/types.ts` 同枚举）

| 状态 | 进入条件 | 允许去向 |
|---|---|---|
| `created` | 建任务成功（幂等键可复用既有任务） | dispatched / cancelled / expired / failed |
| `dispatched` | 已 spawn 目标进程并落 `task/dispatched` | running / replied / failed / cancelled / expired |
| `running` | 已 `session/new` 成功（`accepted` 事件之后） | replied / failed / cancelled |
| `replied` | prompt 正常结束，结果已落库 | 终态 |
| `failed` | 目标报错 / 超时 / 未注册 / 台账未决 | 终态（可 retry） |
| `cancelled` | 用户取消（`session/cancel` + 关客户端） | 终态（可 retry） |
| `expired` | 服务重启时该任务还没派发出去 | 终态（可 retry） |

`dispatched → replied` 是允许的：目标可能一句话不说就结束（无增量输出）。

**事件枚举**（`agent_task_events.type`，与前端 `AgentTaskEvent["type"]` 一致）：
`task/created`、`task/dispatched`、`task/accepted`、`task/running`、`task/stream-chunk`、
`task/replied`、`task/failed`、`task/cancelled`、`task/expired`、`task/retried`。

`seq` 每个任务内单调递增（1 起），事件流可重放出当前状态
（`AgentTaskStore.replayStatus()` / `replayAgentTaskStatus()`）。

## 3. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/runtimes` | `RuntimeInfo[]`。`?probe=1` 先真探测再返回 |
| POST | `/api/runtimes/probe` | 探测全部启用的 runtime（每个 spawn 一次 `initialize`） |
| POST | `/api/runtimes/:name/enabled` | `{enabled: boolean}` 启停（只影响新任务） |
| GET | `/api/agent-tasks` | `{tasks, nextCursor?, runtimes}`；`status`（可逗号分隔）/`runtime`/`limit`/`cursor` |
| POST | `/api/agent-tasks` | `{runtime, content, fromSession?, cwd?, idempotencyKey?}` → 201 task |
| GET | `/api/agent-tasks/:id` | `{task, events}`；不存在 404 |
| POST | `/api/agent-tasks/:id/cancel` | 非终态 → cancelled；终态 409 |
| POST | `/api/agent-tasks/:id/retry` | 终态 → 新 attempt（同 taskId）；非终态 409 |
| GET | `/api/agent-tasks/:id/stream` | SSE（见 §4） |

**任务字段**（`AgentTask`）：`id, fromSession, runtime, status, content, result?, error?,
createdAt, dispatchedAt?, startedAt?, finishedAt?, durationMs?, acpSessionId?`（时间是 ISO 字符串）。

**语义约定**：

- **幂等键**：`idempotencyKey` 在存储层建唯一索引；重复 POST 返回**同一任务**（200/201 都返回该任务，
  不会再派一次）。这是「用户手抖点两下」的闸。
- **retry 语义**：同 `taskId` 的**新 attempt**（`attempt+1`），事件流里有一条 `task/retried`
  （detail 记录上一状态）。不自动重试 —— 每次重试都必须显式发生。
- **目标会话复用（`session/resume`）**：任务第一次派发走 `session/new`，`acpSessionId` 记在任务上；
  retry 时若握手声明了 resume 能力，就带**全参** `{sessionId, cwd, mcpServers}` 续聊**同一个目标会话**
  （`cwd` 不能省：kimi / 原版 dsh 会强制校验）。resume 失败（目标不支持 / 会话已被回收）自动回退
  `session/new`，原因写进 `task/accepted` 的 detail，派发不因此失败。
- **expired**：只在服务重启时把「还没派发出去的 created 任务」转入，没有定时 TTL。
- **headless 权限**：目标 agent 发 `session/request_permission` 时，策略默认 **deny**，决策写进
  事件流（`task/stream-chunk` + `[permission] <tool> → allow|deny`）。冻结的事件枚举没有独立类型，
  这里复用 `detail` 承载，UI 时间线可见，绝不静默挂起。

## 4. SSE（`GET /api/agent-tasks/:id/stream`）

帧类型（`AgentTaskStreamEvent`）：

```jsonc
{"type":"status","task":{...}}            // 快照 / 状态变更
{"type":"chunk","text":"增量文本"}          // 流式输出（不落库）
{"type":"event","event":{"seq":7,...}}     // 持久事件（带 id: <seq>）
```

连接顺序：**快照 → `?after=<seq>` 之后的历史事件 → 实时帧**；终态帧发出后服务端主动结束。
重连用 `?after=<seq>`（或 `Last-Event-ID`）只补发缺的事件，不重复渲染。
心跳每 15s 一条注释帧（`: heartbeat`）。

## 5. 不重复执行（副作用台账）

每次派发是一个副作用操作：`operationKey = agent-task:<taskId>:attempt-<n>`，
写 AGE-29 的 `operation_ledger`（`OperationLedger`，与 Agent Loop 共用同一套）：

| 台账状态 | 派发行为 |
|---|---|
| 无记录 | 正常执行（begin → complete/fail） |
| `succeeded` | **不重跑**，直接把 `result_json.text` 回放成结果（补一条 `task/dispatched` 再 `replied`） |
| `pending` / `unknown` | **拒绝重跑**，任务落 `failed`：`副作用未决…需人工核对后再 retry` |
| `failed` | 允许重新执行（begin 会把 failed 重置为 pending） |

## 6. 崩溃恢复语义

服务启动时 `recoverInterrupted()`：

- `created`（从未派发）→ `expired`；
- `dispatched` / `running` → `failed`（detail：服务重启中断，未自动重跑，可 retry）。

不自动重跑是刻意的：远端可能已经执行过，自动重跑会破坏「副作用次数 ≤ attempt 数」。
重启后 UI 看到的状态与事件流都由 SQLite 重放而来，`seq` 连续。

## 7. 运行时注册表（`<数据根>/runtimes.json`）

```json
{
  "runtimes": [
    { "name": "fengagent", "command": "fengagent", "args": ["acp"], "enabled": true },
    { "name": "dsh", "command": "dsh-acp", "args": ["acp"], "enabled": true },
    { "name": "kimi", "command": "kimi", "args": ["acp"], "enabled": true }
  ],
  "probes": { "kimi": { "status": "ok", "agentName": "Kimi Code CLI", "agentVersion": "0.34.0", "probedAt": "…" } }
}
```

- 缺文件时自动写默认三件套；`probes` 是探测结果缓存（启动时后台探一次，也可 `POST /api/runtimes/probe` 手动刷新）。
- 探测 = spawn 目标 + `initialize` + 立刻回收（超时 20s，dsh 冷启实测 ~13s）。
- 加一个 runtime 只改这个 json，不改代码。

## 8. `dispatch_task` 工具

会话里的 LLM 可以直接调用：

```jsonc
{ "agent": "kimi", "task": "自包含的任务文本", "cwd": "可选" }
```

- 走 `AgentTaskService.dispatchAndWait()`：建任务 → 派发 → **等终态** → 把回复文本作为工具结果返回；
  因此「结果回流到当前会话」不需要额外机制。
- `fromSession` 自动填当前会话 id（Agents 页的 From 列因此能显示来源）。
- 工具声明 `sideEffect: non-idempotent`：它自己也进副作用台账（崩溃后未决的派发不会被静默重放）。
- 仅在 server 装配（`createRuntimeAgent`）里注册 —— `enableSessionStore=false` 或服务初始化失败时不可用。

## 9. 与方案的两处有意偏离（已在代码注释里写明）

1. **没有把 7 态塞进 `TaskStore.task_states`**：那张表的状态机服务于 Agent Loop（步级 checkpoint /
   待结算工具），枚举是 active/blocked/completed/aborted。硬塞会污染已验收的 loop reducer。
   改用同构的事件溯源表 `agent_tasks` + `agent_task_events`（seq 单调 + 可重放），
   并复用 `operation_ledger` 做防重复执行 —— 机制相同，语义不混。
2. **权限决策复用 `task/stream-chunk` 事件承载**（`[permission]` 前缀）：冻结的事件枚举里没有
   独立类型，为了不破坏 P3 的类型契约，用 `detail` 表达，UI 时间线可见。

## 10. 自测覆盖（`bun test`）

- `packages/agent/src/__tests__/acp-client.test.ts`：真 spawn `fixtures/fake-acp-agent.ts`，
  握手/建会话/`session/resume`（全参）/增量/权限决策/协议错误/取消/回收。
- `packages/agent/src/__tests__/agent-task-store.test.ts`：幂等键、7 态转移（含非法转移）、
  事件重放对拍、retry、分页、24h 统计。
- `packages/server/src/__tests__/agent-tasks-api.test.ts`：派发闭环、失败、取消、retry（含
  「retry 复用同一目标会话」）、
  台账回放/未决拦截、启动恢复、以及 §3 全部路由（含 SSE 快照与事件回放）。
