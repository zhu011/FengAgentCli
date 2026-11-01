# fengagent-groups（DSH 薄插件桥）

一个 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件：把
FengAgentCli 的「agent 团队」群聊能力以工具形式注入 DSH agent，HTTP 连回 FengAgentCli
server。参照 `dsh-commhub` 的 Cordis 胶水插件形态——纯薄桥，不在 DSH 侧重建群模型。

## 工具面（5 个）

| 工具 | HTTP | 作用 |
|---|---|---|
| `fengagent_group_list` | `GET /api/groups` | 群列表 + 可用 runtime 成员卡片（建群前先查成员名） |
| `fengagent_group_create` | `POST /api/groups` | 建群（成员须为已注册 runtime，未知名 400） |
| `fengagent_group_send` | `POST /api/groups/:id/messages` | 以 human 操作者身份发言；`kind="decision"` 即拍板收口 |
| `fengagent_group_history` | `GET /api/groups/:id/messages` | 读群消息（`after`/`nextSeq` 增量轮询） |
| `fengagent_group_dispatch` | `POST /api/agent-tasks` | 给成员 runtime 派任务（带 `groupId`，结果以 task_card 自动回群） |

命名带 `fengagent_` 前缀，避免与 profile 里其他插件的 `group_*` 工具撞名。
除任务书点名的三个工具外，`list` 用于发现合法成员名（否则建群必 400）、
`dispatch` 是「派任务走通」的必要一环——human 消息只入群不派活，真正派活走
`dispatch_task({groupId})`（REST 即 `POST /api/agent-tasks`，见
`packages/tools/src/builtin/group-tools.ts` 的说明）。

## 语义边界（薄桥的「薄」在哪）

- DSH agent 扮演群的 **human 操作者**：发言走 human 入口（`fromName=human`），
  协调者（`fengagent`）与成员 runtime 对其消息作出反应；`agent-messages` 入口
  保留给注册成员/协调者（非成员 403），桥不冒用。
- 任务结果由 server 代写回群（`kind="task_card"`，带 `agentTaskId` 深链），
  桥只负责派发 + 读历史，不做 SSE 订阅、不做本地台账。
- 群的收敛策略（轮次上限 / 静默超时 / 拍板）全在 server 侧（G3），桥不复制。

## 安装

前置：本机已装 DSH CLI（peer 钉 `@deepseek-ai/dsh-tools@0.1.0-rc.6`，DSH 插件 API
在 rc 之间会变，升级时需重新核对 `defineTool` 契约），且 FengAgentCli server 在跑
（默认 `127.0.0.1:3000`）。

**必须走 tarball 安装，不能直接 add 本地目录**：`dsh plugin add <dir>` 会以 `link:`
挂载，node 按真实路径解析后，插件对 peer（`@deepseek-ai/dsh-tools`）的 import 会
落到仓库目录的 node_modules 链上而失败、整棵树加载报错；tarball 安装则由 pnpm 把
peer 装成 `.pnpm` 邻居，解析正常（已实测）。

```bash
cd integrations/fengagent-groups && npm pack
dsh plugin --profile <name> add /path/to/FengAgentCli/integrations/fengagent-groups/fengagent-groups-0.1.0.tgz
```

profile 需含 `@deepseek-ai/dsh-base`（提供 `tools` 服务）：

```json
{
  "name": "dsh-profile-<name>",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
```

`dsh --profile <name> --dump-config` 应看到 `fengagent-groups` 挂载节点；真正 boot
时 stdout 会出现 `[fengagent-groups] 5 tools registered → <serverUrl>`。

## 配置

环境变量优先级低于 patch 文件配置（见 `src/config.mjs`）：

| 键 | env | 默认 | 说明 |
|---|---|---|---|
| `serverUrl` | `FENG_SERVER_URL` | `http://127.0.0.1:3000` | FengAgentCli server 地址 |
| `timeoutMs` | `FENG_TIMEOUT_MS` | `30000` | 单请求超时（毫秒） |

## 典型流程

```
fengagent_group_list                      → 挑成员 runtime
fengagent_group_create(name, members)     → 拿 groupId
fengagent_group_dispatch(groupId, runtime, task)   → 派任务
fengagent_group_history(groupId, after=nextSeq)    → 轮询 task_card 结果
fengagent_group_send(groupId, "就按 A 方案", kind="decision")  → 拍板收口
```

## 测试

```bash
cd integrations/fengagent-groups && npm test   # node --test，进程内假 server，不需要装 DSH
```
