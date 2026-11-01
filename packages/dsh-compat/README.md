# @fengagent/dsh-compat（P1/M1 + P2/M2 + P3/M3）

dsh 插件兼容层：让 **tools-only dsh 插件**直接装进 FengAgentCli 运行时，
并把 dsh 的 `sessions` / `agents` / `agentDefaultModel` / `llm` 服务面与 `scope`
原语映射到现有能力。双向插件互通方案的方向 A（见 AGE-35 讨论）。

## 原理

两边同为 Cordis 4.0.1 插件体系，dsh 插件（命名导出 `name` / `inject` / `apply`）
本就是 Cordis 对象插件——FengAgentCli runtime 的用户插件路径
（`import(entry.id)` → `ctx.plugin(mod.default ?? mod, config)`）无需翻译即可装载。
缺的只是 `ctx.tools` 的 **dsh 接口面**：本包的插件给运行中的 tools 服务打补丁——

- `ctx.tools.register(defineTool(...))`：自动判别 dsh 定义（编译后 JSON Schema +
  `output.render` + `execute(args, exec)`），适配成 FengAgentCli `ToolDefinition`
  后进入 ToolRegistry，走与原生工具**完全相同**的注册/物化/执行管道；
- FengAgentCli 原生工具定义照旧直通，判别式不误伤；
- LLM 可见参数 = dsh 编译后的 JSON Schema **零转换直通**（providers 的
  `zodToJsonSchemaCompat` 以 `_def` + `toJSONSchema()` 鸭子类型读取）；
- 参数校验 = dsh 工具自带（`defineTool` 包裹），feng 侧 `parse` 直通；
- 取消语义：dsh `timeoutMs` → `AbortSignal.timeout`。

## 用法

runtime 插件配置（顺序：`feng.tools` → 本包 → dsh 插件）：

```ts
const runtime = createRuntime({
  workdir: ".",
  plugins: [
    { id: "feng.storage", config: { dbPath } },  // 需要服务面时必需
    { id: "feng.tools" },
    { id: "@fengagent/dsh-compat" },          // 或相对 cordis/src 的模块路径
    { id: "../../dsh-compat/src/services-plugin.ts" }, // P2 服务面（可选；见下节）；
                                                // 发布后为 @fengagent/dsh-compat/services
    { id: "some-dsh-plugin", config: { ... } } // 包名（根 node_modules 可解析）或路径
  ],
});
```

程序化装载：

```ts
import { loadDshPlugin, defineTool } from "@fengagent/dsh-compat";
await loadDshPlugin(ctx, "some-dsh-plugin", { ...config });
```

`loadDshPlugin` 带**三道硬门**（市场插件实测教训：缺服务的插件装载会「快速返回、
零工具、无报错」，用户误以为装上了）：

1. **inject 预检**：插件声明 inject 的服务必须已在线（经 `ctx.reflect.get` 免
   inject 查询），缺失即拒绝装载并点名缺谁（如 `sessionProjections`）；
2. **装载超时**：fiber 默认 15s 未就绪即失败并尽力卸载（`timeoutMs` 可调，`0` 不限）；
3. **工具增量门**：装载成功后要求至少注册 1 个工具（`requireTools` 默认开，
   服务型插件传 `{ requireTools: false }` 关闭）。

## dsh peer 版本矩阵（漏声明 peer 的兜底）

dshmarket 公共插件常**漏声明 peer**（实测：`dsh-plugin-writing-guard` 未声明
`@deepseek-ai/dsh-llm`、`dsh-better-edit` import `@deepseek-ai/dsh-fs` 却未声明）。
插件模块装在仓库根 `node_modules`，其裸导入也从根解析——因此兜底做法是把常用
dsh peer 矩阵**钉版本装在根 devDependencies**（当前：`dsh-tools` / `dsh-llm` /
`dsh-fs` / `dsh-scope`，全部 `0.1.0-rc.6` 线）。新插件报 `Cannot find module '@deepseek-ai/…'`
时，同法补进根矩阵即可（装完重跑 `bun test packages/dsh-compat`）。

## P2/M2 范围与限制

服务面插件 `dsh-services` 提供 `ctx.sessions` / `ctx.agents` / `ctx.agentDefaultModel`
（装配顺序：`feng.storage` → `dsh-services` → dsh 插件）。逐成员保真度分级
（direct / adapt / unsupported）与已知偏差见 **`docs/DSH-CONTRACT-MAP.md`**，
运行时可读 `DSH_SERVICE_CAPABILITIES` 做 preflight。

要点：
- **读**可用：`sessions.get/list`、`session.events`（消息的有损投影）、
  `agents` 的 live registry 与 initiator 归因；
- **写**受限：`session.append`、`session.surface`、`sessions.prepare/enter/announce`
  以及未注册 factory 时的 `agents.create/resume` 一律抛
  `DshContractUnsupportedError`（带 `contract` 路径），不静默降级；
- 事件溯源型 dsh 插件（session-persistence / session-query / llm-retry 等）
  仍**不能**真正工作——等 P3（llm/scope）与 P4（事件桥）。

## P3/M3 范围与限制（llm / scope / 服务面清单）

- **`ctx.llm`**：`registerAdapter` 路由表直通 dsh 适配器；未注册路由回落 `ctx.model`，
  把 dsh 消息/内容块翻成 `LLMRequest`、把 `LLMEvent` 翻回 `StreamChunk`；失败统一收敛为
  终态 `finish{kind:'error'|'aborted'}`。带 `tools` 的请求需要宿主注入
  `toolSchemaConverter`（dsh 是 JSON Schema、`ToolDefinition` 要 zod），没注入就明确拒绝。
- **`scope`**：不是 ctx 服务，而是 `@deepseek-ai/dsh-scope` 的库级原语；本包**直接重导出
  上游模块**（同一 Cordis 4 运行时，标签 symbol 必须一致），并补
  `scopeKeyForSession` / `createAgentScope` / `isScopedContext` 接线。
  按 scope 路由工具事件留 P4。
- **服务面清单**：`DSH_SERVICE_INVENTORY` 是 58 个包的 `inject` 聚合（tools 23 必需、
  systemPrompt 15 必需、…），可按分级做 preflight 诊断；排期建议见
  `docs/DSH-CONTRACT-MAP.md` §9。

仍不能真正工作的插件：`sessionProjections` 型（todo-plus）、`systemPrompt`+`fs` 型
（better-edit）——属下一批 `trivial-shim`/`needs-design`；`session.append` 等事件溯源
写路径继续显式 unsupported。

## M1 范围与限制

- `register` 返回的 disposer 已生效（P2 补上 `ToolService.unregister`）；
- dsh 插件包需可从仓库根 `node_modules` 解析（`bun add` 安装到根，或本地路径）。

## 版本策略

契约包钉 `@deepseek-ai/dsh-tools@0.1.0-rc.6`（本机 dsh CLI 同版，已实证）。
dsh 的 rc 之间 API 会变——升级 = 换依赖版本 + 重跑本包测试
（`bun test packages/dsh-compat`）。

## 测试

```bash
bun test packages/dsh-compat   # 单元 + 集成（含真实 fengagent-groups 插件装载验收）
```
