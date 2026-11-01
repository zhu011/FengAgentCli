# dsh ↔ FengAgentCli 服务契约映射（P2–P3）

> 适用版本：`@deepseek-ai/dsh-*@0.1.0-rc.6`（与本机 dsh CLI 同版）。
> 实现：`packages/dsh-compat/src/{projection,sessions,agents,agent-default-model,services-plugin}.ts`；
> 工具面：`{adapter,exec-context,events,plugin}.ts`。
> 本文与 `DSH_SERVICE_CAPABILITIES`（`src/services-plugin.ts`）必须同步修改——
> 表里的每一行都能在代码里找到同名 `path`，反之亦然。

## 0. 一句话结论

两边都是 Cordis 4.0.1 插件体系，**插件形状天然互通**；真正的差异在**事实源**：

| | dsh | FengAgentCli |
|---|---|---|
| 会话事实源 | append-only `SessionEvent[]`（事件溯源） | `Message[]`（SQLite `sessions` / `messages`） |
| agent 创建 | loop 实现 `AgentFactory`，registry 持有 live agent | `ctx.loop.run(session)` 按会话跑回合，没有「创建即启动」的工厂面 |
| 作用域 | `ctx.agents.withInitiator` + `dsh-scope` 的 scope tag | 无（P3 才做 scope） |

所以 P2 的映射原则是：**能等价的直通（direct）、能投影的标注偏差（adapt）、
不能的明确抛错（unsupported）**。绝不做「调用了但没生效」的静默降级。

## 1. 能力分级

| tier | 含义 | 调用方应如何处理 |
|---|---|---|
| `direct` | 与 dsh 语义等价，落库/身份无偏差 | 正常使用 |
| `adapt` | 可观察结果等价，但事件粒度/身份/持久化有**已知且已文档化**的偏差 | 可读；写入路径需确认偏差可接受 |
| `unsupported` | 无法在不伪造事实的前提下实现 | 装配前 preflight 拒绝，或捕获 `DshContractUnsupportedError` |

`unsupported` 一律抛 `DshContractUnsupportedError`，带 `code: "dsh_contract_unsupported"`
与 `contract` 路径；参数错误抛 `DshContractError`（`dsh_contract_invalid`）。

## 2. `ctx.sessions`

| dsh 成员 | tier | FengAgentCli 侧 | 偏差/说明 |
|---|---|---|---|
| `get(id)` | direct | `StorageService.loadSession` | 返回缓存的同一视图对象（身份稳定） |
| `list()` | adapt | `StorageService.listSessions` + 逐条 `loadSession` | 列表元信息来自 `sessions` 表；每条都要读消息，N 条 = N 次查询 |
| `create(id?, {meta})` | adapt | `StorageService.saveSession` | 只支持空 `seed`；`meta.cwd` 校验绝对路径且只存在**内存 header**（sessions 表无此列）；`seedSource:'persistence'` 不支持 |
| `fork(src, boundary?, id?)` | adapt | `loadSession` + `saveMessages` | **消息 id 必须重发**：`messages.id` 是全局主键，沿用会 `INSERT OR REPLACE` 改写源会话的行；`boundary` 是投影后的 seq，经 `messageBoundaryForSeq` 换算成消息下标 |
| `flush(session)` | direct | `StorageService.flush` | 会话行是逐条同步写；这里刷的是图存储 |
| `prepare/enter/announce` | unsupported | — | dsh 的「未发布创建事务」在 FengAgentCli 没有对应物；创建就是一次存储写 |

### 2.1 `Session` 投影面

| dsh 成员 | tier | 说明 |
|---|---|---|
| `session.id` | direct | 会话 id |
| `session.header` | adapt | `{version:1,id,createdAt}` + 内存 meta（cwd/parentSession/seedLength/origin/delegationDepth） |
| `session.events` | adapt | 消息的**有损投影**，见 §4 |
| `session.append(type, data)` | unsupported | 写路径是 `saveMessage(s)`；伪造成事件会丢数据 |
| `session.requestHeader()` | adapt | 恒为 `undefined`——dsh 侧该返回值本身合法（没有 header 事件时） |
| `session.surface` | unsupported | 投影不带 `surfaceOp` / `sourceEventSeqs`，推不出顺序 surface |

## 3. `ctx.agents`

| dsh 成员 | tier | 说明 |
|---|---|---|
| `get/list/roots` | direct | 进程内 registry；`roots` = `owner === undefined` |
| `register/enter/announce` | direct | `enter` 记录 owner 且 `announced=false`，`announce` 校验 exact entry（与 dsh 的重复发布检查一致） |
| `isOwnedBy` | direct | 比较 owner 身份（不是会话血缘） |
| `setFactory` | direct | 单槽位；重复注册抛错；disposer 清槽 |
| `create(options)` | unsupported* | **未注册 factory 时抛错**；注册了则原样委托 `factory.createAgent(ctx, options)` |
| `resume(options)` | unsupported* | 先校验目标会话存在，再委托 `factory.resume` |
| `withInitiator/withoutInitiator` | direct | `AsyncLocalStorage`：只做进程内因果归因，不做鉴权/liveness 证明 |
| `currentInitiator/requireInitiator` | direct | 无边界时 `current` 返回 `undefined`，`require` 抛 `DshContractError` |

\* `create/resume` 的分级取决于宿主是否注册了 factory。P2 交付**不含**
loop → `AgentFactory` 的桥（属于 P4）：FengAgentCli 的 `ctx.loop` 需要先有
`Session` 才能 `run`，而 dsh 的 factory 契约是「创建会话 + agent + 启动 loop」的
组合事务。硬桥会造出一个「有 agent 但没有驱动」的假对象，所以选择显式缺失。

## 4. 事件投影：为什么是 adapt 而不是 direct

`projectSessionEvents(messages)` 的输出：

```
user 消息（text/thinking/image）      → user/message
user 消息里的 tool-result 块（每个）  → tool/result
assistant 消息（text/thinking/tool-use）→ assistant/message
system 消息                            → 跳过（dsh 走 request/header）
```

已知偏差（**消费方必须知道**）：

1. **seq 不稳定**：投影是派生视图，追加消息会让后续 seq 整体位移。dsh 的 seq 是
   持久日志的稳定身份；任何把 seq 长期保存/跨进程比对的 dsh 插件在这里都不安全。
2. **没有 chunk / lifecycle**：无 `assistant/chunk`、`turn/start|end`、`step/start|end`、
   `request/header|context`、`session/end-seed`。`turn`/`step` 是合成值（每条 user
   消息一轮、step=1），只满足读字段的形状，**不可作为因果依据**。
3. **没有 `surfaceOp`**：dsh 的 surface 是折叠产物；这里没有。
4. **image 块丢弃**：dsh 用 attachment 引用，FengAgentCli 内联 base64，无等价物。
5. **消息 id 保留在事件里**（`user/message`/`assistant/message` 的 `message.id` 即
   `messages.id`），但 `fork` 之后子会话会重发 id（见 §2）。

### 4.1 因此哪些 dsh 插件能装

| dsh 插件 | inject | 判定 | 原因 |
|---|---|---|---|
| `dsh-llm-retry` | `agents` | ❌ 暂不可用 | 只用 `ctx.on('agent/request-error')`，事件由 dsh loop 发；FengAgentCli loop 不发该事件（P3 的 llm 面） |
| `dsh-time-context` | `agents` | ❌ 暂不可用 | 依赖 `agent/pre-step` 扩展点与 `agent.session.events` 的 turn 语义 |
| `dsh-session-title` | `sessions` | ⚠️ 只读部分可用 | `get()` 能读投影；`rename/refresh` 走 `session.append('session/title')`，必抛 |
| `dsh-session-persistence-jsonl` | `sessions` | ❌ 不可用 | 监听 `session/event` / `session/flush` 并写事件日志——事实源冲突 |
| `dsh-session-query*` / `-telemetry-otel` | `sessions` | ❌ 不可用 | 读 `session.events` 的稳定 seq 与 surface |
| `dsh-plugin-writing-guard` | `tools` | ✅ 工具 + 审计都可用 | 工具走 P1；`tools/pre-execute`/`post-execute` 审计经 §5.5 事件桥触发（宿主需把 `HookRegistry` 传给插件 `hooks`）；原生 `file-write`/`file-edit` 经名称映射（§5.5.2）也进自动审计 |
| `dsh-tool-todo-plus` | `tools` + `sessionProjections` | ❌ 仍不可用 | ① `sessionProjections` 不在 rc.6 契约（该插件面向 dsh 0.2.x）；② 工具写会话走 `exec.agent.session.append`，仍是 unsupported——但现在报 `dsh_contract_unsupported`，不再是 `TypeError` |
| `dsh-better-edit` | `tools` + `systemPrompt` + `fs` | ❌ 仍不可用 | npm 包漏声明 `@deepseek-ai/dsh-fs` peer；`systemPrompt`/`fs` 服务面属 P3 |
| tools-only 插件（P1） | `tools` | ✅ 可用 | 见 `packages/dsh-compat/README.md` |

结论：**P2 让「服务面能解析、能读、能显式失败」成立，但还不能让事件溯源型 dsh
插件真正工作**。真正的互操作要等 P3（llm/scope 扩展点）+ P4（FengAgentCli 插件进
dsh、群能力抽插件），届时事件桥才可能把 `session.append` 落到真实日志。

## 5. `ctx.agentDefaultModel`

| dsh 成员 | tier | 说明 |
|---|---|---|
| `currentSelection()` | direct | 读 `ctx.model.provider/model`；无模型服务时用构造期 fallback |
| `saveSelection(next)` | adapt | 调 `ctx.model.switchProvider(provider, {model})` 热切换；dsh 还会写 settings 层，FengAgentCli 由配置文件/调用方负责；`reasoningEffort` 接受但忽略 |

## 5.5 工具执行上下文与 dsh 事件桥（P2 第二批）

市场插件实测暴露的两个缺口在**工具面**补齐，不改服务面契约。

### 5.5.1 `exec` 上下文（`src/exec-context.ts`）

dsh 工具体签名是 `execute(args, exec)`；P1 只传了 `{ signal }`，于是读 `exec.agent`
的工具（todo-plus 一类）在 execute 阶段直接 `TypeError`。现在每次调用构造一份完整 `exec`：

| 成员 | 来源 | 偏差 |
|---|---|---|
| `callId` / `rootCallId` | `feng:<messageId>:<tool>:<seq>` | 进程内唯一；没有 dsh 的 transport 嵌套，故两者相等 |
| `token` | 每次调用一个新 symbol | 不透明调用身份，**不是**鉴权 token |
| `name` / `arguments` | 工具名 / 深冻结入参快照 | 与 dsh 的冻结语义对齐 |
| `signal` | `timeoutMs` 驱动的 AbortController | 与 P1 一致 |
| `agent` | `ctx.agents.get(sessionId)` → 回落 `ctx.sessions.get(sessionId)` 的只读投影 | 没有 agent 时**不伪造**，保持 `undefined`（dsh 允许） |
| `deferContext()` / `concludeTurn()` | 记录在 `exec.deferredContexts` / `exec.concludedTurn` | FengAgentCli 的 `ToolResult` 没有 `additionalContexts` 通道、loop 没有「本回合结束」标记 → 仅记录 + 可选回调，**不会自动生效** |

### 5.5.2 事件桥（`src/events.ts`）

| dsh 事件 / 决策 | FengAgentCli 侧 | 偏差 |
|---|---|---|
| `tools/pre-execute` → `allow` | 继续执行 | — |
| `tools/pre-execute` → `deny` | `{allowed:false, reason}`（阻止执行） | — |
| `tools/pre-execute` → `ask` | **转 deny** | hook 阶段没有审批服务；放行会绕过审批 → fail-closed |
| 监听器不调 `next()` | 视为 `deny` | 与 dsh waterfall 语义一致 |
| 监听器抛错 | 记警告 + 按 `allow` 继续 | 审计插件不能把工具执行带崩 |
| `tools/post-execute` → `accept` / `accept+content` | 保留结果 / 替换展示文本 | 只换文本，不动 canonical value |
| `tools/post-execute` → `block` | 结果转 `isError` + feedback 文本 | 与 dsh「纠错反馈转错误结果」一致 |
| `tools/execute`（包裹执行） | 不实现 | 超时已由适配器 `timeoutMs` 覆盖；重试/指标类插件需要 P3 |
| `tools/result` / `tools/change` | 不发 | 只读观察面，等 P3 |

双向接线：

- **dsh 工具**：适配器自己发 `pre → 工具体 → post`，三段共享**同一份 exec**
  （token/agent 一致），不经钩子路径；
- **原生工具**：宿主把 `HookRegistry` 传给 `dshCompatPlugin` 的 `hooks`（或注册成
  `hooks` 服务），桥注册一对 pre/post 钩子，把原生工具的执行也翻译成 dsh 事件，
  并把 dsh 侧决策映射回 `{allowed, reason}` / 错误结果；
- 适配器接管的工具名在钩子路径上被跳过（`markDshTool`），**同一次调用不会发两遍**；
- 原生工具的 `exec.signal` 是永不 abort 的信号（feng 执行器不把取消面暴露给 hook）。

#### 名称映射（原生文件工具）

dsh 生态插件按 dsh 的工具名识别语义：`dsh-plugin-writing-guard` 的 `targetPathOf`
只认 `exec.name === "write" | "edit"`，而 FengAgentCli 原生工具叫
`file-write` / `file-edit`。桥在**原生工具**的钩子路径上按
`DEFAULT_NATIVE_TOOL_ALIASES` 映射名字，并把相对 `filePath` 按 hook 的 `workdir`
归一成绝对路径（writing-guard 直接 `fs.readFile(target)`，相对路径会按进程 cwd
解释，preimage 会读空、审计被静默跳过）：

| 原生工具 | 事件里的 `exec.name` | `exec.arguments.filePath` |
|---|---|---|
| `file-write` | `write` | 相对路径 → `resolve(workdir, filePath)` |
| `file-edit` | `edit` | 同上 |
| 其他原生工具 | 原名字 | 原样 |

- `callId` 里仍保留原生工具名（`feng-hook:<messageId>:file-write:<seq>`），便于回溯；
- 映射只影响事件面，FengAgentCli 内部注册/审批/展示仍用原生名；
- 需要覆盖或追加别名时给 `dshCompatPlugin` 传 `toolAliases`（在缺省映射之上合并），
  所以 `toolAliases: {}` 不会关掉缺省两条。

## 6. 装配与 preflight

```ts
import { createHookRegistry } from "@fengagent/tools";
import { dshCompatPlugin, applyDshServices } from "@fengagent/dsh-compat";

const hooks = createHookRegistry(); // 与 createToolExecutor 用同一个实例

createRuntime({
  workdir: ".",
  plugins: [
    { id: "feng.storage", config: { dbPath } },
    // P1 + P2 工具面：exec 上下文 + 事件桥（hooks 给了就双向接）
    { id: dshCompatPlugin, config: { hooks } },
    { id: applyDshServices },               // P2：sessions/agents/agentDefaultModel
    { id: "some-dsh-plugin" },
  ],
});
```

> `hooks` 也可不传：此时只有 dsh 工具自己发 `tools/*` 事件，原生工具的执行
> 不会出现在 dsh 事件里（审计插件只能看见 dsh 工具）。装配处顺手
> `ctx.reflect.provide("hooks", hooks)` 也能被自动发现。

preflight（宿主可放在插件加载器里）：

```ts
import { DSH_SERVICE_CAPABILITIES, DshContractUnsupportedError } from "@fengagent/dsh-compat";

const blocked = DSH_SERVICE_CAPABILITIES.filter((c) => c.tier === "unsupported");
// 按插件实际调用的成员判断是否放行；不要在装配期假装全绿。
```

## 7. `ctx.llm`（P3，`src/llm.ts`）

dsh 的 `llm` 是「适配器注册表 + 可被 `llm/stream` 瀑布拦截的流式调用」；FengAgentCli
侧是 `ctx.model`（`@fengagent/llm` 的 `ModelService`，单条活跃路由 + `LLMEvent` 流）。
映射为 **adapt**：

| dsh 成员 | FengAgentCli | 分级 | 说明 |
|---|---|---|---|
| `stream(options)` | 注册适配器直通 / 回落 `ModelService.stream` | adapt | 失败统一收敛为终态 `finish{kind:'error'|'aborted'}` |
| `registerAdapter` | 路由表（独占 + disposer + `replace` 原子换路） | direct | 与 dsh 的 all-or-nothing 语义一致 |
| `listProviders` | 当前模型路由 + 已注册路由 | direct | 适配器 `providerInfo` 生效 |
| `providerRetryPolicy` | 默认 normal 策略 / 适配器覆盖 | adapt | 只保存与回报；重试执行仍由 `dsh-llm-retry` |
| `listModels` / `resolveModelInfo` | 适配器委托；回落只报当前 model 身份 | adapt | 无 context/reasoning 元数据 |
| `prepareCall` | config 冻结 + 单次派发 | adapt | `INVALID_PREPARED_CALL` 语义；不物化 adapterDefaults |
| `registerConfigurableProviders` / `registerModelDiscovery` | — | unsupported | 需要 settings 命名空间与配置 UI 面 |

**消息与内容块**（`src/messages.ts`）：`text ↔ text`、`reasoning ↔ thinking`、
`tool-call(args 原始 JSON) ↔ tool-use(input 已解析)`、`tool-result(块数组) ↔ tool-result(文本)`；
消息 **id 跨边界保留**（dsh `MessageId` 稳定身份 = 我们的 `messages.id` 主键）。
图片块两个方向都没有等价物（dsh 是 attachment 引用、我们是 base64 inline），严格模式抛
`DshContractError`、宽松模式返回 loss 清单，不塞假文本。

已知偏差：

- `GenerateOptions.tools` 是 JSON Schema，`ToolDefinition` 要 zod schema →
  宿主必须注入 `LlmCompatOptions.toolSchemaConverter`；没注入时带 tools 的请求直接
  以 `dsh_contract_unsupported` 终态失败（不静默丢工具让模型「看不见工具」）；
- `stop` 序列无对等字段（`LLMRequest` 不含 stop），接受但忽略；
- `reasoningEffort` 仅在注册适配器路径透传；回落路径忽略；
- `tool-result` 事件（loop 内部回填）在 dsh 流协议里没有对应 chunk，桥不发。

装配：`dsh-services` 在 `ctx.model` 可用时 `provide("llm", LlmCompat)`；模型缺失时
`llm` 仍在位，调用期以 `NO_ADAPTER` 终态失败（装载期不炸）。

## 8. `scope`（P3，`src/scope.ts`）

**结论：direct，零翻译。** `scope` 不是 Cordis 服务——它是 `@deepseek-ai/dsh-scope`
的库级原语（`createScope` / `scopeOf` / `scopeTarget` / `bindScopeParent` / `ScopedLayers`），
跑在同一条 Cordis 4 运行时上。兼容层**直接重导出上游模块**：

- 保证与 dsh 插件内部 `import { scopeOf } from "@deepseek-ai/dsh-scope"` 是**同一份模块
  实例、同一套标签 symbol**——自己再实现一份会让两边互相看不见标签，是最容易「假装
  兼容、实际静默失效」的地方；
- 额外提供接线：`scopeKeyForSession(sessionId)`（进程内稳定同一把 key）、
  `createAgentScope(ctx, { sessionId, parent })`、`scopeKeyOf` / `isScopedContext`。

已验证（真 `createRuntime` 根上下文，非 stub）：标签随 `extend()` 继承、`dispose()`
幂等且真释放其下 effect、父子链顺序与循环拒绝、`scopeTarget` 的准入方向（祖先监听器
收后代事件，祖先事件不下发给后代）。

**留 P4**：把 `tools/pre-execute` / `tools/post-execute` 发到 scope 载体上，让每个 agent
的审计插件只看到自己 agent 的事件（当前事件桥发全局事件，单 agent 场景等价，多 agent
并存时会串台）。

## 9. 服务面清单（P3 采样，`src/service-inventory.ts`）

对 4 个 agent preset 去重出的 29 个插件包 + 25 个宿主/核心包 + 4 个市场插件逐包读
`inject` 后聚合（`DSH_SERVICE_INVENTORY`，可按分级做 preflight 诊断）：

| 服务 | 必需 | 可选 | 软读 | 分级 |
|---|---|---|---|---|
| `tools` | 23 | 0 | 1 | mapped |
| `systemPrompt` | 15 | 2 | 0 | trivial-shim（下一批最高性价比） |
| `sandboxPolicy` | 2 | 0 | 6 | out-of-scope（宿主沙箱） |
| `agents` | 4 | 1 | 2 | mapped |
| `fs` | 3 | 0 | 3 | trivial-shim |
| `sessionProjections` | 1 | 5 | 0 | needs-design（todo-plus 硬门槛） |
| `sessions` | 2 | 0 | 2 | mapped |
| `subagents` | 4 | 0 | 0 | needs-design |
| `jobs` / `skills` / `tokenMeter` / `workflowEngine` / `terminals` | 1–2 | 0 | 0–3 | needs-design |
| `llm` | 1 | 0 | 1 | **p3（本轮）** |
| `commands` / `settings` / `attachments` | 0–1 | 0–1 | 0–2 | trivial-shim |
| `shell` / `shellEnv` / `subprocess` / `web` / `approval` / `userQuestions` / `typert` | 0–2 | 0 | 0–7 | out-of-scope（宿主面） |

排期建议：`systemPrompt → fs → settings → skills → sessionProjections → llm 的消费者`
（`llm` 唯一硬依赖 `compaction-basic` 同时要 `tokenMeter`+`sessions`，先把投影面补上更划算）。

采样注意：npm 的 `latest` tag 对多数 `@deepseek-ai/dsh-*` 陈旧（停在 0.0.1-rc.1），
preset 实际用 0.1.0-rc.8——不 pin 版本会读到错误的 inject 结构。

市场插件现状：`writing-guard` / `notes` 只需 `tools`（现成可跑）；`todo-plus` 硬要
`sessionProjections`；`better-edit` 要 `systemPrompt`+`fs`，并按 `systemPrompt.getSectionOrder`
排段（shim 需实现该可选方法，否则回退编译期默认顺序）。

## 10. 升级 dsh 版本时的复核清单

1. `dsh-session` 的 `SessionStore` 方法集合是否变化（本文件 §2 表）；
2. `dsh-agent` 的 `AgentRegistry` 方法集合是否变化（§3 表）；
3. `SessionEventMap` 的 surface 事件类型是否仍是 `user/message | assistant/message | tool/result`（§4）；
4. `dsh-agent-default-model` 的 `ModelSelection` 是否新增必填字段（§5）；
5. `dsh-tools` 的 `ToolRunContext` / `PreToolDecision` / `PostToolDecision` 是否变化（§5.5）；
6. `dsh-llm` 的 `StreamChunk` / `GenerateOptions` / `LlmRuntime` 方法集合是否变化（§7）；
7. `dsh-scope` 的导出集与 `Context.filter` 口径是否变化（§8）；根级 peer 矩阵里
   `dsh-scope` 与 `dsh-llm` 是否同版本；
8. 重跑服务面采样（`DSH_SERVICE_INVENTORY`），确认 `inject` 分级没有被新版翻转；
9. 跑 `bun test packages/dsh-compat`，再跑全量 `bun test`。
