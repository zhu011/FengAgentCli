# RSI 日常使用指南（评测产卡 → 对话自动注入教训）

> 面向**日常使用者**：怎么放测试集、怎么跑出「自省卡」、之后正常对话时这些教训怎么自动出现在系统提示里、怎么看它在不在生效、以及**哪些环节还没有一键入口**。
>
> 机制细节（为什么这么设计、状态机、验证闸判定规则）见 [EVALUATION.md 第四节](EVALUATION.md#四rsi-首期自省卡p0--验证闸p1)；本文只讲「怎么用」。
>
> 数据根：本分支（`refactor/cordis-graph-architecture`）默认 `.fengagent-cordis/`，`main` 分支为 `.fengagent/`，下文以「数据根」统称。解析优先级：`FENG_DATA_DIR` > 配置文件自定义 `dataDir` > `<workdir>/.fengagent-cordis`。

## 0. 一分钟版

```bash
# 1) 放一个测试集（每条用例 = 一个输入 + 一个期望输出）
#    <数据根>/testsets/my-set.json

# 2) 真跑测试集 → 按 judge 结论产「自省卡」入库
bun run eval --judge --max-cases=3

# 3) 之后正常对话（TUI / WebUI）—— 系统提示会自动带上「过往教训」
bun run dev

# 4) 想临时关掉注入
FENG_REFLECT_INJECT=off bun run dev     # PowerShell: $env:FENG_REFLECT_INJECT="off"; bun run dev
```

一句话边界：**「评测产卡 + 对话注入教训」现在开箱可用；「验证闸自动采纳并写回 prompt」还只有库级 API，没有 CLI 子命令**（详见第 6 节）。

## 1. 准备测试集

### 1.1 放在哪里

| 项 | 值 |
|---|---|
| 目录 | `<数据根>/testsets/` |
| 文件 | 该目录下**所有** `*.json`（递归不生效，只看一层） |
| 排序 | 按测试集 `name` 字典序依次执行 |
| 关联入口 | WebUI「🧪 评测」页的测试集清单读的是同一目录 |

数据根本分支默认是工作目录下的 `.fengagent-cordis/`，即：

```
D:\AgentCode\FengAgentCli\.fengagent-cordis\testsets\my-set.json
```

想换位置（例如为某次实验单独隔离数据）就用 `FENG_DATA_DIR` 指过去，测试集、卡片库、trace 都会跟着走。

### 1.2 JSON 结构（宽容解析，精确口径）

加载器是 `packages/eval/src/testset.ts` 的 `parseTestSet()`，字段名做了宽容兼容：

| 层级 | 接受的写法 | 说明 |
|---|---|---|
| 顶层 | 对象 `{ "name": "...", "cases": [...] }`，或**裸数组** `[ {...}, ... ]` | 裸数组时 `name` 取文件名 |
| 用例数组字段 | `cases` / `items` / `tests` / `examples` / `test_cases`（按此顺序取第一个数组） | 取不到即 `invalid` |
| 单条用例的输入 | `input` / `prompt` / `query` / `question` | 都没有 → 空串 |
| 单条用例的期望 | `expected` / `expected_output` / `answer` / `output` | 可选；非字符串会被 `JSON.stringify` |
| 单条用例的 id | `id` | 缺省为 `case-<下标>` |
| 数组元素是字符串 | `"列出当前目录文件"` | 视为只有 `input`，id 为 `case-<下标>` |

**最小可用样例**：

```json
{
  "name": "my-set",
  "cases": [
    { "input": "2 加 2 等于多少？只回答一个数字", "expected": "4" }
  ]
}
```

**完整样例**（带 id、多用例）：

```json
{
  "name": "rsi-smoke",
  "cases": [
    { "id": "math-ok",  "input": "2 加 2 等于多少？只回答一个数字，不要使用任何工具。", "expected": "4" },
    { "id": "math-bad", "input": "2 加 3 等于多少？只回答一个数字，不要使用任何工具。", "expected": "6" }
  ]
}
```

几条容易踩的坑：

- **文件必须能被 `JSON.parse`**：语法错、或读不到 → 该测试集判 `invalid`，**静默跳过**（不报错、不中断），只会在产卡汇总里体现为「没有可用用例」。UTF-8 BOM 已被自动剥掉（Windows 编辑器/记事本常见的 BOM 不再是坑）。
- **`cases` 为空 = `invalid`**：`valid` 的判定就是 `cases.length > 0`。
- **`expected` 是给 judge 的参照**，不写也能跑，但判分质量会下降（judge 拿不到「应该是什么」）。
- **强烈建议写 `id`**：不写就用下标 `case-0/1/2…`；trace 文件名按 `id` 落地，id 重复会互相覆盖。
- 每条用例都会**真跑一次真 Agent**（真 token、真工具调用、真耗时），不是纯静态分析。

### 1.3 用例会跑在哪个目录（重要）

每条用例都是一个**全新 Agent 实例、全新会话**，用例之间不共享上下文，也**不写入会话库**（不会出现在你的会话列表里）。

工作目录也是隔离的：用例 Agent 的 `workdir` 是 `<数据根>/reflect/eval-work/<caseId>`（每条用例一个子目录，跑之前自动建好），**不是**你执行 `bun run eval` 时所在的目录。也就是说：

- 用例里让 Agent 调 `bash` / 写文件，落到的是那条用例自己的隔离目录，**不会**动你的仓库；
- 用例之间也互不可见：A 用例写的文件，B 用例看不到；
- 收工后想清理，直接删 `<数据根>/reflect/eval-work/` 即可（也可以留着当调试现场）。

## 2. 跑评测并产卡

### 2.1 命令

```bash
bun run eval --judge                 # 完整一跳：分析历史 trace → LLM-judge → 诊断 → 真跑测试集产卡
bun run eval --judge --max-cases=3   # 每个测试集最多跑 3 条用例（成本闸）
```

### 2.2 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| `--judge` | 关 | 打开 judge 全链路。**产卡跳只在这个模式下跑** |
| `--max-cases=N` | **5** | 每个测试集最多执行多少条用例（N 必须是正整数，写错则忽略并回到 5） |
| `--date=YYYY-MM-DD` | 今天 | 分析哪一天的 `llm-trace` |
| `--all` | — | 分析全部历史 trace（逐文件出报告） |
| `--file=<路径>` | — | 指定单个 trace 文件 |
| `--exclude-model=a,b` | — | 过滤某些模型的记录（例如测试用 mock 模型） |
| `--optimize` | — | 只做「分析 + 自优化诊断」，**不产卡** |

> 参数写法是 `--key=value` 形式；`--judge` / `--all` / `--optimize` 是裸开关。

关于 `--max-cases` 要清楚两点：

1. 它是**每测试集**的上限，不是总上限（3 个测试集 + `--max-cases=5` = 最多 15 条用例）。
2. 它目前是**唯一**的运行时成本闸：执行器虽然支持 `maxTokens` / `maxDurationMs` 上限，但 CLI 装配时没有接（见 6.3）。

### 2.3 前置条件

- **LLM 配置可用**：CLI 会 `loadConfig()` 后 `buildEnvForLLM()` 建客户端；缺凭据时 judge 与产卡都不会发生（只会看到提示，不报硬错误）。
- **判分模型**用的是当前配置的主模型（`config.model`），与被测 Agent 同一个模型 —— 换模型会同时换掉「考生」和「考官」。
- **不需要**事先有 trace 日志：没有日志时会打印 `==== 未找到 trace 日志，跳过历史会话分析 ====`，然后**照样**真跑测试集产卡。

### 2.4 输出长什么样

正常一轮（有 trace 日志）大致是：

```
分析日志: <数据根>/logs/llm-trace-2026-10-19.jsonl
  …（概览 / 模型对比 / 工具分析 等报告区块）
==== LLM-judge 评测 ====
  测试集: rsi-smoke(2)
  judge 完成: N 条结果
==== 自优化诊断（含 judge 规则）====
  …（建议列表）

==== 测试集真跑 → 自省卡（RSI 产卡跳）====
  测试集 rsi-smoke: 跑 2 条（通过 1 / 失败 1，3.0 步、2860 token） → 产卡 1 张、入库 1 张
    ✗ math-bad: failed（0 分）用户要求计算2加3，期望输出6，但实际输出为5…
  合计: 产卡 1 张，入库 1 张（库: <数据根>/reflect/reflections.db）
```

几个可能的收尾提示，含义各不相同：

| 输出 | 含义 |
|---|---|
| `说明: 所有用例都判为 completed —— 没有外部信号就不产卡（铁律 1）。` | 一条都没失败 → 0 张卡，**这是正常的**，不是坏了 |
| `⚠️ 产卡通道不可用（…）：本轮只评历史 trace，不产卡` | 自省库/装配失败，降级为「只评历史」；对话注入通道仍在，只是没有新卡 |
| `⚠️ 未提供 LLM 客户端，跳过 judge` | 配置/凭据没读到，judge 与产卡都没跑 |
| `测试集: 无可用用例（目录 …），跳过真跑产卡` | 目录为空，或所有 JSON 都解析失败（多半是语法错） |
| `提示：未接线用例执行器/入库口 —— 测试集只列名不真跑` | 只出现在**编程调用** `runEval()` 且没传 `caseRunner`/`ingestCard` 时；CLI 路径会自动接线，不会出现 |

### 2.5 产物落点

| 产物 | 路径 |
|---|---|
| 自省卡库（SQLite） | `<数据根>/reflect/reflections.db` |
| 每条用例的 trace（可核对） | `<数据根>/reflect/traces/<测试集名>/<caseId>.trace.json` |
| 用例隔离工作目录 | `<数据根>/reflect/eval-work/<caseId>`（每条用例一个子目录，自动创建；用例的工具读写都落在里面，见 1.3） |
| 评测报告 | `<数据根>/logs/eval-report-{生成日}.md` |
| 自优化建议 | `<数据根>/optimizations/optimization-{日志日}.md` |

卡片里的**证据指针指向真实 trace 文件路径**：`evidence[].ref` = 上面那个 `.trace.json`，所以「这条教训从哪来」永远能点开核对。没有证据指针的草稿在 `ingest` 层会被直接丢弃。

### 2.6 什么样的用例会产卡

产卡看的是 **judge 的结论**，不是「过没过阈值」：

| judge 结论 | 是否产卡 | 卡片 `trigger` |
|---|---|---|
| `completed` | ❌ 不产（没有可反思的外部信号） | — |
| `failed` / `partial` / `tool_misused` / `inefficient` | ✅ 产 | `judge_failed` |
| `unsafe` | ✅ 产 | `judge_unsafe` |
| judge 自身调用失败（note 以 `LLM 调用失败` 开头） | ❌ 不产 | — |

注意「通过」与「不产卡」不是同一个判定：通过阈值是 `完成度 ≥ 60 且结论不属于 failed/unsafe/tool_misused`，所以一条 `partial`（完成度 70）会**算通过，但仍然产卡**。

`lesson` 目前是**模板化**的（按结论分 5 类，尾部带 judge note 前 120 字），例如：

- `failed` → 上一轮任务未完成（完成度 0）：先确认目标再动手，必要时拆步（judge: …）
- `partial` → 上一轮只完成了一部分（完成度 70）：收尾前逐项核对用户要求（judge: …）
- `tool_misused` → 上一轮工具选型/入参有误：调用前核对工具签名与必填参数（judge: …）
- `inefficient` → 上一轮步骤冗余：先规划再执行，避免重复读取同一目标（judge: …）
- `unsafe` → 上一轮触发了安全风险：涉及删除/覆盖/越界路径的操作先停下来确认（judge: …）

## 3. 对话时自动注入「过往教训」

### 3.1 什么时候注入

系统提示组装时（`loadSystemContext()`），卡片库和 overlay 就在注入清单里。装配点在三条路径上都有：

| 使用方式 | 装配点 | 是否注入 |
|---|---|---|
| TUI / `bun run dev` / `bun run serve`（WebUI） | `packages/server/src/create-runtime-agent.ts` | ✅ |
| ACP 模式（宿主编辑器 / Multica 运行时） | `packages/cli/src/acp-mode.ts` | ✅ |
| 评测自身跑用例的 Agent | `packages/eval/src/index.ts`（`wireCardPipeline`） | ✅（闭环在评测路径上也成立） |

**关键细节**：系统提示是**实例级缓存**的，一张卡注入后，同一 Agent 实例的后续对话轮次不会重算再注入。想看到新卡进去，就**开一个新会话**（或重启 TUI / 服务）。

### 3.2 注入长什么样

系统提示里会多出这一节（标题是写死的常量 `REFLECTION_SECTION_TITLE`）：

```
## 过往教训（自省卡 · 带证据）
- [judge_failed] 上一轮任务未完成（完成度 0）：先确认目标再动手，必要时拆步（judge: …）（证据: trace:<数据根>/reflect/traces/rsi-smoke/math-bad.trace.json）
```

节的位置在「记忆」之后、「额外指令」之前；`prompt-overlay.md`（如有）紧跟其后。

### 3.3 注入哪些卡（排序 + 预算）

1. **候选过滤**：只取状态为 `proposed` / `injected` / `adopted`、未过期、且带证据的卡；`rejected` / `expired` 永不注入。
2. **排序**：`严重度 × 1000 + 证据条数(≤5) × 10 + 新近度(0–9)`。严重度：`judge_unsafe` 100 > `human_negative` 90 > `judge_failed` 80 > `test_failed` 70 > `guard_tripped` 60。
3. **硬预算**：≤ `FENG_REFLECT_MAX_CARDS`（默认 5）条、≤ `FENG_REFLECT_MAX_TOKENS`（默认 600）token。token 按「字符数 / 4」估算。
4. **放不下时**：剩余预算 ≥ 40 token 就把这张卡的 lesson 截断（`…` 收尾）塞进去，否则丢弃并继续看下一张；被丢光的卡不注入。
5. **过期清理**：每次组装系统提示前会先跑一次 `expireDue()`，把到期卡置为 `expired` 并留痕。

### 3.4 注入记账（`injectedCount`）

真的注入了才记账：一轮注入会把这些卡状态推到 `injected`（已经是 `adopted` 的保持 `adopted`）、`effect.injectedCount += 1`、`effect.lastInjectedAt` 更新，并写一条 `reflect/injected` 事件（带 `sessionId`）。

记账频率是**每个 Agent 实例一次**（`assemble()` 后按实际注入的卡 id 记一次账），所以多步工具循环不会把计数刷爆。并发注入撞上乐观锁（`stale_revision`）时最多重试 3 次，仍失败就放过这张卡 —— 记账失败只打 warning，不打断对话。

## 4. 开关与预算（环境变量）

| 变量 | 默认 | 实际生效范围 |
|---|---|---|
| `FENG_REFLECT_INJECT` | `on` | `off`（也接受 `0` / `false` / `no`，大小写与空格不敏感）→ **自省卡和 `prompt-overlay.md` 两段一起关**，系统提示回到没有 RSI 的历史形态 |
| `FENG_REFLECT_MAX_CARDS` | `5` | 单次注入卡片条数上限 |
| `FENG_REFLECT_MAX_TOKENS` | `600` | 单次注入 token 上限（估算口径 字符/4） |
| `FENG_REFLECT_TTL_MS` | `1209600000`（14 天） | **已接线**：装配点（server / ACP / eval）经 `resolveReflectStoreOptions()` 把它传给 `ReflectionStore`，改这个变量即改变**新建卡片**的过期时间；已在库里的卡仍按各自的 `expires_at` 走（见 6.4） |

两条约定：

- 非法值 / 非正数 / 空串一律**回退默认**，不会因为写错而把注入关掉或预算归零；
- 注入默认是**开**的：它只读卡片、有硬预算、失败即降级（无卡继续对话），所以不需要额外开关去「启用」。

## 5. 怎么观察「产卡了没 / 注入了没」

### 5.1 看卡片库（最直接）

库文件：`<数据根>/reflect/reflections.db`，两张表：

| 表 | 内容 |
|---|---|
| `reflections` | 当前卡片。`revision` 是乐观锁版本；`effect_json` 里有 `injectedCount` / `lastInjectedAt`；`expires_at` 是过期时间戳（毫秒） |
| `reflection_events` | append-only 事件流（`seq` 单调），「证据 → 卡 → 注入」可从这里完整复原 |

`sqlite3` CLI 不一定装了，用 bun 自带驱动最省事。把下面这段存成 `reflect-dump.ts`（放仓库根或临时目录都行，别放进 `packages/*/src` —— 会被 `tsc --noEmit` 收进来）：

```typescript
import { Database } from "bun:sqlite";

const db = new Database(process.argv[2] ?? ".fengagent-cordis/reflect/reflections.db", {
  readonly: true,
});

console.table(
  db.query(
    `SELECT id, status, trigger, lesson,
            json_extract(effect_json, '$.injectedCount') AS injected,
            datetime(created_at / 1000, 'unixepoch', 'localtime') AS created,
            datetime(expires_at / 1000, 'unixepoch', 'localtime') AS expires
       FROM reflections
      ORDER BY created_at DESC`,
  ).all(),
);

console.table(
  db.query(
    `SELECT seq, card_id, type, datetime(at / 1000, 'unixepoch', 'localtime') AS at
       FROM reflection_events
      ORDER BY seq DESC
      LIMIT 20`,
  ).all(),
);
```

```bash
bun run reflect-dump.ts                        # 用默认数据根
bun run reflect-dump.ts .fengagent-cordis/reflect/reflections.db   # 指定库
```

输出会像这样（`injected` 列就是 `injectedCount`）：

```
│ 0 │ 79bd51a7-… │ injected │ judge_failed │ 上一轮任务未完成（完成度 0）：先确认目标再动手… │ 1 │ 2026-10-19 22:35:51 │ 2026-11-02 22:35:51 │
│ 1 │ f848cad2-… │ injected │ judge_failed │ 上一轮任务未完成（完成度 0）：先确认目标再动手… │ 3 │ 2026-10-18 23:52:55 │ 2026-11-01 23:52:55 │
```

### 5.2 看事件流

6 种事件，语义固定（`REFLECT_EVENT_TYPES`）：

| 事件 | 何时写 |
|---|---|
| `reflect/card-created` | 卡片入库（带 trigger + 证据） |
| `reflect/card-updated` | 状态推进（带 revision / status） |
| `reflect/injected` | 一次真实注入（带 sessionId） |
| `reflect/expired` | 到期被清理 |
| `reflect/adopted` / `reflect/rejected` | 验证闸采纳 / 拒绝（目前只有库级 API 能触发） |

典型闭环的事件序列（实测）：`card-created` → `card-updated`（→ injected）→ `injected` → 下一轮 `card-updated` → `injected`。

### 5.3 看控制台

产卡那一跳的控制台就是 2.4 里那几行：每个测试集一行「跑 N 条 / 产卡 a 张 / 入库 b 张」，最后一行合计并打印库路径。**入库数 < 产卡数**通常意味着证据门拒收（草稿 `evidence` 为空）。

### 5.4 确认「注入真的发生了」

三个互补的判断方式，从强到弱：

1. **`injectedCount` 涨了**：跑一次对话后重查卡片，`injected` 列从 0 变 1（或多 1）。
2. **有 `reflect/injected` 事件**，且 `sessionId` 是你这次对话的会话 id。
3. **对照实验**：`FENG_REFLECT_INJECT=off` 跑同一句话，卡片计数不变；去掉开关、开新会话再跑一次，计数 +1。这是最不容易误判的验证方式。

> 目前**没有** CLI 子命令（如 `fengagent reflect ls`），也**没有** WebUI 面板/HTTP 路由来浏览卡片 —— 观察入口只有数据库和控制台。这是第 6 节的第一条边界。

## 6. 现在能用什么 / 还不能一键用什么

### 6.1 能用（开箱）

| 能力 | 入口 | 备注 |
|---|---|---|
| 真跑测试集 | `bun run eval --judge [--max-cases=N]` | 每条用例一个隔离会话 |
| 按 judge 结论产卡入库 | 同上 | 只收带证据的卡，`completed` 不产卡 |
| 对话自动注入教训 | TUI / WebUI / ACP，无需命令 | 系统提示里多出「过往教训」一节 |
| 注入开关 + 预算 | `FENG_REFLECT_INJECT` / `_MAX_CARDS` / `_MAX_TOKENS` | 立即生效，无需重启进程以外的动作 |
| 观察产卡与注入 | `reflections.db` + `reflection_events` | 见第 5 节 |
| 过期卡自动停止注入 | 组装系统提示时自动 `expireDue()` | 默认 14 天（常量，非环境变量） |

### 6.2 不能一键（要写代码）

**验证闸（`runVerificationGate`）目前是库级 API，没有 CLI 子命令。** 也就是说，「跑 A/B → 通过就自动采纳并把规则写进 `prompt-overlay.md`」这一跳还差一个入口，需要自己写脚本调用 `@fengagent/eval`：

```typescript
import { runVerificationGate, listExperiments } from "@fengagent/eval";
// store 由你自己建：new ReflectionStore("<数据根>/reflect/reflections.db")

// runSet 由你自己提供：把某个测试集跑成 TestSetRun（基线不打 overlay、候选打 overlay）
// —— 这就是「还没一键」的那部分，`runTestSetCards` 只产卡，不跑双集对比。
const experiment = await runVerificationGate({
  dataRoot: ".fengagent-cordis",
  card,                                   // 要验证的 ReflectionCard
  runBaseline: (which) => runSet(which, { apply: false }),
  runCandidate: (which) => runSet(which, { apply: true }),
  heldInCaseIds, heldOutCaseIds,          // 可选：给了才做「双集不重叠」校验
  limits: { maxExperimentTokens: 200_000 },
  onRejected: (e) => store.transition(card.id, card.revision, { status: "rejected" }),
  onAdopted: (e) => store.transition(card.id, card.revision, { status: "adopted" }),
});

console.log(experiment.verdict, experiment.reasons, experiment.rolledBack);
```

采纳后 overlay 落在 `<数据根>/reflect/prompt-overlay.md`，**下一轮装配系统提示时自动注入**（同一 `FENG_REFLECT_INJECT` 开关管）；拒绝一律内容级回滚 + 写 `<数据根>/reflect/experiments/`（`<id>.json` 与 `experiments.jsonl`），可查：

```typescript
listExperiments(".fengagent-cordis", { verdict: "rejected" });
```

### 6.3 其他已知边界（避免误期待）

| 边界 | 现状 |
|---|---|
| 没有 `fengagent reflect …` 子命令 | 卡片只能查库 |
| 没有卡片面板 / HTTP API | WebUI 的「评测」页只有测试集/报告/建议，不含卡片 |
| 执行器成本上限未接线 | `runTestSet` 支持 `maxTokens` / `maxDurationMs`，但 CLI 只传 `--max-cases`；长时间/贵模型请自己压 `--max-cases` |
| 通过阈值不可配 | 固定 60（`passThreshold` 默认值），CLI 无参数 |
| 用例隔离目录不会自动清理 | `eval-work/<caseId>/` 会累积（每条用例一个）；想清就删 `<数据根>/reflect/eval-work/` |
| `lesson` 模板化 | 5 类模板 + judge note 截断 120 字，不能自定义文案 |
| 卡片不会自动被采纳 | 从 `proposed/injected` 到 `adopted` 必须过验证闸（也就是必须写脚本） |
| 注入不是每轮重算 | 系统提示实例级缓存；新卡要**新会话**才看得到 |
| 没有定时/自动评测 | 得手动 `bun run eval --judge`（没接进调度） |

### 6.4 `FENG_REFLECT_TTL_MS` 的生效范围（已接线）

`FENG_REFLECT_TTL_MS` 会被 `resolveReflectBudget()` 解析进预算对象，同时经 `resolveReflectStoreOptions()` 直接传给 `ReflectionStore` 的构造参数 —— server 运行态、ACP 模式、eval 产卡跳三处装配点都走这一条口径。因此：

- 改 `FENG_REFLECT_TTL_MS` 会改变**此后新建卡片**的 `expires_at`（测试里断言过：设 `60000` 时新卡存活期就是 60 秒，未设/非法时回退 14 天）；
- **已经在库里的卡不受影响**：过期时间在写入时固化，改环境变量不会回溯修改历史卡片；
- 想过期清理，仍由 `expireDue()` 在每轮注入前把 `expires_at <= now` 的卡置为 `expired`（事件流留痕）；
- 写 `0` 不是「立刻过期」而是非法值 → 回退默认 14 天（避免手滑把卡写成永不过期的反语义）。

## 7. 排查清单

| 症状 | 先看这里 |
|---|---|
| 跑完 0 张卡 | 是不是所有用例都 `completed`（正常）；judge 是否报 `LLM 调用失败`（评测器坏 ≠ 被评对象坏，不入卡）；测试集是否 `invalid`（JSON 语法） |
| 有卡但对话里看不到 | 是不是老会话（系统提示已缓存）→ 开新会话；`FENG_REFLECT_INJECT` 是否 `off`；卡是否已过期/`rejected`；预算是否把卡全丢光（可临时调大 `FENG_REFLECT_MAX_TOKENS` 试） |
| `injectedCount` 不涨 | 同上；另外确认这次对话真的装配了系统提示（新会话第一轮一定会） |
| 库打不开 | 只会 warn（`自省卡仓不可用…`），对话照常，只是没有注入 —— 检查 `<数据根>/reflect/` 权限/占用 |
| 报告没生成 | 报告挂在「生成日」，不是被分析日志的日期；`optimization-{date}` 挂的是**日志日** |

---

**相关文档**

- [docs/EVALUATION.md](EVALUATION.md) — 可观测性接入 / 评测手册 / 自优化流程 / RSI 机制与验证闸判定规则
- [docs/CONFIGURATION.md](CONFIGURATION.md) — 全部 `FENG_*` 环境变量
- [docs/MODULES.md](MODULES.md) — 各模块职责与落点文件
