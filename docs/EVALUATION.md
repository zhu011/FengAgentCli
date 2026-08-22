# 评测与自优化指南

> 覆盖三块内容：**可观测性接入指南**（如何采集与解读 LLM trace）、**评测模块使用手册**（`bun run eval` 全用法与报告解读）、**自优化流程说明**（基于评测结果自动生成调优建议）。
>
> 数据根说明：本分支（`refactor/cordis-graph-architecture`）数据根为 `.fengagent-cordis/`，main 分支为 `.fengagent/`，下文以「数据根」统称。

## 一、可观测性接入指南

### 1.1 采集链路

每次 LLM 调用都会以 JSONL 格式落盘为一条观测记录，构成端到端采集链路：

```
Agent 会话 → LLM 调用（createLlmTracer）
  ├─ logRequest  记录请求（消息、工具列表、maxTokens）
  └─ logResponse 记录回复（耗时、token、工具调用、完成原因、错误）
        ↓
<数据根>/logs/llm-trace-{date}.jsonl
        ↓
bun run eval（分析聚合） / 自优化诊断 / 观测面板（消费同一数据源）
```

- 采集实现：`packages/llm/src/trace.ts` 的 `createLlmTracer()`，由 Agent 运行时的流式调用点写入（零侵入：仅追加写文件，写失败静默忽略）。
- 测试环境自动跳过采集（`NODE_ENV=test`、bun test 运行器检测），不会污染观测数据；可通过 `FENG_TRACE_DISABLED=true` 手动禁用。
- 数据根可通过 `FENG_DATA_DIR` 环境变量覆盖，便于多实例隔离。

### 1.2 记录格式

每条记录一行 JSON，分 `request` / `response` 两个方向：

| 字段 | 方向 | 说明 |
|------|------|------|
| `timestamp` | 双向 | 时间戳（ISO 8601） |
| `sessionId` | 双向 | 会话 ID（同会话多轮消息可关联成调用链） |
| `model` | 双向 | 模型 ID |
| `durationMs` | response | 单次调用耗时 |
| `inputTokens` / `outputTokens` | response | token 用量 |
| `cacheReadTokens` / `cacheCreationTokens` | response | KV cache 读取 / 创建 token |
| `hasToolCalls` / `toolCalls` | response | 是否含工具调用 + `[{name, input}]`（input 含参数明细） |
| `finishReason` | response | end_turn / tool_use / max_tokens / stop_sequence / error |
| `error` | response | 错误消息（无错误为 null） |
| `messages` | request | 请求消息（截断到 200 字符/块） |
| `tools` | request | 请求中携带的工具名列表 |
| `responseText` | response | 回复文本（截断到 500 字符） |

### 1.3 接入约定

- **请求-回复配对**：`sessionId` + 顺序即可重建「用户消息 → LLM 调用 → 工具执行 → 结果回填」的完整推理路径；工具名与参数在 `toolCalls` 中可还原。
- **调用链树**：`sessions`（分析结果）按会话聚合，`toolNames` / `errors` / `finishReasons` 为链上明细——观测面板（WebUI）可按「会话 → 消息 → LLM 调用 → 工具调用」四层树形展开。
- **新增观测维度**：在 `LlmTraceRecord` 增加字段即可，分析器与诊断器自动透传，无需改采集点。

## 二、评测模块使用手册

### 2.1 命令用法

```bash
bun run eval                                        # 分析今天的数据根日志
bun run eval --date=2026-08-13                      # 分析指定日期
bun run eval --all                                  # 分析全部历史日志（逐文件出报告）
bun run eval --file=<数据根>/logs/llm-trace-2026-08-13.jsonl  # 分析指定文件
bun run eval --exclude-model=mock-model             # 过滤指定模型（多模型逗号分隔）
bun run eval --optimize                             # 分析 + 自优化诊断（见第三章）
```

输出：控制台表格 + `<数据根>/logs/eval-report-{date}.md` 完整报告。

### 2.2 报告解读

报告包含五块：

| 区块 | 内容 | 定位（参考美团四层归因） |
|------|------|------------------------|
| 概览 | 会话数 / LLM 调用 / 总耗时 / 平均耗时 / token 用量 | 效率层 |
| 模型准确率对比 | 每模型：工具调用次数、工具成功率、错误率、任务完成率、平均耗时、平均 token、Cache 命中率 | 结果 + 效率层 |
| KV Cache | 读取 / 创建 token、命中率 | 效率层（成本） |
| 工具使用分布 | 各工具调用次数 | 过程层 |
| 完成原因分布 | end_turn / tool_use / max_tokens / error 计数 | 过程层 |

### 2.3 指标字典（AnalysisResult）

分析器 `packages/eval/src/analyzer.ts` 输出：

- **结果层**：`taskCompletionRate`（end_turn 占比）、`errorRate` / `errors[]`
- **过程层**：`toolCallCount` / `toolCallRate`、`toolUsage`、`finishReasons`
- **效率层**：`avgDurationMs`、`avgInputTokens` / `avgOutputTokens`、`cacheHitRate`
- **会话级**：`sessions[]`（每会话完整轨迹：请求/回复配对、工具名、错误、完成原因）

### 2.4 编程接口

```typescript
import { parseLogFile, analyzeRecords, runEval } from "@fengagent/eval";

const records = parseLogFile("llm-trace-2026-08-13.jsonl");
const result = analyzeRecords(records, "llm-trace-2026-08-13.jsonl");
await runEval({ date: "2026-08-13" }); // 或 CLI
```

## 三、自优化流程说明

### 3.1 闭环流程

评测结果驱动框架自优化，形成「观测 → 评测 → 诊断 → 调优 → 回归」闭环：

```
bun run eval --optimize
  ├─ 分析日志（analyzeRecords）
  ├─ 规则诊断（diagnose：规则 + LLM-judge 结论，阈值触发）
  └─ 建议报告落盘 <数据根>/optimizations/optimization-{date}.md
        ↓
人工 / 评测协作方审阅建议（本模块保守默认：只出建议、不自动改配置）
        ↓
修改系统提示词 / 工具描述 / Skill 后再次对话
        ↓
回归评测（bun run eval）验证指标变化
```

### 3.2 诊断规则

参考 DeepEval 六项 Agent 指标（任务完成 / 步骤效率 / 工具正确性 / 参数正确性 / 计划质量 / 计划遵循）与美团「结果 / 过程 / 效率 / 风险」四层归因，默认阈值见 `DEFAULT_THRESHOLDS`（`packages/eval/src/self-optimize.ts`）：

**A. 指标规则（基于 trace 聚合指标，不依赖 judge）**

| # | 触发条件（默认阈值） | 建议类型 | 归因层 |
|---|---------------------|---------|--------|
| 1 | 任务完成率 < 60%（end_turn 占比） | system-prompt | 结果 |
| 2 | 错误率 > 20%，工具相关错误占比 ≥ 50% | tool-description（定位失败工具） | 结果 + 过程 |
| 3 | 错误率 > 20%，非工具错误为主 | system-prompt | 结果 |
| 4 | 工具成功率 < 70%（工具调用数 ≥ 阈值） | tool-description | 过程（ToolCorrectness） |
| 5 | KV cache 命中率 < 20% 且输入 token > 1 万 | context（提示词前缀稳定） | 效率（成本） |
| 6 | 平均耗时 > 30s | workflow（工具循环 / 上下文膨胀） | 效率（StepEfficiency） |
| 7 | max_tokens / stop_sequence 截断占比 > 30% | context（maxTokens / 压缩） | 过程 |
| 8 | 工具调用率 < 10% 且会话数 ≥ 3 | workflow（工具可见性） | 过程 |

**B. LLM-judge 规则（KG 评测引擎产出 `judgeResults` 后生效，基数 ≥ judgeMinSamples=3）**

| # | 触发条件（默认阈值） | 建议类型 | 归因层 |
|---|---------------------|---------|--------|
| 9 | judge 平均完成度 < 60 或未完成（failed/partial/tool_misused）占比 > 30%；其中工具误用占未完成 ≥ 50% | tool-description（更细归因） | 结果 + 过程 |
| 10 | 同上，但工具误用占比 < 50% | system-prompt（对照 judge note 定位规划问题） | 结果 |
| 11 | judge 判定 unsafe 达到 1 个（零容忍，不受基数限制） | system-prompt（安全约束） | 风险 |
| 12 | judge 判定 inefficient 占比 > 30% | workflow（步骤冗余） | 效率 |

每条建议包含：触发依据（指标数值 + 阈值）、样本证据（错误消息 / 完成原因分布 / judge note）、具体修改建议——支持按归因维度（规划 / 工具 / 上下文）快速定位问题。

### 3.3 LLM-judge 数据结构对齐（KG 评测引擎 ↔ 自优化诊断器）

`judgeResults` 为 `AnalysisResult` 的可选字段（`packages/eval/src/analyzer.ts` 的 `JudgeResult` 类型），由评测引擎的 LLM-judge 评测产出后合并（`analyzeRecords` 不产生此字段）。数据结构约定：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 判定的会话 ID（与 `TraceRecord.sessionId` 对应） |
| `completionScore` | number 0–100 | 任务完成度分数（DeepEval TaskCompletionMetric；越小问题越严重） |
| `correctnessScore` | number 0–100 | 输出正确性分数（与任务目标符合度） |
| `conclusion` | 枚举 | `completed` 完成 / `partial` 部分完成 / `failed` 未完成 / `tool_misused` 工具误用 / `unsafe` 安全风险 / `inefficient` 效率低 |
| `note` | string（可选） | 判定依据（展示为证据） |

- **分数区间统一 0–100**，与现有百分比指标一致；
- **结论枚举驱动归因**：`tool_misused` → 工具描述问题、`unsafe` → 安全约束、`inefficient` → 步骤效率、其余未完成 → 系统提示词规划问题；
- 评测引擎产出 `JudgeResult[]` 后调用 `diagnose(result)`（result.judgeResults 合并即可），自优化侧无需改动接口。

### 3.3 阈值配置

阈值可编程覆盖（CLI 暂用默认值）：

```typescript
import { diagnose, DEFAULT_THRESHOLDS } from "@fengagent/eval";

const suggestions = diagnose(result, {
  ...DEFAULT_THRESHOLDS,
  errorRateHigh: 10,        // 更敏感的错误率
  minSamples: 20,           // 更大样本基数要求
});
```

统计基数小于 `minSamples`（默认 10）时不触发规则，避免小样本误报。

### 3.4 建议落地与回归

1. 审阅 `<数据根>/optimizations/` 下建议报告，按严重度（高 → 低）逐条处理；
2. 系统提示词修改：`packages/context/src/system-context.ts` 相关组装逻辑；
3. 工具描述修改：`packages/tools/src/builtin/` 下对应工具的 `description` 与参数 schema；
4. Skill 修改：`.fengagent/skills/*.md`；
5. 回归：重新对话产生新日志 → `bun run eval --optimize` 对比指标变化。

### 3.5 设计取舍与扩展

- **规则驱动优先**：确定性、零成本、可解释——适合常规场景；LLM-judge 存在长度偏差 / 自偏好 / 非确定性等失败模式（DeepEval 实践结论），默认不启用。
- **LLM-judge 扩展点**：`diagnose()` 输入为 `AnalysisResult`（评测引擎输出），未来可接入 KG 评测引擎的 LLM-judge 深度分析结果（如错误样本语义归类、计划质量评分），作为新增诊断规则输入，接口不变。
- **观测面板衔接**：建议报告 Markdown 落盘于数据根，WebUI 观测面板（DSH 实现）可直接读取展示。
