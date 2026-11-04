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
    "demo": { "enabled": true, "source": "D:\\plugins\\demo", "installedAt": "2026-11-02T…", "name": "@acme/demo", "version": "1.0.0", "protocol": "webui" },
    "better-edit": { "enabled": true, "source": "market:dsh-better-edit@1.2.0", "sourceLabel": "market:dsh-better-edit", "resolvedVersion": "1.2.0", "integrity": "sha512-…", "protocol": "dsh", "installedAt": "2026-11-04T…" }
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
| GET | `/api/plugins/market` | 市场目录：`?q=&category=&limit=&offset=`（服务端搜索分页，默认 24 / 上限 100） |
| GET | `/api/plugins/market/:name` | 市场详情：版本列表 + 兼容档（A/B/C） |
| POST | `/api/plugins/install` | 安装：JSON `{ source }` 本地源 / `{ marketName, marketVersion }` 市场源（也收嵌套 `{ market: { name, version } }`）/ multipart 上传包 |
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

### 市场安装

```jsonc
// 市场安装唯一入口（规范形）：服务端先用 catalog 策展清单校验
// （名称必须在目录里、不能是 C 档 dsh.client），再解析成 npm tarball 安装。
// 嵌套体 { market: { name, version } } 作为兼容别名同样被接受（归一后等价）。
POST /api/plugins/install
{ "marketName": "dsh-better-edit", "marketVersion": "1.2.0" }
```

流水线：catalog 校验 → registry 解析 `dist.tarball`/`dist.integrity` → 下载并校验
sha512 → 解包 → `<pluginsRoot>/.staging-*` → `bun install --production`（**strict**，
失败即整体失败）→ rename 原子落盘 → 登记。任一步失败都删 staging / 已就位目录 /
`store.forget(id)`。

- **不开放任意 npm spec**：`{ source: "npm:…" }` 一律 400，避免接口变成「任意 npm
  包执行器」；本地目录 / `.tgz` / 上传通道不变。
- 登记字段：`source: "market:<name>@<version>"`、`sourceLabel: "market:<name>"`、
  `resolvedVersion`、`integrity`、`registry`（配置了镜像时）、`protocol`。
- `protocol` 由 package.json 探测：`webui`（`fengagent.webui`）/ `dsh`（`dsh`、
  `engines.dsh`、dsh 关键字）/ `cordis`（有 `main`/`exports`）/ `unknown`。

市场目录（A）细节：源顺序 `FENG_MARKET_CATALOG_URL` → jsDelivr 镜像
`cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` → `awesome-dsh-plugin.com/plugins.json`；
内存 + `<dataRoot>/cache/market-catalog.json` 缓存，TTL 1 小时；抓取失败回退 stale
（`stale: true` + `error`），首启无网返回空列表 + `retryable: true`，不阻塞页面。

列表条目（`GET /api/plugins/market` 的 `plugins[]`，WebUI 市场页契约）：

```json
{
  "name": "@0imzero/dsh-workspace-menu", "title": "0imzero/dsh-workspace-menu",
  "description": "DSH 主页工作区/会话增强菜单…",
  "descriptionI18n": { "zh": "…", "en": "…" },
  "category": "ui", "version": "2.1.0", "latestVersion": "2.1.0",
  "engines": { "dsh": ">=0.5.0" },
  "repository": "https://github.com/…", "homepage": "https://…",
  "compat": "C", "compatReason": "…", "compatSource": "registry", "installable": false
}
```

`compat` 三档：`"A"`（声明 `fengagent.webui`，即装即渲染）/ `"B"`（dsh host 侧
tools/services，dsh-compat 试装 + 需重启）/ `"C"`（`dsh.client` 界面插件，装得上
但界面不渲染——对照组，`installable: false`，安装闸门拒绝）。

响应：`{ plugins, total, limit, offset, categories, source, fetchedAt, stale?, error?, retryable? }`，
`categories` 是 `[{ id, title: { zh, en } }]`，只含本次结果集里出现的分类（前端 chips
直接消费），标题取自 catalog 顶层 `metadata.categories`。前端按 `offset + limit < total`
继续翻页。

catalog format-1 只给包名/标题/双语描述/`metadata.category`/`versions[].version`，
**没有 package.json 的 `dsh`/`fengagent` 字段**，所以列表先按 catalog 判 hint
（`compatSource: "catalog"`；没有形态信号时按 B）。`GET /api/plugins/market` 随后对
**当前页**（≤100 条）用 registry 的 `/<name>/latest` 元数据确认档位
（`compatSource: "registry"`）：A/C 档会真实出现，C 档 `installable: false`。探测带
1 小时内存缓存（按包名）与熔断（连续 6 次非 404 失败后冷却 5 分钟，期间用 hint）；
`FENG_MARKET_PROBE=0` 可关闭。冷启动首屏（24 条）约 2–6s（取决于 registry 延迟；
`FENG_NPM_REGISTRY` 可换镜像），同页再次请求命中缓存后 <1s。详情
（`/market/:name`）与安装闸门同样用 registry 元数据确认；安装前 registry 明确是
`dsh.client` 的一律拒绝。

catalog format-1 只给包名/标题/双语描述/`metadata.category`/`versions[].version`，
**没有 package.json 的 `dsh`/`fengagent` 字段**，所以列表里的 `compat` 是 hint
（`compatSource: "catalog"`），详情（`/market/:name`）与安装闸门会用 registry
元数据确认（`compatSource: "registry"`）；安装前 registry 明确是 `dsh.client` 的
一律拒绝。

响应分页字段：`{ plugins, total, limit, offset, source, fetchedAt, stale?, error?, retryable? }`，
前端按 `offset + limit < total` 继续翻页。

### 安全边界

- 插件 id 只允许单段目录名（`A-Za-z0-9._@-`，拒绝 `..`/分隔符/盘符/NUL）；
  所有落盘路径都在 `<dataRoot>/plugins` 之内。
- 本地源只接受目录 / `.tgz` / 上传包（`.tgz`/`.tar.gz`，50 MB 上限）；市场源只接受
  catalog 策展条目，且 C 档拒绝一键安装。
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
