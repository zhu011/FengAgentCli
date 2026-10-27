# 群聊（G1 后端契约与语义）

> 面向：群聊页前端（`pages/groups.tsx`）、后续 G2/G3、验收方。
> 冻结契约：`packages/web-ui/src/api/types.ts` §「群聊（G1 契约 v1.0）」。
> 代码：`packages/agent/src/agent-group-store.ts`、`packages/server/src/agent-group-service.ts`、
> `packages/server/src/routes/groups.ts`、`packages/tools/src/builtin/group-tools.ts`。

## 1. 模型：对话聚合 vs 生命周期聚合

| 表 | 角色 | 关键字段 |
|---|---|---|
| `agent_groups` | 群（对话聚合根） | `name` / `description` / `status(open|concluded)` / `members_json` / `coordinator` / `max_rounds` / `idle_timeout_ms` |
| `group_messages` | 群聊日志（append-only） | `seq`（群内单调）/ `from_kind` / `from_name` / `content` / `kind` / `agent_task_id` |

- **任务不进群表**：群内派发复用 `agent_tasks`（G2 给任务加 `groupId` 语义），群只在消息里
  用 `agentTaskId` 反指任务 —— 7 态状态机不受影响。
- `members_json` 里保留 `kind`（human/runtime/coordinator），**对外只暴露 runtime 名**
  （契约 `members: string[]`，人隐含在场）；协调者不占成员位。
- `kind`：`chat`（G1 默认）/ `task_card`（G2）/ `decision`（G3）/ `system`（系统提示）。

## 2. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/groups` | `{groups: GroupInfo[], runtimes: RuntimeInfo[]}`；`status`（逗号分隔）/`limit`；`runtimes` 给成员选择器 |
| POST | `/api/groups` | `{name, description?, members: string[], maxRounds?}` → 201 `GroupInfo` |
| GET | `/api/groups/:id` | `{group, messages}`（最近 50 条，seq 升序） |
| PATCH | `/api/groups/:id` | `{name?, description?, members?, maxRounds?, status?}`；`status:"concluded"` 即关群 |
| GET | `/api/groups/:id/messages` | `{messages, nextSeq}`；`after` / `limit`（`after` 语义同 SSE 重连） |
| POST | `/api/groups/:id/messages` | `{content, kind?: "chat"}` → 201 `GroupMessage`；关群后 **409** |
| GET | `/api/groups/:id/stream` | 群 SSE（见 §3） |

错误口径与 `/api/agent-tasks` 一致：不存在 404、参数不合法 400、状态不允许 409。

**DTO**（与契约逐字段一致）：

```ts
GroupInfo   { id, name, description, members: string[], status: "open"|"concluded",
              maxRounds, createdAt, updatedAt, lastMessageAt?,
              messageCount, lastMessagePreview? }   // 后两个是附加字段（列表角标用）
GroupMessage{ id, groupId, seq, fromKind: "human"|"runtime"|"coordinator"|"system",
              fromName, content, kind: "chat"|"task_card"|"decision"|"system",
              agentTaskId?, createdAt }
```

## 3. 群 SSE

```
GET /api/groups/:id/stream?after=<seq>       # 也接受 Last-Event-ID
```

帧顺序：**`snapshot`（group + 最近 50 条 + lastSeq）→ `after` 之后的消息回放 → 实时
`message` / `group`**；心跳 15s 一条注释帧。客户端断线重连只需带上 `after=lastSeq`，
不会重复渲染。`message` 帧带 `id: <seq>`（SSE 原生 Last-Event-ID 可用）。

## 4. 谁能发言（v1 协调者中转）

| 来源 | 写入路径 | `from_kind` |
|---|---|---|
| 人（群聊页/接口） | `POST /api/groups/:id/messages` | `human` |
| 协调者（群内 fengagent） | 群工具 `group_send` | `coordinator` |
| 外部 runtime（kimi/dsh/claude） | **服务端代写**：`AgentGroupService.postRuntimeMessage()`（G2 结果回群主路径） | `runtime` |
| 系统 | `postSystemMessage()` | `system` |

外部 runtime **没有**群工具（要注入 MCP，G4/v2）。它们的产出统一由服务端写进群并带
`agentTaskId` 深链 —— 不依赖成员自觉，也不会出现「某个 runtime 忘了发消息」。

## 5. 群工具（只注入本仓库 fengagent 侧）

| 工具 | 入参 | 作用 |
|---|---|---|
| `group_create` | `{name, description?, members?: string[], coordinator?}` | 建群，返回 `groupId` |
| `group_send` | `{groupId, content}` | 以协调者身份发言（`from_kind=coordinator`） |
| `group_history` | `{groupId, limit?}` | 读最近 N 条（带 `#seq [from] content`） |
| `group_list` | `{status?: "open"|"concluded"}` | 列群（名称/状态/成员数/消息数） |

工具由 server 装配注入（`createRuntimeAgent` → `createGroupTools(handler)`），tools 包
不反向依赖 server；`FENG_GROUP_SELF_NAME` 可改协调者署名（默认 `fengagent`）。

`group_conclude` / `group_dispatch` 属于 G3（编排收敛）与 G2（群内派发），本轮不放。

## 6. 与 G2/G3 的衔接点（已预留）

- **G2 群内派发**：任务加 `groupId`；`AgentTaskService` 在 replied/failed 时调
  `postRuntimeMessage(groupId, {runtime, content, agentTaskId})`（方法已就绪）；
  消息 `kind="task_card"`，前端卡片点击跳 `/agents?task=<id>`。
- **G3 编排收敛**：`maxRounds` / `idleTimeoutMs` 字段已落库；`concludeGroup()` 已实现
  `open → concluded`，`group_conclude` 工具与「静默超时自动收口」在其上加一层循环即可；
  `decision` 类消息（人类拍板）与「关群后无残留任务」由该层保证。

## 7. 自测覆盖

- `packages/agent/src/__tests__/agent-group-store.test.ts`（7）：建群/默认值/成员去重、
  列表与状态过滤、seq 单调、`after` 增量、尾部最近消息、关群禁言、未知群拒写。
- `packages/server/src/__tests__/groups-api.test.ts`（7）：`{groups, runtimes}`、创建/详情、
  发言与 `after` 增量、关群 409 + 历史可读、SSE 首帧 `snapshot`（含 lastSeq）+ 回放、
  400/404 口径、四个群工具走通（协调者署名）、外部 runtime 代写（`runtime` + 深链）。
