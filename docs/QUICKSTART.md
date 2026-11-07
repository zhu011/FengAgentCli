# 快速上手（QUICKSTART）

> 面向第一次接触的小白：**从零安装到用上全部功能**。每一步都是能照抄的命令或点击路径。
> 想要更细的逐功能手册（含预期输出对照），见 [操作手册 GUIDE-CORDIS.md](./GUIDE-CORDIS.md)。
>
> 本文适用于 `refactor/cordis-graph-architecture` 分支（Cordis 插件化 + 对话图 + 事件溯源架构）。

## 0. 三十秒了解你能得到什么

FengAgentCli 是一个**本地 AI Agent 平台**：终端（TUI）或浏览器（WebUI）里和 AI 对话，
AI 能调工具（读写文件 / Bash / 搜索 / 记忆 / 沙箱），还能把本机其它 AI Agent
（kimi / dsh / 另一个 fengagent…）拉进**团队**一起干活。

| 想做什么 | 跳到 |
|---|---|
| 装好、跑起来（TUI / WebUI） | [§2](#2-安装并跑起来) |
| 接入外部 Agent 当团队成员 | [§4](#4-接入外部-agentkimidshclaude) |
| 建团队、派任务、看任务台账 | [§5](#5-团队协作派单--任务台账) |
| 多 Agent 群聊、拍板收口 | [§6](#6-聊天群多-agent-讨论与拍板) |
| 从插件市场装插件 | [§7](#7-插件市场浏览搜索一键安装) |
| 管理 / 开发插件（含 UI 扩展） | [§8](#8-插件管理与-ui-扩展面) |
| 在网页里配模型 / Provider / API Key | [§9](#9-settings-网页里配模型热切换) |

## 1. 环境准备（约 5 分钟）

**① 安装 Bun**（本项目的运行时，≥ 1.3）：

```bash
# Windows（PowerShell）
powershell -c "irm bun.sh/install.ps1 | iex"
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

bun --version        # 验证：输出 ≥ 1.3 即可
```

**② 准备一个 LLM API Key**（任选其一）：Anthropic / OpenAI / OpenAI-Compatible
（DeepSeek、Kimi、任意兼容网关）/ Google / Bedrock。

> 没配 Key 也先能跑起来——启动后在 TUI 里输 `/provider` 或在 WebUI「设置 → 模型」里配，见 §9。

## 2. 安装并跑起来

```bash
# 1. 克隆并安装（refactor 分支是默认开发分支）
git clone https://github.com/zhu011/FengAgentCli.git
cd FengAgentCli
bun install

# 2. 配 Key（以 DeepSeek 为例；也可跳过，启动后再配）
export FENG_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_API_KEY=sk-...
export OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com
export FENG_MODEL=deepseek-chat

# 3a. 终端 TUI 对话
bun run packages/cli/src/entry.ts

# 3b. WebUI（另开一个终端）
bun run serve
# 浏览器打开 http://127.0.0.1:3000
```

<details>
<summary>全局安装（可选：任意目录直接 <code>fengagent</code> 进 TUI）</summary>

```bash
bun run pack && npm install -g ./fengagent-0.2.0.tgz   # 本地打包安装
fengagent                    # 任意目录进 TUI
fengagent acp                # ACP 服务（stdio JSON-RPC，供 Multica 等客户端接入）
```
</details>

- 开发模式（前端热更新）：`bun run dev`
- 数据根默认在 `<项目目录>/.fengagent-cordis/`（会话 / 插件 / 日志都在这）；换目录用 `FENG_DATA_DIR`。
- 常用环境变量速查见 [CONFIGURATION.md](./CONFIGURATION.md)。

## 3. 基础对话（TUI / WebUI）

- **TUI**：直接输入问题回车；`/help` 看全部命令；`/model` 换模型；`/provider` 配服务商；
  `/graph` 看对话图；`/rollback` 回退重答。命令速查表见
  [GUIDE-CORDIS §7](./GUIDE-CORDIS.md)。
- **WebUI**：`bun run serve` 后开 `http://127.0.0.1:3000`。三套主题（顶栏切换）、
  多会话并发、思考过程可视化、右侧对话图 / 权限审批面板。

## 4. 接入外部 Agent（kimi / dsh / claude…）

把本机的其它 **ACP Agent** 注册进运行时注册表，就能在团队里派遣它们：

1. 确保目标 Agent 已安装且支持 ACP（如 `kimi`、`dsh-acp`、`fengagent acp`）；
2. 编辑 **`<数据根>/runtimes.json`**（首次启动后自动生成，默认四条）：

```json
[
  { "name": "fengagent", "command": "fengagent", "args": ["acp"], "enabled": true },
  { "name": "dsh", "command": "dsh-acp", "args": ["acp"], "enabled": true },
  { "name": "kimi", "command": "kimi", "args": ["acp"], "enabled": true },
  { "name": "claude", "command": "claude", "protocol": "claude-stream-json", "enabled": true }
]
```

> 前三条走 ACP（stdio JSON-RPC）；claude 不是 ACP，走 `claude -p --output-format stream-json`。

3. WebUI 顶栏「**团队**」→ 子导航「**成员库**」：看到成员卡片即接入成功
   （卡片可探测运行时是否真的能拉起）。

> 目标 Agent 自己的凭据：在 `runtimes.json` 对应条目的 `env` 里给，或让它读自己的配置文件。
> 契约细节（任务 7 态 / 事件流 / HTTP API）见 [AGENTS-DISPATCH.md](./AGENTS-DISPATCH.md)。

## 5. 团队协作（派单 + 任务台账）

WebUI 顶栏「**团队**」页，三个子视图：

- **团队**：左列团队列表（「新建团队」选成员）→ 右侧团队详情：**聊天流**里直接对话，
  也可以**派发任务**给某个成员（任务卡就地展开：状态 / 流式输出 / 耗时）；
- **任务库**：跨团队任务台账，7 态筛选（created / dispatched / running / replied /
  failed / cancelled / expired），支持发起 / 取消 / 重试；
- **成员库**：运行时注册表卡片（见 §4）。

深链直达：`?view=teams`（团队）、`&sub=tasks`（任务库）、`&group=<id>`（某团队详情）。

## 6. 聊天群（多 Agent 讨论与拍板）

**团队 = 群**：把多个 Agent 拉进一个团队后，聊天流里它们按协作模式发言讨论；

- 你随时插话引导方向；
- 聊到可以收口时，点「**拍板**」——群立即收敛定格，产出定论；
- 也可以「**结束讨论**」人工收口。

后端模型与契约（群 / 消息 / 流式事件）见 [GROUPS.md](./GROUPS.md)。

## 7. 插件市场（浏览 / 搜索 / 一键安装）

WebUI「**设置 → 市场**」tab：接入社区策展目录（4000+ 插件，来源 awesome-dsh-plugin）。

- **搜索 / 分类**：搜索框防抖搜索，分类 chips 过滤（服务端分页，翻页点「加载更多」）；
- **兼容三档徽标**——装之前看一眼：

| 徽标 | 含义 | 装完效果 |
|---|---|---|
| **A · 即装即用**（绿） | 声明 `fengagent.webui` 的界面插件 | 刷新页面即渲染，无需重启 |
| **B · 装后需重启**（黄） | dsh 宿主侧工具/服务插件 | 重启宿主后进运行时（工具即生效） |
| **C · 界面不渲染**（灰，默认折叠） | dsh 客户端协议界面插件 | 本期不安装（对照组） |

- **安装**：点卡片「安装」→ 服务端从 npm registry 下载校验落盘（只装策展清单内的包）；
- **本地安装**：插件 tab 也收本地目录 / `.tgz` 包（拖不进市场时的兜底）。

完整契约（HTTP API / 三档判定 / 安全边界 / 缓存与探测）见 [PLUGINS.md](./PLUGINS.md)。

## 8. 插件管理与 UI 扩展面

WebUI「**设置 → 插件**」tab：已装列表、启用 / 停用、卸载；`.staging` 原子落盘 + 失败回滚。

**给插件开发者**：在插件 `package.json` 里声明 `fengagent` 字段即可把界面挂进 WebUI：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "fengagent": { "webui": { "entry": "./client.mjs", "slots": ["nav-extension"] } }
}
```

可用 slot：`settings-section` / `conversation-side-panel` / `team-detail-panel` / `nav-extension`。
完整协议（`setup(ctx)` / toast / primitives）见 [PLUGINS.md](./PLUGINS.md)，
扩展总指南见 [EXTENDING.md](./EXTENDING.md)。

## 9. Settings：网页里配模型（热切换）

WebUI「**设置 → 模型**」tab，不用碰环境变量：

- Provider 下拉 → 模型（带建议列表）→ temperature / maxTokens 等参数；
- 对应 Provider 的 API Key 输入框（已配置的显示掩码 `sk-a****`，**留空保持不变**，不会覆盖真 Key）；
- 「保存（热切换）」：保存即重建 LLM 客户端，**下一轮对话就用新模型**，无需重启宿主。

设置落在 `~/.fengagent/settings.json`（跨工作目录共享）；优先级与环境变量锁定的说明见
[SETTINGS.md](./SETTINGS.md)。

## 10. 常见问题

| 现象 | 处理 |
|---|---|
| 启动报模型 / Key 未配置 | TUI 里 `/provider`，或 WebUI「设置 → 模型」（§9） |
| 3000 端口被占 | `FENG_SERVER_PORT=3210 bun run serve` |
| 装的 B 档插件没生效 | 重启宿主（工具面在启动时装载）；「插件」tab 的 `restartRequired` 提示会告诉你 |
| B 档插件重启后仍报错 | 多半是该插件用了 Bun 不支持的 Node 内置模块（如 `node:sqlite`）或漏声明依赖——「插件」tab 的 error 列有具体原因 |
| main 分支和本分支数据混淆 | 不会：两分支数据根完全隔离（`.fengagent/` vs `.fengagent-cordis/`），见 [GUIDE-CORDIS §15](./GUIDE-CORDIS.md) |

更多 FAQ 见 [GUIDE-CORDIS §16](./GUIDE-CORDIS.md)。
