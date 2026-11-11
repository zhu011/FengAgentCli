# MCP 与工具授权（保姆级）

> 面向第一次接触：把 MCP 工具接进来、看懂授权弹窗、按需开全自动。每一步都能照抄。
> 配置项的权威语义见 [CONFIGURATION.md](./CONFIGURATION.md)；本文只讲「怎么用」。

## 一、接入 MCP 工具（5 分钟）

MCP（Model Context Protocol）让你把外部工具（文件系统、GitHub、浏览器…）挂给
Agent 用。**只需要写一个 JSON 文件**，不用写代码。

### 1. 建配置文件

在**项目目录**下建 `.fengagent/mcp-servers.json`（启动 FengAgentCli 时所在的目录）：

```json
{
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
    "env": {},
    "timeout": 30000,
    "enabled": true
  },
  "github": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
  }
}
```

> ⚠️ **顶层就是「服务器名 → 配置」的平铺结构，不要再包一层 `"servers": {}`**——
> 多包一层会导致解析失败，一个 MCP 工具都不会注册（启动时 stderr 只有一行
> `MCP: initialization error`）。

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 否 | `stdio`（默认，本地命令）/ `sse`（远程服务） |
| `command` + `args` | stdio 必填 | 启动命令与参数 |
| `url` + `headers` | sse 必填 | 远程地址与鉴权头 |
| `env` | 否 | 注入子进程的环境变量（放 API Key） |
| `timeout` | 否 | 连接超时毫秒（默认 30000） |
| `enabled` | 否 | `false` 临时停用（默认 `true`） |

远程服务器（SSE）示例：

```json
{
  "remote-tools": {
    "type": "sse",
    "url": "https://your-host/sse",
    "headers": { "Authorization": "Bearer xxx" }
  }
}
```

> 目前支持 stdio 与 SSE 两种传输；暂不支持 streamable-http。

### 2. 重启并验证

重启 TUI / WebUI 后，在对话里输 `/tool list`（或问 Agent「你有哪些工具」）——
能看到 `mcp__filesystem__read_file` 这类名字就成功了；`/mcp list` 可看每个
服务器的连接状态与失败原因，`/mcp reload` 重连。

**工具命名规则**：`mcp__<服务器名>__<工具名>`（非安全字符会替换为 `_`）。

### 3. 环境变量方式（不改文件）

```bash
export FENG_MCP_SERVERS='{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}'
```

与文件**按服务器名浅合并**，env 里同名服务器覆盖文件配置。

### 常见坑

| 现象 | 原因 |
|---|---|
| 启动时 `MCP: initialization error` | JSON 写错（最常见：多包了 `servers` 层） |
| 工具列表里没有 | 服务器进程没起来（`command` 不存在）/ `enabled: false`；连接失败不阻断启动——**失败原因用 TUI 里 `/mcp list` 查看**（会显示每个服务器的连接状态与具体报错），`/mcp reload` 可重连 |
| 想改了配置不重启 | 目前需要重启进程（配置只在启动时读；`/mcp reload` 只重连，不重读配置文件） |

## 二、工具授权：弹窗怎么看、怎么选

Agent 调用「有副作用」的工具（bash、文件写入、MCP 工具等）前会请求批准。
默认行为：**只读工具直接放行，其余弹窗问你**。

### TUI 审批弹窗（五键）

```
╭───────────────────────────────────────────╮
│ ⚠ 权限请求  — bash                        │
│ 参数: {"command":"rm -rf /tmp/x"}         │
│ 原因: destructive                          │
│                                           │
│ [y] 允许   [e] 改参后允许   [s] 本会话总允许   [p] 永久允许   [n] 拒绝 │
╰───────────────────────────────────────────╯
```

| 键 | 作用 | 适合场景 |
|---|---|---|
| `y` / Enter | 允许**这一次** | 偶尔用一次的操作 |
| `e` | **改参后允许**：编辑参数 JSON 再放行（回车提交，Esc 返回） | 命令差点意思，改一下再跑 |
| `s` | **本会话总允许**：这个工具本次运行内不再弹窗（重启失效） | 这一轮要连续用同一个工具 |
| `p` | **永久允许**：写进 `.fengagent/permissions.json`，以后每次启动都放行 | 你信任这个工具 |
| `n` / Esc | 拒绝 | 不想让它跑 |

> `p` 写盘后**当次会话立即生效**（同时进了会话放行集）；文件规则对**下次启动**生效。

WebUI 的审批在右上角检查器面板（入参 JSON 可编辑，等价于 TUI 的 `e`）；卡片上的
「本会话允许」等价于 TUI 的 `s`，点完会出现在面板下半部分的「已授权项」里。

### 已授权项怎么收回（WebUI）

检查器「Permissions」面板下半部分是**已授权项**，两类都能一键撤销：

| 类型 | 来源 | 撤销后 |
|---|---|---|
| 本会话 | 卡片上点「本会话允许」（进程内，重启即失效） | 该工具下次调用重新弹窗 |
| 永久 · allow/deny/ask | `.fengagent/permissions.json` 的规则 | 规则从文件删除，**立即生效**（服务端重载检查器并清空决策缓存） |

对应接口（实现见 `packages/server/src/routes/sessions.ts`）：

- `GET /api/sessions/:id/permissions/grants` → `{ session, permanent, path, workdir }`
- `DELETE /api/sessions/:id/permissions/grants` `{ tool? }` → 收回会话级放行（不传 `tool` = 全部）
- `DELETE /api/sessions/:id/permissions/rules` `{ tool, action? }` → 删除永久规则（不传 `action` = 该工具全部动作）


## 三、三档授权模式（不想一直点允许？）

### 档位 1：默认（询问）

什么都不配。只读工具放行、危险工具弹窗、无审批通道的宿主（子 Agent）直接拒绝。

### 档位 2：白名单 / 黑名单

```bash
# 只允许这些工具（逗号分隔精确名；默认 * = 全部）
export FENG_ALLOWED_TOOLS=file-read,file-write,glob

# 永远禁止这些工具
export FENG_DENIED_TOOLS=bash
```

或写规则文件 `.fengagent/permissions.json`（按顺序匹配，`"*"` 匹配所有）：

```json
{
  "rules": [
    { "tool": "file-read", "action": "allow" },
    { "tool": "file-write", "action": "allow" },
    { "tool": "mcp__filesystem__read_file", "action": "allow" },
    { "tool": "bash", "action": "ask", "reason": "Bash requires approval" },
    { "tool": "*", "action": "deny" }
  ]
}
```

> ⚠️ 两个容易踩的坑：
> 1. **白名单是精确名匹配，没有 `mcp__server__*` 前缀通配**——MCP 工具要逐个列名，
>    或者用 `{"tool": "*", "action": "deny"}` 这类规则收尾控制总边界；
> 2. 环境变量层之外还有规则文件层，**优先级见下表**，别只看一层。

### 档位 3：全授权（全自动）

```bash
export FENG_AUTO_APPROVE_TOOLS=1
```

所有工具直接放行，**连黑名单和规则文件里的 deny 都会盖掉**——适合沙箱/测试环境，
生产环境慎用。MCP 工具走同一套授权，也会被连带放开。

配置文件方式（`.fengagent/config.json` 等文件层）同样支持这三个键
（`autoApproveTools` / `allowedTools` / `deniedTools`）。

### 决策优先级（谁说了算）

工具执行前按顺序过这道链，**第一处命中即生效**：

| 顺序 | 来源 | 语义 |
|---|---|---|
| 1 | `FENG_AUTO_APPROVE_TOOLS` | 直接放行，**盖过下面所有 deny** |
| 2 | 决策缓存 | 同工具 + 同参数复用上次结论 |
| 3 | `FENG_ALLOWED_TOOLS`（默认 `*`） | 不在列表即拒 |
| 4 | `FENG_DENIED_TOOLS` | 命中即拒 |
| 5 | `.fengagent/permissions.json` | 首个匹配规则决定 allow / deny / ask |
| 6 | 工具自身策略（bash 等） | 工具级兜底 |
| 7 | 属性推断 | 只读放行；破坏性 → 弹窗（无审批通道则拒） |

## 四、ACP / 宿主托管模式（了解即可）

`fengagent acp`（如 Multica 桌面）走 ACP 审批转发：审批请求发给宿主决策，
宿主不表态/超时按「宿主未表态」放行并在工具结果上打
`metadata.permissionPreAuthorized = true` 留痕。TUI 的弹窗语义不适用于这条路。
