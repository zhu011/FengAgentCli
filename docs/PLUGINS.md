# 插件管理面（WebUI 插件扩展 · S2）

插件本体是**目录**：`<dataRoot>/plugins/<id>/package.json`。启用状态与安装来源是
**旁路记录**：`<dataRoot>/plugins.json`。文件是事实源——删掉状态文件等于「全部插件
默认启用」，手工把目录放进去也照样能用。

- 数据根：`FENG_DATA_DIR` > 配置 `dataDir` > `<workdir>/.fengagent-cordis`（见 `resolveDataRoot`）。
- 依赖：插件自带 UI 时在 `package.json` 声明 `fengagent.webui`（字符串或
  `{ entry, slots }`）；工具/服务型插件按 cordis 插件约定导出。
- 装依赖：安装时若 `package.json` 声明了 `dependencies`，在插件目录执行
  `bun install --production`；失败只回告警，不把插件打成半装状态。

## `plugins.json`

```json
{
  "version": 1,
  "revision": 3,
  "plugins": {
    "demo": { "enabled": true, "source": "D:\\plugins\\demo", "installedAt": "2026-11-02T…", "name": "@acme/demo", "version": "1.0.0" }
  }
}
```

`revision` 每次写回 +1。宿主启动时记下基线，之后任何装/卸/启停都会让它偏离基线 →
`restartRequired: true`（工具/服务面要重启宿主才重新装载；WebUI manifest 刷新即生效）。

## HTTP 面

所有响应 `Cache-Control: no-cache`；错误体统一 `{ error: { message, code } }`，
`code ∈ bad_request | unsupported | not_found | conflict | internal`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 列表：`{ plugins, errors, pluginsRoot, stateFile, revision, restartRequired }` |
| POST | `/api/plugins/install` | 安装：JSON `{ source }` 本地目录/`.tgz`，或 multipart 上传包 |
| POST | `/api/plugins/:id/enable` | 启用 |
| POST | `/api/plugins/:id/disable` | 停用（manifest/assets 立即不再对外） |
| DELETE | `/api/plugins/:id` | 卸载（删目录 + 清状态） |

`GET /api/plugins` 的插件条目：

```json
{
  "id": "demo", "name": "@acme/demo", "version": "1.0.0", "description": "…",
  "enabled": true, "hasWebui": true, "slots": ["settings-section"],
  "entry": "/api/webui/assets/demo/client.mjs",
  "bundleUrl": "/api/webui/assets/demo/client.mjs",
  "assetsBase": "/api/webui/assets/demo",
  "source": "D:\\plugins\\demo", "installedAt": "2026-11-02T…"
}
```

装/启停的响应：`{ plugin, revision, restartRequired, warnings? }`；卸载：
`{ id, removed: true, plugin?, revision, restartRequired }`。

### 安装

```jsonc
// 本地目录 / 本地 .tgz（不接受远程 URL / git 地址）
POST /api/plugins/install
{ "source": "D:\\plugins\\demo", "id": "demo", "enable": true, "installDeps": true }
```

```text
# 或 multipart 上传（字段：file 必填，id / enable 可选；上限 50 MB，仅 .tgz/.tar.gz）
POST /api/plugins/install   Content-Type: multipart/form-data
```

- `.tgz` 兼容 npm pack 的 `package/` 外层；解包用系统 `tar`。
- 冲突（同 id 已存在）→ `409`；安装失败会回滚已复制目录，不留半装插件。
- 上传安装的 `source` 记作 `upload:<文件名>`（临时路径装完即删，不留死链）。

### 安全边界

- 插件 id 只允许单段目录名（`A-Za-z0-9._@-`，拒绝 `..`/分隔符/盘符/NUL）；
  所有落盘路径都在 `<dataRoot>/plugins` 之内。
- 只接受本地源；上传包只接受 `.tgz`/`.tar.gz` 且限 50 MB。
- `/api/webui/assets/*` 只服务声明了 `fengagent.webui` 的插件目录内真实文件，
  目录穿越一律 404；坏包（`package.json` 非法）不会变成 500。

## WebUI 装载链（前端契约）

`GET /api/webui/manifest` 返回 `{ version: 1, plugins, errors }`，每个条目含
`entry` 与 `bundleUrl`（同值）以及 `assetsBase`。前端 `ModuleLoader` 用
`bundleUrl` 动态 `import()`，插件 bundle 从 `window.__FENG_REACT__` 取宿主 React
单例，`setup(ctx)` 里用 `ctx.registerSlot(slotId, component)` 挂界面：

```js
export function setup(ctx) {
  ctx.registerSlot("settings-section", () => React.createElement("div", null, "hello"));
}
```

可用 slot：`settings-section`、`conversation-side-panel`、`team-detail-panel`、
`nav-extension`。停用的插件不会出现在 manifest 里，其 assets 也返回 404。
