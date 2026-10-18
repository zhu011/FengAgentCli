# AGE-29 · RSI 首期交付记录（P0 自省卡 + P1 验证闸）

范围：阶段 1（P0 自省卡）+ 阶段 2（P1 测试集执行器 / 最小变更器 / 验证闸）。
分支：`refactor/cordis-graph-architecture`，交付提交 `6cddd5a`（基于 `ba5c61d`）。

## 一、这一期到底补了哪两段断链

交付前（`ba5c61d`）的实测口径：

1. 评测结论只落 Markdown 报告（`optimizations/optimization-{date}.md`），**没有任何运行时
   路径消费它去影响下一轮对话**；
2. `--judge` 的测试集只被**列名**（`eval/index.ts` 只打印 `testset.name(...)`），judge 评
   的是 trace 里的历史会话 —— **用例从未被执行过**，因此也就谈不上「改进有没有效」。

本期：

- **P0** 把「judge 失败 / 防护闸 / 测试失败 / 人工负反馈」变成**带证据的自省卡**，
  经硬预算注入下一轮系统提示（Reflexion 式闭环，越过 B0→L1 的持久化边界）；
- **P1** 让用例**真的被执行**（隔离会话 + trace + 判分），并用 **A/B 双集验证闸**决定
  写回是否生效：不劣于基线才 adopted，否则回滚 + 拒绝留痕。

## 二、落点与机制

### 2.1 P0：证据 → 卡 → 注入

| 环节 | 文件 | 关键点 |
|---|---|---|
| 类型 + 事件词汇 | `packages/core/src/reflection.ts` | `ReflectionCard`（`revision` 乐观锁）、`REFLECT_EVENT_TYPES`（created/updated/injected/expired/adopted/rejected）、`hasReflectionEvidence` / `isReflectionInjectable` / `reflectionRank` |
| 存储 | `packages/agent/src/reflection-store.ts` | `reflections` + `reflection_events`；`create` 走证据门（无证据抛 `evidence_required`），`ingest` 无证据返回 `null`；`transition` 用 `UPDATE ... WHERE id=? AND revision=?`（changes=0 → `stale_revision`）；`expireDue` 做 TTL 清理并留痕；`recordInjection` 写回 `effect.injectedCount` |
| 注入 | `packages/context/src/reflection.ts` | 排序 = 严重度（unsafe 100 / human_negative 90 / judge_failed 80 / test_failed 70 / guard_tripped 60）× 证据数 × 新近度；硬预算 ≤5 条 / ≤600 token；超出时「截断该卡 lesson（留省略号）」或「剩余 < 40 token 直接丢弃」 |
| 装配 | `packages/server/src/create-runtime-agent.ts`、`packages/cli/src/acp-mode.ts` | 每轮重载重新取可注入卡；store 异常降级为无卡，不打断主循环 |
| 卡从哪来 | `packages/eval/src/reflect-cards.ts` | `failed/partial/tool_misused/inefficient → judge_failed`，`unsafe → judge_unsafe`；judge **调用失败**（`LLM_FAILURE_NOTE_PREFIX`）不入卡 |

开关与数据落点（`packages/shared/src/reflect-env.ts`）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `FENG_REFLECT_INJECT` | `on` | `off` 一键关（自省卡 + overlay 两段都不注入） |
| `FENG_REFLECT_MAX_CARDS` | 5 | 注入条数上限 |
| `FENG_REFLECT_MAX_TOKENS` | 600 | 注入 token 上限 |
| `FENG_REFLECT_TTL_MS` | 14 天 | 卡片存活期 |

`<数据根>/reflect/reflections.db`

### 2.2 P1：执行器 / 变更器 / 验证闸

- `packages/eval/src/runner.ts`：`TestCase → 隔离会话（每用例新建 Agent）→ 采 trace（步数 /
  工具调用 / token / 耗时 / 最终文本）→ 判分 → {caseId, passed, score, traceRef}`；
  `traceDir` 落 `*.trace.json`；`failed / unsafe / tool_misused` 或低于阈值一律 fail；
  成本 / 耗时超限即中止（`aborted` + `abortReason`）。
- `packages/eval/src/mutator.ts`：唯一写回落点 `<数据根>/reflect/prompt-overlay.md`；
  `AGENTS.md`、代码文件、路径逃逸、非 `system-prompt` 落点都在**写盘之前**抛
  `write_boundary_violation`；同一条教训幂等追加；回滚是内容级恢复（原来不存在 → 删掉）。
- `packages/eval/src/gate.ts`：held-in 与 held-out **都跑**；主指标（通过率、平均完成度）
  不得劣于基线（零容差）；护栏步数 ×1.5 / token ×1.5 / 耗时 ×2；单次实验成本上限；
  拒绝即回滚；采纳与拒绝都写 `<数据根>/reflect/experiments/<id>.json` + `experiments.jsonl`，
  `listExperiments(dataRoot, { verdict })` 可查。
- 写回生效那一跳：`loadSystemContext` 读 `prompt-overlay.md` 注入「本项目学到的规则」
  （与自省卡共用 `FENG_REFLECT_INJECT` 开关）。

## 三、验收证据

### 3.1 全量测试与类型检查（refactor）

```
bun run typecheck              → 0 error
bun test                       → 1255 pass / 0 fail / 91 files（31s）
```

交付前基线 `ba5c61d`：1150 pass / 0 fail / 83 files。本期新增 8 个测试文件、105 条用例。

### 3.2 逐条对验收契约（claude大哥 的 A1–A8 / B1–B7）

| 契约项 | 对应测试 |
|---|---|
| A1 证据门（无证据 → 0 行） | `core/reflection.test.ts`「证据为空数组 → 拒绝」；`agent/reflection-store.test.ts`「ingest 返回 null，库里 0 行」 |
| A2 注入预算 ≤5 / ≤600 + 截断规则 | `context/reflection-inject.test.ts`「6 条只注入 5 条」「超长卡被截断」「预算极小不注入」 |
| A3 TTL | `core`「TTL 到期不可注入」；`agent`「expireDue 置 expired 并留痕」 |
| A4 `FENG_REFLECT_INJECT=off` | `context`「off → 注入为 0，其余内容不变」；`server/reflect-loop.test.ts` 同口径 |
| A5 乐观锁 | `agent`「用旧 revision 并发写 → stale_revision，不静默覆盖」 |
| A6 事件流复原闭环 | `agent`「证据 → 卡 → 注入」事件序列断言；`server`「reflect/injected 可复原」 |
| A7 作用域隔离 | `agent`「按 scopeKey 过滤不串库」 |
| A8 降级 | `context`「注入抛错 → 降级为无卡」；装配点 try/catch |
| B1 真跑 / 负面用例必 fail | `eval/runner.test.ts` + `server/reflect-loop.test.ts`（真 AgentLoop，步数/token 来自真实事件流） |
| B2 写回边界只写 overlay | `eval/mutator.test.ts`（拒绝 AGENTS.md / 代码 / 逃逸 / 非 system-prompt） |
| B3 双集都过才 adopted | `eval/gate.test.ts`「held-out 回归 → 拒绝」「held-out 没跑 → 拒绝」 |
| B4 护栏 + 成本上限 | `eval/gate.test.ts`「步数/token/耗时护栏」「成本超限中止」 |
| B5 回滚（内容级） | `eval/gate.test.ts`「更差 → 回滚」「原 overlay 逐字符恢复」 |
| B6 拒绝留痕可查询 | `eval/gate.test.ts`「台账 rejected 可查」「experiments/<id>.json」 |
| B7 基线可比 / 报告原始指标 | `eval/runner.test.ts`「两次执行指标可比」；`gate.test.ts` 断言 baseline/candidate 原始分数 |

### 3.3 变异审计（M1–M8 全部红灯）

做法：备份目标文件 → 打入变异 → 跑定向测试 → 还原（脚本
`.multica/verify/mutation-audit.ps1`，日志 `.multica/verify/mutation-audit.log`）。

| 变异 | 弄坏什么 | 结果 | 红灯用例（节选） |
|---|---|---|---|
| M1 | A/B 比较方向反转（劣于也采纳） | RED | `compareGate 双集都不劣 → adopted`、`更差 → rejected` |
| M2 | 删掉 held-out 检查 | RED | `held-in 更好但 held-out 回归 → 拒绝` |
| M3 | 去掉证据门 | RED | `证据为空数组 → 拒绝`、`无证据卡不可注入` |
| M4 | TTL 永不过期 | RED | `TTL 到期不可注入` |
| M5 | 拒绝时不回滚 | RED | 4 条回滚用例全红（rejected / 成本 / 异常 / 逐字符恢复） |
| M6 | 去掉乐观锁 | RED | `旧 revision 并发写 → stale_revision` |
| M7 | 注入预算无上限 | RED | 3 条预算用例红（截断 / 合计超预算 / 极小预算） |
| M8 | 执行器只列名不真跑 | RED | 5 条 runner 用例红（逐条真跑 / 负面 / 异常 / trace / 成本） |

### 3.4 端到端演示（`packages/server/src/__tests__/reflect-loop.test.ts`）

真 Agent + 真 AgentLoop + 真 SQLite + 真 overlay 文件，只把 LLM 换成可编程 mock：

1. 造证据卡 → `contextManager.assemble()` 出现「过往教训」小节（含证据引用）；
2. 注入 → 卡片状态 `injected`，事件流 `created → updated → injected`；
3. 测试集真跑：每条用例都产生真实步数与 token，负面用例判 fail；
4. 验证闸：基线 vs 候选 → `adopted` → `prompt-overlay.md` 落盘 → **下一轮系统提示读到该规则**；
5. 候选回归 → `rejected` → overlay 回滚为「不存在」→ 台账可查；
6. `FENG_REFLECT_INJECT=off` → 卡片与 overlay 两段都不注入。

## 四、已知边界（诚实口径）

1. **main 分支未适配**：本期只在 `refactor` 交付；`main` 的适配与双侧全量测试由 KG 开发按
   排期执行（`packages/eval` 依赖新增 `@fengagent/core`，main 侧同包同文件结构，属同构适配）。
2. **推送未完成**：`git push` 在本机因凭据（`schannel SEC_E_NO_CREDENTIALS`）失败，提交留在
   本地，需可推送的环境执行。
3. **默认不自动触发**：本期不实现自治调度（阶段 4）——卡片生成与验证闸实验由调用方
   （`runEval` / WebUI 路由 / 人工）触发；`runVerificationGate` 是库级 API，尚未接 CLI 子命令。
4. **耗时护栏在墙钟上抖动**：e2e 测试显式放宽 `maxDurationRatio`，护栏逻辑本身由
   `gate.test.ts` 的确定性假数据覆盖。
5. **meta 层（阶段 3：版本化继承 / 结果记忆 / 阈值元学习）未做**：`revision` + 事件流 + 实验台账
   已经把「版本 / 效果」的数据结构准备好，但尚无版本注册表与阈值校准。
