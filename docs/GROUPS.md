# 群聊（G1 后端：契约冻结 v1.0 实现说明）

> 契约来源：issue 里 KG 冻结的 **G1 API 契约 v1.0**（`web-ui/src/api/types.ts` 群聊段与之同形）。
> 实现：`packages/agent/src/agent-group-store.ts`、`packages/server/src/agent-group-service.ts`、
> `packages/server/src/routes/groups.ts`、`packages/tools/src/builtin/group-tools.ts`。

## 1. 模型：对话聚合 vs 生命周期聚合

| 表 | 角色 | 关键字段 |
|---|---|---|
| `agent_groups` | 群（对话聚合根） | `id(grp_…)` / `name` / `description` / `status(open|concluded)` / `members_json` / `coordinator` / `max_rounds` / `idle_timeout_ms` |
| `group_messages` | 群聊日志（append-only） | `id(msg_…)` / `seq`（群内单调，1 起） / `from_kind` / `from_name` / `content` / `kind` / `agent_task_id` |

- 任务不进群表：群内派发复用 `agent_tasks`（G2 加 `groupId` 语义），群消息只用
  `agentTaskId` 反指任务 —— 7 态状态机不受影响。
- `members_json` 存成员（runtime + 协调者），**对外 `members` = runtime 名列表**（人隐含在场，
  不占位；协调者 `fengagent` 会出现在列表里）。
- `kind`：`chat`（G1 默认）/ `task_card`（G2）/ `decision`（G3）/ `system`（建群等系统提示）。

## 2. HTTP API（与契约逐条对齐）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/groups` | `status` / `limit`（可选） | `{groups: GroupInfo[], runtimes: RuntimeInfo[]}` |
| POST | `/api/groups` | `{name, description?, members: string[], maxRounds?}` | 201 `GroupInfo`；成员未注册/未启用 → **400** |
| GET | `/api/groups/:id` | — | `{group, messages}`（**全量**消息，G1 不分页） |
| POST | `/api/groups/:id/messages` | `{content, kind?: "chat"}` | 201 `GroupMessage`（`fromKind=human`、`fromName=human`）；已 `concluded` → **409** |
| POST | `/api/groups/:id/agent-messages` | `{content, fromName, kind?}` | 201 `GroupMessage`（协调者 → `coordinator`，成员 runtime → `runtime`）；非成员 → **403**；已关群 → 409 |
| POST | `/api/groups/:id/conclude` | — | `GroupInfo`（`status=concluded`，**幂等**：重复调用返回原样） |
| PATCH | `/api/groups/:id` | `{name?, description?, members?, maxRounds?}` | `GroupInfo`（契约外的便利接口，改名/改成员用） |
| GET | `/api/groups/:id/messages` | `after` / `limit`（可选） | `{messages, nextSeq}`（增量读取；SSE 重连同款语义） |
| GET | `/api/groups/:id/stream` | `after`（可选，默认 0） | 群 SSE（见 §3） |

**错误体**统一 `{ error: { message, code } }`，`code ∈ bad_request | forbidden | not_found | conflict`，
HTTP 状态 400 / 403 / 404 / 409。

**DTO**：

```ts
GroupInfo   { id, name, description, members: string[], status: "open"|"concluded",
              maxRounds, createdAt, updatedAt, lastMessageAt? }
GroupMessage{ id, groupId, seq, fromKind: "human"|"runtime"|"coordinator"|"system",
              fromName, content, kind: "chat"|"task_card"|"decision"|"system",
              agentTaskId?, createdAt }
```

建群时会自动落一条 `system` 消息「群已创建」（`fromName="system"`）。

## 3. 群 SSE

```
GET /api/groups/:id/stream?after=<seq>       # 也接受 Last-Event-ID
```

- 首帧 **`snapshot`**：`{type:"snapshot", group, messages:[after 之后的消息], lastSeq}`（一次给全）；
- 实时：`{type:"message", message}`（SSE `id: <seq>`，可 Last-Event-ID 去重）、
  `{type:"group", group}`（conclude 等属性变更）；
- 心跳：`{type:"heartbeat"}` 数据帧，15s 一条；
- 群删除时结束流（G1 无删除接口，预留）。

## 4. 谁能发言（v1 协调者中转）

| 来源 | 写入路径 | `from_kind` / `from_name` |
|---|---|---|
| 人 | `POST /:id/messages` | `human` / `human` |
| 协调者（群内 fengagent） | 群工具 `group_send` → `POST /:id/agent-messages` | `coordinator` / `fengagent` |
| 成员 runtime（G2 起） | `POST /:id/agent-messages`（服务端装配调用） | `runtime` / 成员 runtime 名 |
| 外部 runtime 的产出 | **服务端代写**：`postRuntimeMessage()`（G2 结果回群主路径，不开放 REST） | `runtime` / runtime 名 |
| 系统 | `postSystemMessage()` | `system` / `system` |

外部 runtime **没有**群工具（要注入 MCP，G4/v2）；它们的产出统一由服务端写进群并带
`agentTaskId` 深链 —— 不依赖成员自觉，也不会「某个 runtime 忘了发消息」。

## 5. 群工具（只注入本仓库 fengagent 侧，契约三个）

| 工具 | 入参 | 作用 |
|---|---|---|
| `group_create` | `{name, description?, members?: string[]}` | 建群（协调者 = `FENG_GROUP_SELF_NAME`，默认 `fengagent`） |
| `group_send` | `{groupId, content}` | 以协调者身份发言 → `coordinator` |
| `group_history` | `{groupId, limit?}` | 读最近 N 条（旧→新，`#seq [from] content`） |

工具由 server 装配注入（`createRuntimeAgent` → `createGroupTools(handler)`），tools 包不
反向依赖 server。`group_conclude` / `group_dispatch` 属于 G3 / G2，本轮不放。

## 6. G2（已实现）：群内派发 + 结果回群

- **任务带群**：`POST /api/agent-tasks` 与 `dispatch_task` 都接受 `groupId`；任务记录新增
  `group_id`（老库自动 `ALTER TABLE` 补列 + 索引），任务 DTO 回显 `groupId`；
  `GET /api/agent-tasks?groupId=` 只列该群任务。
- **结果回群（服务端代写）**：任务终态时 `AgentTaskService` 通过下沉口 `groupSink`
  调 `postRuntimeMessage(groupId, {runtime, content, agentTaskId, kind:"task_card"})`：
  - `replied` → 「任务 xxx（runtime）已完成：<结果>」（超 2000 字截断）；
  - `failed` → 「任务 xxx（runtime）失败：<错误>」（超 1500 字截断）；
  - `cancelled` → 「任务 xxx（runtime）已取消」。
  消息 `fromKind="runtime"`、`fromName=<runtime>`、`kind="task_card"`、带 `agentTaskId`，
  前端卡片据此跳 `/agents?task=<id>`。群侧写失败只 warn，不影响任务已收尾的事实。
- **不带 `groupId` 的任务不回群**（回归用例覆盖）。

## 7. G3 衔接点（已预留）

- `maxRounds` / `idleTimeoutMs` 已落库；`concludeGroup()` 已实现幂等 `open → concluded`；
- `group_conclude` 工具、静默超时自动收口、`decision` 消息（人类拍板）在其上加一层即可。

## 8. 自测覆盖

- `packages/agent/src/__tests__/agent-group-store.test.ts`（7）：建群/默认值/成员去重、
  列表与状态过滤、seq 单调、`after` 增量、尾部最近消息、关群禁言、未知群拒写。
- `packages/server/src/__tests__/groups-api.test.ts`（9）：`grp_`/`msg_` 前缀与建群 system 消息、
  `{groups, runtimes}`、未注册成员 400、人发言（`fromName=human`）与全量详情、`after` 增量、
  `agent-messages`（协调者/成员/非成员 403）、`conclude` 幂等 + 关群 409 + 历史可读、
  SSE `snapshot`（含 `lastSeq`）与 `message`、错误体 `{error:{message,code}}`、
  三个群工具走通、外部 runtime 代写（`runtime` + 深链）。
- `packages/server/src/__tests__/group-dispatch.test.ts`（6，G2）：replied/failed 都落
  `task_card`（fromKind=runtime + agentTaskId + 内容/错误）、不带 groupId 不回群、
  API 带 groupId 与群维度列表过滤、`dispatch_task` 透传 groupId、store 层 `group_id` 落库。
