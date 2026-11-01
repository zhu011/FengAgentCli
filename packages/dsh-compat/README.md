# @fengagent/dsh-compat（P1/M1 + P2/M2）

dsh 插件兼容层：让 **tools-only dsh 插件**直接装进 FengAgentCli 运行时，
并把 dsh 的 `sessions` / `agents` / `agentDefaultModel` 服务面映射到现有能力。
双向插件互通方案的方向 A（见 AGE-35 讨论）。

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
