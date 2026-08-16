# 配置参考

## 配置优先级

从低到高（高优先级覆盖低优先级）：

1. **内置默认值**（代码中的 `DEFAULT_CONFIG`）
2. **全局配置**：`~/.fengagent/config.json`
3. **项目配置**：`./.fengagent/config.json`
4. **环境变量**：`FENG_*` 系列变量
5. **命令行参数**：`--model`、`--port` 等

## 模型配置

| 环境变量 | 配置键 | 默认值 | 说明 |
|----------|--------|--------|------|
| `FENG_MODEL` | `model` | `claude-sonnet-4-20250514` | 主模型 ID |
| `FENG_SMALL_MODEL` | `smallModel` | `claude-haiku-3` | 小模型（压缩/摘要用） |
| `FENG_PROVIDER` | `provider` | `anthropic` | LLM 提供商 |
| `FENG_MAX_TOKENS` | `maxTokens` | `8192` | 单次生成最大 token 数 |
| `FENG_TEMPERATURE` | `temperature` | `1.0` | 生成温度（0-2） |
| `FENG_FALLBACK_MODEL` | `fallbackModel` | — | 主模型失败时的回退模型 |

## API 密钥

| 环境变量 | 说明 |
|----------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `OPENAI_COMPATIBLE_API_KEY` | OpenAI 兼容 API 密钥 |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI 兼容 API 地址 |
| `OPENAI_COMPATIBLE_MODEL` | OpenAI 兼容模型 ID |
| `GOOGLE_API_KEY` | Google Gemini API 密钥 |
| `AWS_BEDROCK_REGION` | AWS Bedrock 区域 |
| `AWS_ACCESS_KEY_ID` | AWS 密钥 ID |
| `AWS_SECRET_ACCESS_KEY` | AWS 密钥 |

## 上下文配置

| 环境变量 | 配置键 | 默认值 | 说明 |
|----------|--------|--------|------|
| `FENG_CONTEXT_WINDOW` | `contextWindow` | `200000` | 上下文窗口大小（token） |
| `FENG_COMPACT_THRESHOLD` | `compactThreshold` | `0.85` | 压缩触发阈值（占窗口比例） |
| `FENG_COMPACT_KEEP_TOKENS` | `compactKeepTokens` | `8000` | 压缩后保留的近期 token 数 |
| `FENG_COMPACT_BUFFER` | `compactBuffer` | `20000` | 压缩缓冲区大小 |
| `FENG_DISABLE_COMPACT` | `disableCompact` | `false` | 禁用自动压缩 |
| `FENG_TOOL_OUTPUT_MAX_CHARS` | `toolOutputMaxChars` | `2000` | 工具输出最大字符数 |

## 服务配置

| 环境变量 | 配置键 | 默认值 | 说明 |
|----------|--------|--------|------|
| `FENG_SERVER_PORT` | `serverPort` | `3000` | HTTP 服务端口 |
| `FENG_SERVER_HOST` | `serverHost` | `127.0.0.1` | HTTP 服务监听地址 |
| `FENG_CORS_ORIGIN` | `corsOrigin` | `*` | CORS 允许来源 |
| `FENG_WEB_UI_PORT` | — | `5180` | Vite dev server 端口（仅 dev 模式） |

## 工具与权限配置

| 环境变量 | 配置键 | 默认值 | 说明 |
|----------|--------|--------|------|
| `FENG_AUTO_APPROVE_TOOLS` | `autoApproveTools` | `false` | 自动批准所有工具执行 |
| `FENG_ALLOWED_TOOLS` | `allowedTools` | `*` | 允许的工具列表（逗号分隔） |
| `FENG_DENIED_TOOLS` | `deniedTools` | — | 禁止的工具列表（逗号分隔） |
| `FENG_BASH_TIMEOUT` | `bashTimeout` | `120000` | Bash 命令超时（毫秒） |
| `FENG_MAX_TOOL_CONCURRENCY` | `maxToolConcurrency` | `10` | 工具最大并行数 |
| `FENG_MAX_TURNS` | `maxTurns` | `50` | 单次对话最大轮次 |

## 高级配置

| 环境变量 | 配置键 | 默认值 | 说明 |
|----------|--------|--------|------|
| `FENG_CONFIG_FILE` | — | `.fengagent/config.json` | 配置文件路径 |
| `FENG_DATA_DIR` | `dataDir` | `.fengagent-cordis`（相对 workdir） | 数据存储目录（refactor/cordis 分支默认数据根；`~/.fengagent` 为 main 遗留数据根，仅作导入源/只读回退） |
| `FENG_MAIN_DATA_DIR` | — | — | 显式指定 main 遗留数据根（导入源）。探测顺序：`FENG_MAIN_DATA_DIR` → `<workdir>/.fengagent` → `~/.fengagent` → `<workdir>/data`，首个含 `sessions.db`/`graph.jsonl` 者胜 |
| `FENG_LOG_LEVEL` | `logLevel` | `info` | 日志级别（debug/info/warn/error） |
| `FENG_LOG_DIR` | — | `<dataRoot>/logs` | 日志目录 |
| `FENG_MCP_SERVERS` | — | — | MCP 服务器配置（JSON 格式） |

**配置读取优先级（全链）**：`.fengagent-cordis/config.json`（分支级，`/model` `/provider` 只写这里）>
项目 `.fengagent/config.json` > 全局 `~/.fengagent/config.json`（其后是环境变量 → CLI 参数）。

## 配置文件格式

### 全局配置（`~/.fengagent/config.json`）

```jsonc
{
  "model": "claude-sonnet-4-20250514",
  "smallModel": "claude-haiku-3",
  "provider": "anthropic",
  "maxTokens": 8192,
  "temperature": 1.0,
  "contextWindow": 200000,
  "compactThreshold": 0.85,
  "compactKeepTokens": 8000,
  "disableCompact": false,
  "autoApproveTools": false,
  "allowedTools": "*",
  "bashTimeout": 120000,
  "maxTurns": 50,
  "logLevel": "info"
}
```

### 项目配置（`./.fengagent/config.json`）

```jsonc
{
  "model": "claude-sonnet-4-20250514",
  "allowedTools": "file-read,file-write,file-edit,bash,glob,grep"
}
```

### 权限规则（`./.fengagent/permissions.json`）

```json
{
  "rules": [
    { "tool": "bash", "action": "ask", "reason": "Shell commands require approval" },
    { "tool": "file-write", "action": "ask" },
    { "tool": "file-edit", "action": "ask" },
    { "tool": "task", "action": "ask" },
    { "tool": "*", "action": "allow" }
  ],
  "cache": true
}
```

权限 action 值：
- `allow` — 自动批准
- `deny` — 自动拒绝
- `ask` — 询问用户（CLI 弹框 / WebUI SSE 推送）

### MCP Server 配置（`./.fengagent/mcp-servers.json`）

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

或通过环境变量：

```bash
export FENG_MCP_SERVERS='{"servers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}'
```

### Agent 定义（`./.fengagent/agents/*.md`）

```markdown
---
name: code-reviewer
description: 代码审查专家
model: claude-sonnet-4-20250514
tools:
  - file-read
  - grep
  - glob
max_turns: 20
---

你是一个代码审查专家。你的职责：
1. 阅读代码并识别潜在 bug
2. 检查代码风格和最佳实践
3. 提出改进建议
```

### 插件（`./.fengagent/plugins/<name>/index.ts`）

```typescript
import type { FengPlugin, PluginContext } from "@fengagent/core";

export default class MyPlugin implements FengPlugin {
  name = "my-plugin";
  version = "1.0.0";

  async init(ctx: PluginContext) {
    // 初始化逻辑
  }

  registerTools(registry: ToolRegistry) {
    // 注册自定义工具
  }

  registerHooks(registry: HookRegistry) {
    // 注册生命周期 Hook
  }
}
```

### Skills（`./.fengagent/skills/*.md`）

```markdown
---
name: code-review
description: 代码审查技能
trigger: review|审查|code review
---

你正在进行代码审查。请关注：
- 边界条件处理
- 错误处理完整性
- 类型安全
- 性能问题
```

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--model <id>` | 指定模型 |
| `--port <n>` | 指定服务端口 |
| `--session <id>` | 恢复已有会话 |
| `--version` | 显示版本信息 |
| `serve` | WebUI 服务模式 |
| `--print "问题"` | 非交互模式（stdin → stdout） |

## TUI 命令：`/provider`（配置 Provider）

在 CLI 交互模式（`bun run packages/cli/src/entry.ts`）中，用 `/provider` 查看或切换 LLM Provider，
无需修改环境变量、无需重启：

| 命令 | 说明 |
|------|------|
| `/provider show` | 显示当前 provider / baseUrl / model；apiKey 只显示前 4 位 + `****` |
| `/provider set <type>` | 配置 Provider。type ∈ `anthropic` / `openai` / `openai-compatible` / `google` |
| `/provider set <type> --api-key X --base-url Y --model Z` | 参数直接传值；缺省项会逐项提示输入 |

### 行为说明

- **持久化路径**：写入分支级 `./.fengagent-cordis/config.json`（与现有配置 deepMerge 合并，保留其他键；
  main 的 `.fengagent/config.json` 只读回退，不被覆盖）；下次启动 `loadConfig` 自动读取。
- **立即生效**：配置后自动调用 `createClientFromEnv` 重建 LLM Client，并通过
  `ReloadableLLMClient.setClient` 热替换到当前 Agent（`packages/llm/src/reloadable.ts`），
  无需重建 Agent；下一条消息即走新 Provider。
- **示例（DeepSeek）**：
  ```bash
  /provider set openai-compatible \
    --api-key sk-xxx \
    --base-url https://api.deepseek.com \
    --model deepseek-v4-pro
  ```
- **安全约定**：apiKey 全程不回显明文（输入时回显 `*`，展示时 `前4位****`），
  不写入运行日志 / llm-trace。

对应配置键：`provider`、`anthropicApiKey/BaseUrl`、`openaiApiKey/BaseUrl`、
`openaiCompatibleApiKey/BaseUrl/Model`、`googleApiKey/BaseUrl`、`model`。

## TUI 命令：`/model`（切换模型）

`/model` 查看 / 切换当前 Provider 的模型，持久化并立即生效（复用 `/provider` 的
`config + ReloadableLLMClient` 热替换链路）：

| 命令 | 说明 |
|------|------|
| `/model list` | 列出当前 Provider 实际可用/已配置的模型。openai-compatible 会尝试拉取 `{baseUrl}/models` 真实目录（3s 超时），失败或未配置时回退到常见模型目录并标注当前模型 |
| `/model <id>` | 切换模型：写入 `config.model`（openai-compatible 同时写 `openaiCompatibleModel`）→ 持久化到 `./.fengagent-cordis/config.json` → `reloadProvider` 重建并热替换 LLM Client → 更新当前会话 `session.model` |

### 生效链路

1. **持久化**：`writeConfigFile({ model, openaiCompatibleModel? })` 写入分支级 `./.fengagent-cordis/config.json`；
2. **热替换**：`reloadProvider`（`packages/cli/src/create-agent.ts`）重建 LLM Client 并 `setClient` 原子替换；
3. **会话同步**：App 层把 `newModel` 写回 `session.model`；Agent Loop
   （`packages/agent/src/loop.ts`）每次 LLM 请求都以 `session.model` 作为 `request.model`，
   因此后续对话真实走新模型（所有 Provider 的 client 均优先使用 `request.model`）。

> 提示：`/model list` 在 openai-compatible 下返回的是服务端真实模型目录（如 DeepSeek 的
> `deepseek-chat` / `deepseek-reasoner`），非硬编码列表。

## 测评模块（`bun run eval`）

读取 LLM Trace 日志（`<数据根>/logs/llm-trace-{date}.jsonl`）分析工具成功率 / 任务完成率 /
错误率 / Token 用量 / KV Cache 命中率 / 模型对比，报告输出 `<数据根>/logs/eval-report-{date}.md`：

| 命令 | 说明 |
|------|------|
| `bun run eval` | 分析今天的日志 |
| `bun run eval --date=2026-08-16` | 分析指定日期 |
| `bun run eval --all` | 分析全部日志 |
| `bun run eval --file=<路径>` | 分析指定文件 |
| `bun run eval --exclude-model=test-model,custom-model` | 排除某些模型（如测试 mock） |

## 事件溯源 CLI（`scripts/events-migrate.ts`）

把 `packages/events` 的导出 / 导入 / 重建 / 对账能力暴露为命令行（数据根默认
`<workdir>/.fengagent-cordis`，可用 `FENG_DATA_DIR` 覆盖）：

| 命令 | 说明 |
|------|------|
| `bun run scripts/events-migrate.ts list` | 列出有事件日志的会话 |
| `bun run scripts/events-migrate.ts verify [--session <id>]` | 事件链校验 + 双写对账（投影 === 读模型） |
| `bun run scripts/events-migrate.ts export [--dir <目录>] [--session <id>]` | 整库/单会话导出可移植事件文件 |
| `bun run scripts/events-migrate.ts import <目录>` | 导入可移植事件文件（幂等去重，只写事件日志） |
| `bun run scripts/events-migrate.ts rebuild [--prune]` | 以事件为准重建读模型（SQLite 降级为读模型） |

完整的小白操作步骤与预期输出见 [GUIDE-CORDIS.md](./GUIDE-CORDIS.md) 第 14 节。
