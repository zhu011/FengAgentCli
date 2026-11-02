# WebUI Settings（模型 / Provider · S3）

Settings 的「模型」tab 背后的服务面：读当前生效配置、写 `settings.json`、热切换
运行中的 LLM client，并把 Provider 目录与配置状态交给前端渲染。

- 设置文件：`FENG_SETTINGS_FILE` > `~/.fengagent/settings.json`（跨工作目录共享）
- 优先级：**环境变量 > settings.json > 配置文件（全局/项目/分支/`FENG_CONFIG_FILE`）> 内置默认值**
- 热切换：`PATCH` 成功即重建 client，会话下一轮用新 Provider/模型/凭据，**不需要重启宿主**
- 安全：API Key 只进文件（POSIX 上 `0600`），任何 HTTP 响应里的 Key 都是 `sk-a****` 形态

## `settings.json`

```json
{
  "version": 1,
  "settings": {
    "provider": "openai-compatible",
    "model": "deepseek-chat",
    "temperature": 0.3,
    "maxTokens": 8192,
    "openaiCompatibleBaseUrl": "https://api.deepseek.com/v1",
    "openaiCompatibleApiKey": "sk-…"
  }
}
```

- 只允许写入下表这些键；未知键 / 类型越界的键在 PATCH 时 **400**，在文件里则被忽略并
  在 `warnings` 里回告（坏文件不会让运行时起不来）。
- 落盘是「合并」：只改你给的键，其余保持原样；写临时文件后 `rename`，崩溃不留半截 JSON。
- 空串视为「未设置」（UI 清空输入框不会把已有凭据抹成空字符串）。

可设置键：

| 分组 | 键 |
|---|---|
| 模型面 | `provider` `model` `smallModel` `fallbackModel` `maxTokens` `temperature` `contextWindow` `compactThreshold` |
| Anthropic | `anthropicApiKey` `anthropicBaseUrl` |
| OpenAI | `openaiApiKey` `openaiBaseUrl` |
| OpenAI 兼容 | `openaiCompatibleApiKey` `openaiCompatibleBaseUrl` `openaiCompatibleModel` |
| Google | `googleApiKey` `googleBaseUrl` |

`bedrock` 的凭据只能来自 AWS 环境变量（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`），
不进 `settings.json`。

## 环境变量锁定

环境变量非空即「锁定」该键：PATCH 仍然落盘，但当前进程继续用环境变量的值，
响应里以 `overridden` 回告（下次没有该环境变量时，落盘值才生效）。

```bash
FENG_MODEL=claude-sonnet-4-20250514 feng serve
# UI 改 model → 200 { written:["model"], overridden:["model"] }，实际仍走环境变量的模型
```

每个键对应的环境变量：`FENG_PROVIDER` `FENG_MODEL` `FENG_SMALL_MODEL` `FENG_FALLBACK_MODEL`
`FENG_MAX_TOKENS` `FENG_TEMPERATURE` `FENG_CONTEXT_WINDOW` `FENG_COMPACT_THRESHOLD`
`ANTHROPIC_API_KEY` `ANTHROPIC_BASE_URL` `OPENAI_API_KEY` `OPENAI_BASE_URL`
`OPENAI_COMPATIBLE_API_KEY` `OPENAI_COMPATIBLE_BASE_URL` `OPENAI_COMPATIBLE_MODEL`
`GOOGLE_API_KEY` `GOOGLE_BASE_URL`。

## HTTP 面

所有响应 `Cache-Control: no-cache`；错误体统一 `{ error: { message, code } }`，
`code ∈ bad_request | internal`。

### `GET /api/settings/model`

```json
{
  "settings": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "anthropicApiKey": "sk-a****" },
  "persisted": { "model": "claude-sonnet-4-20250514" },
  "sources": { "provider": "config", "model": "settings", "temperature": "config" },
  "envLocked": ["provider"],
  "overridden": ["model"],
  "active": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "smallModel": "claude-haiku-3",
              "maxTokens": 8192, "temperature": 0.2, "contextWindow": 200000, "compactThreshold": 0.8 },
  "settingsPath": "C:\\Users\\me\\.fengagent\\settings.json",
  "warnings": []
}
```

- `settings`：当前**生效值**（敏感键打码）；`persisted`：`settings.json` 里持久化的值；
- `sources[key]`：`env` | `settings` | `config`（`config` = 配置文件和默认值，未细分是刻意的：
  UI 只需要知道「这个值不是我在设置页写的」）；
- `envLocked`：被环境变量锁定的键；`overridden`：已持久化但当前被环境变量覆盖的键；
- `warnings`：坏文件 / 被忽略的键。

### `PATCH /api/settings/model`

```jsonc
// 请求：至少一个可设置键；未知键 → 400（不做静默忽略）
{ "provider": "openai", "model": "gpt-4o", "openaiApiKey": "sk-…" }
```

```jsonc
// 200
{
  "snapshot": { /* 同 GET */ },
  "written": ["provider", "model", "openaiApiKey"],
  "overridden": [],
  "applyError": "…"        // 仅在热切换失败时出现（设置已落盘，重启后生效）
}
```

PATCH 的处理顺序：校验 → 落盘 → 按「与重启一致」的优先级重载配置 → 热切换 client。
因此「UI 上看到的生效值」与「重启后拿到的值」永远一致。

### `GET /api/settings/providers`

```json
{
  "active": "anthropic",
  "providers": [
    {
      "id": "anthropic", "label": "Anthropic", "description": "Claude 官方 API（anthropic.com）",
      "active": true, "configured": true,
      "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-3"],
      "fields": [
        { "key": "anthropicApiKey", "label": "API Key", "type": "secret", "env": "ANTHROPIC_API_KEY",
          "required": true, "locked": false, "configured": true, "value": "sk-a****" },
        { "key": "anthropicBaseUrl", "label": "Base URL", "type": "url", "env": "ANTHROPIC_BASE_URL",
          "required": false, "locked": false, "configured": false }
      ]
    }
  ]
}
```

- `type`：`text` | `secret` | `url`（前端据此渲染 input 类型；`secret` 的 `value` 一定打码）；
- `configured`：`required` 项齐全（`bedrock` 另有 `requiredEnv`，需 `AWS_*` 环境变量）；
- `locked`：该配置项被环境变量锁定（改 UI 不生效）；
- `models`：仅作输入建议，不校验。

## 前端接线（模型 tab）

1. `GET /api/settings/providers` → Provider 下拉 + 每个 Provider 的配置项（`locked` 项置灰并提示「由环境变量提供」）；
2. `GET /api/settings/model` → 回填当前值，`sources`/`envLocked` 用来标注「来自环境变量」；
3. 保存 → `PATCH /api/settings/model`，用返回的 `snapshot` 直接刷新（不要本地乐观更新：
   `overridden` / `applyError` 只有服务端知道）；
4. `applyError` 非空 → 提示「已保存，重启后生效」。

## 文件边界

- `packages/core/src/settings.ts`：`settings.json` 的读写、校验、合并、打码；
- `packages/core/src/config.ts`：`loadConfig` 的 settings 层（env > settings.json > 配置文件）；
- `packages/llm/src/catalog.ts`：Provider 目录（配置项 / 环境变量 / 建议模型）；
- `packages/server/src/model-settings.ts`：读生效值 / PATCH 落盘 + 热切换 / Provider 状态；
- `packages/server/src/routes/settings.ts`：`/api/settings/*` HTTP 适配；
- `packages/server/src/create-runtime-agent.ts`：装配（`modelSettings` 服务）。
