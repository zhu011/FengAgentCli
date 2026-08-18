# AGE-31 分支解读：架构选型对比（Part 2）

> 本文件回答 issue AGE-31 的第二部分：`main` 与 `refactor/cordis-graph-architecture` 两个分支的架构选型全面对比（相同点 / 不同点 / 优劣）。
> 配套文件 `AGE-31-模块解读.md` 为第一部分（模块解读与端到端参与）。

---

## 1. 一句话总结

`main` 是**命令式直接装配的线性会话架构**：一个工厂函数把各模块硬编码组装成 Agent，会话是一条消息列表，稳定、简单、易读。

`refactor/cordis-graph-architecture` 是**声明式插件化的图/事件溯源架构**：所有能力经 Cordis 元框架（Context/Service/Plugin/DI）插件化装配，对话沉淀为可溯源、可回退的节点图，状态以 append-only 事件日志为准（双写过渡 → 事件为准重建）。

---

## 2. 相同点

| 维度 | 说明 |
|---|---|
| 工程形态 | 同为 Bun + TypeScript monorepo（workspaces `packages/*`），同入口 `bin/fengagent` |
| 领域契约 | `@fengagent/core` 的类型/接口契约完全一致（Message/Session/AgentEvent/ToolDefinition/Config/权限三态） |
| 既有模块实现 | agent/llm/tools/context/shared/cli/server/web-ui/eval 的实现与行为一致；新分支用薄适配器包裹，**不重写** |
| 功能面 | CLI（TUI/print/serve）、WebUI、MCP、权限审批、记忆、上下文压缩、子 Agent/Squad、/model、/provider、/export、/restore、/session、测评、kvCache 全部保留 |
| AgentLoop 核心循环 | 两分支同一套循环语义：assemble → compact → LLM 流式调用 → 工具执行 → 回填 → 续跑 |
| 工具/权限模型 | 同一套 ToolRegistry/ToolExecutor/权限检查/Hook 机制 |
| 测试基线 | 新分支承诺既有 600+ 测试全绿 + 新包测试，类型检查全绿 |
| 配置分层 | 同为 config.json + 环境变量分层加载（新分支增加数据根级 config.json 覆盖） |

---

## 3. 不同点（核心差异）

| 维度 | main（老架构） | refactor/cordis-graph-architecture（新架构） |
|---|---|---|
| **装配方式** | 命令式：`createAgent()` 工厂按固定顺序 new 出所有依赖 | 声明式：`createRuntime()` 按插件清单装载，Cordis 依赖注入，顺序无关（`inject: [...]` 声明依赖，就绪才启动） |
| **扩展性** | 换能力 = 改工厂代码；仅支持运行时 agent 定义（`.fengagent/agents/` 声明式）与钩子 | 换插件即换能力（把 feng.loop 换成 Graph 编排器、feng.strategy 换成 LLM-as-judge 策略，其余不动）；支持用户插件（模块路径加载，Phase 5 规划 cordis.yml profile） |
| **会话模型** | 线性消息列表（messages 数组 + SQLite 整存） | 图模型：每轮对话沉淀为 ConversationNode（parent/children + model/工具/token/trace 溯源 meta），活跃路径 + 分支可回退 |
| **状态持久化** | 状态型：SQLite sessions.db 直接读写（写时覆盖） | 事件溯源：append-only JSONL 事件日志（seq + hash 链 + 注册表校验），生产期 SQLite 双写过渡，投影/重建以事件为准，对账保证一致 |
| **可回退/可审计** | 无（历史不可分叉） | `/rollback` 回退到任意节点 → 长 branch-point，旧分支作废但不可变保留，全链路可溯源（llmTraceId 关联 trace 日志） |
| **数据根隔离** | `.fengagent/` | `.fengagent-cordis/`（resolveDataRoot 收口）；main 数据只读（导入源/配置回退），两分支同机互不干扰 |
| **Server/WebUI** | 会话级 REST/SSE | 新增 `GET /:id/graph`、`POST /:id/rollback` + graph-panel 分支可视化（活跃高亮/回退按钮/作废灰显） |
| **CLI 命令** | /help /exit /clear /com /compact /export /restore /session /tool /model /provider | 上述全部 + `/graph`、`/rollback [节点id]` |
| **依赖策略** | 正常 npm 依赖 | 新包 vendor 内置 `@deepseek-ai/cordis` + `cosmokit` + `standard-schema-spec`（离线可用，网络可用后可切回 npm） |
| **文档** | ARCHITECTURE.md / MODULES.md / GUIDE.md | 新增 ARCHITECTURE-CORDIS.md / GUIDE-CORDIS.md（两分支文档互指、标注分支归属） |
| **迁移工具** | 无 | `scripts/events-migrate.ts`：list / verify / export / import / rebuild（跨数据根、跨机迁移端到端） |

---

## 4. 优劣对比

### 4.1 main（命令式线性架构）

**优点**
- 简单直接：一个工厂函数看懂全部装配，依赖关系显式、无魔法；
- 心智负担低：会话 = 消息数组，调试/推理直观；
- 无额外运行时依赖，构建体积小、启动快；
- 稳定成熟：长期作为主分支，功能回归风险低。

**缺点**
- 扩展性受限：换模型/换存储/换循环策略都要改工厂代码（或依赖钩子），"换能力"成本高；
- 会话不可分叉：回答不佳只能整段重来，无溯源、无审计、无分支；
- 状态写时覆盖：SQLite 直接覆盖写，历史不可还原，跨机迁移只能整体拷贝；
- 上下文/策略/工具选择耦合在 AgentLoop 内，难以单独替换。

### 4.2 refactor（插件化 + 图/事件溯源架构）

**优点**
- 可插拔：一切皆插件，换插件即换能力，插件顺序无关（声明式 DI）；
- 可溯源可回退：对话即节点，任意节点可还原完整溯源链（谁触发/什么模型/调了哪些工具/质量如何）；回答不佳可回退到目标节点长新分支，旧分支不可变保留（可审计）；
- 事件溯源：append-only 事件日志是事实来源，支持导出/导入/重建/对账，跨机迁移与崩溃自愈能力强（hash 链校验 + 半行自愈 + 幂等去重）；
- 数据根隔离：与 main 同机运行互不干扰，可随时回退老分支；
- 渐进式演进：Phase 1–4 每期可合入、可回退，薄适配既有实现，回归风险被测试兜底。

**缺点**
- 复杂度显著上升：三写（SQLite + 事件日志 + 图投影）+ 对账 + 重建，概念多、排查链路长；
- 依赖 vendor 运行时：内置 cordis 第三方库，升级/安全更新路径不清晰（虽声明未来可切 npm）；
- 双写一致性有代价：双写期间以 SQLite 为主读，事件日志为辅，需要 reconcile 持续对账，删除/回退等破坏性操作语义复杂（分支感知投影才支持）；
- 图/事件机制在单机单用户场景可能属于"过度设计"（为多 Agent 编排、审计、迁移等长期目标买单）；
- 性能：每回合多一次事件落盘 + 图节点维护，I/O 与内存开销略增。

---

## 5. 结论与选型建议

- **当前阶段**：新分支在功能覆盖上与 main 完全对等（薄适配 + 全量测试兜底），并新增了插件化、对话溯源、回退、事件迁移四类能力，是明确的演进方向；main 作为稳定基线继续维护，符合"每期可合入、可回退"的节奏。
- **风险点**：新架构的价值在"多 Agent 编排、审计合规、跨机迁移、策略热替换"等场景才完全释放；若项目短期仍以单机单用户 CLI 为主，main 的简单性仍具竞争力——建议按需合入，不必急于全量迁移。
- **后续关注**：Phase 5 用户插件 profile（cordis.yml）、双写期结束（以事件为准单一事实源）、vendor 依赖的 npm 化。

---

## 6. 参考

- `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE-CORDIS.md`（两分支各自的架构文档）
- `docs/MODULES.md`（模块文档，main）
- 重构设计灵感来源：deepseek-harness 项目深度解读、图解 Graph Engineering（见 ARCHITECTURE-CORDIS.md §1）
