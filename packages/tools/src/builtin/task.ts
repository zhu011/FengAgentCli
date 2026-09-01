/**
 * @fengagent/tools — Task 内置工具（多 Agent 子任务派遣）
 *
 * 主 Agent 通过 task 工具派遣子 Agent 执行独立任务。
 * 前台模式：阻塞等待子 Agent 完成，返回 <task_result>。
 *
 * 参数：description、prompt、subagent_type、task_id（恢复）
 *
 * 子 Agent 不能调用 task 工具（由 subagent-runner 在创建子工具注册表时排除）。
 *
 * 参考 opencode task 工具和 ARCHITECTURE.md 第 3.4 节。
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  SubagentResult,
} from "@fengagent/core";
import { ALLOW } from "@fengagent/core/permission";
import { z } from "zod";

// ──────────────────────────────────────────────
// 输入 Schema
// ──────────────────────────────────────────────

/**
 * 子 Agent 类型参数别名 — 兼容 LLM 工具调用时的常见参数名误拼。
 *
 * 规范参数名是 `subagent_type`（snake_case），但实测部分模型（如 deepseek-v4-pro）
 * 会反复输出 camelCase 的 `subagentType`，甚至 `agentType` / `type` / `agent` /
 * `subagent` / `kind` / `name` 等变体。zod 默认会静默剥离未知键，导致
 * `subagent_type` 为 undefined → 「Unknown agent type: undefined」→ 模型反复重试，
 * 形成死循环（AGE-29 现场：单会话 25 轮、48 次 task 调用全部因此失败）。
 *
 * 解法：schema 使用 passthrough + transform 把别名归一化到 `subagent_type`；
 * 值本身仍会在运行时与可用 Agent 类型（default / coder / researcher）校验。
 */
const SUBAGENT_TYPE_ALIASES = [
  "subagentType",
  "agentType",
  "agent_type",
  "agent",
  "subagent",
  "type",
  "kind",
  "name",
] as const;

/** 从输入中按别名顺序提取子 Agent 类型字符串（找不到返回 undefined） */
function pickSubagentType(raw: Record<string, unknown>): string | undefined {
  if (typeof raw["subagent_type"] === "string" && raw["subagent_type"].trim() !== "") {
    return raw["subagent_type"].trim();
  }
  for (const alias of SUBAGENT_TYPE_ALIASES) {
    const v = raw[alias];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * 缺参兜底 — 按任务内容关键词推断子 Agent 类型。
 *
 * 模型完全缺参 / 传空值（AGE-29 之后仍出现：推荐问题路径下模型即使被告知正确参数名
 * 也持续漏传或传空）时，若继续返回「缺 subagent_type」错误，会再次触发失败重试死循环。
 * 这里先从 description/prompt 内容做保守推断（研究类 → researcher，编码类 → coder），
 * 推断不出再退回通用 "default"，保证 task 工具永不因缺参失败。
 */
const RESEARCH_KEYWORDS = [
  "调研",
  "研究",
  "检索",
  "调查",
  "分析",
  "总结",
  "报告",
  "对比",
  "比较",
  "research",
  "investigate",
  "investigation",
  "analyze",
  "analyse",
  "analysis",
  "survey",
  "summarize",
  "summarise",
  "report",
] as const;

const CODE_KEYWORDS = [
  "写",
  "实现",
  "开发",
  "编程",
  "代码",
  "重构",
  "修复",
  "编写",
  "脚本",
  "调试",
  "code",
  "program",
  "implement",
  "implementation",
  "script",
  "build",
  "refactor",
  "debug",
  "fix",
] as const;

function countKeywordHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) count++;
  }
  return count;
}

/** 从任务描述/提示词推断子 Agent 类型；推断不出返回 undefined */
function inferSubagentType(description: string, prompt: string): string | undefined {
  const combined = `${description} ${prompt}`;
  const researchHits = countKeywordHits(combined, RESEARCH_KEYWORDS);
  const codeHits = countKeywordHits(combined, CODE_KEYWORDS);
  // 并列时优先研究类（只读、安全）；两边都无命中返回 undefined
  if (researchHits >= codeHits && researchHits > 0) return "researcher";
  if (codeHits > 0) return "coder";
  return undefined;
}

/** subagent_type 解析结果：最终类型 + 来源（显式 / 推断 / 默认兜底） */
export type SubagentTypeSource = "explicit" | "inferred" | "default";

/** 归一化 + 兜底解析 subagent_type（永不返回 undefined） */
function resolveSubagentType(
  raw: Record<string, unknown>,
): { type: string; source: SubagentTypeSource } {
  const explicit = pickSubagentType(raw);
  if (explicit) return { type: explicit, source: "explicit" };
  const inferred = inferSubagentType(
    typeof raw["description"] === "string" ? raw["description"] : "",
    typeof raw["prompt"] === "string" ? raw["prompt"] : "",
  );
  if (inferred) return { type: inferred, source: "inferred" };
  return { type: "default", source: "default" };
}

const inputSchema: z.ZodType<TaskInput> = z
  .object({
    description: z
      .string()
      .describe("A short (3-5 words) description of the task"),
    prompt: z
      .string()
      .describe("The task for the agent to perform"),
    subagent_type: z
      .string()
      .optional()
      .describe(
        "The type of specialized agent to use for this task. Valid values: default (general-purpose), coder (code writing), researcher (read-only research). Use exactly this key name: subagent_type. If omitted, the runtime picks a sensible fallback (inferred from the task content, else 'default') — but passing it explicitly is recommended.",
      ),
    task_id: z
      .string()
      .optional()
      .describe(
        "Set this to resume a previous task — pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one.",
      ),
  })
  .passthrough() // 保留 LLM 误拼的别名键（subagentType 等），transform 阶段归一化
  .transform((raw) => {
    const r = raw as Record<string, unknown>;
    const resolved = resolveSubagentType(r);
    return {
      // zod 已在 object 层校验 description/prompt 为 string，此处仅收窄类型
      description: r["description"] as string,
      prompt: r["prompt"] as string,
      subagent_type: resolved.type,
      _subagentTypeSource: resolved.source,
      task_id: typeof r["task_id"] === "string" ? r["task_id"] : undefined,
    };
  }) as unknown as z.ZodType<TaskInput>;
  // 说明：输入侧 subagent_type 声明为可选（模型可能缺参/空值），transform 兜底后输出必填；
  // zod 单一泛型无法表达「输入可选、输出必填」，此处收窄为 TaskInput（运行时行为不变）。

/** 归一化后的 Task 工具输入（subagent_type 经别名归一化 + 缺参兜底，永远有值） */
export interface TaskInput {
  description: string;
  prompt: string;
  /** 子 Agent 类型：显式/别名 → 关键词推断 → "default" 兜底，永不缺省 */
  subagent_type: string;
  /** 内部字段：subagent_type 的来源（显式/推断/默认），用于结果备注与调试 */
  _subagentTypeSource?: SubagentTypeSource;
  task_id?: string;
}

// ──────────────────────────────────────────────
// 输出格式化
// ──────────────────────────────────────────────

/** 格式化子 Agent 结果为工具输出文本 */
function renderResult(
  result: SubagentResult,
): string {
  const tag = result.state === "error" ? "task_error" : "task_result";
  const summary = result.summary ? `\n<summary>${result.summary}</summary>` : "";
  return [
    `<task id="${result.sessionId || result.taskId}" state="${result.state}">${summary}`,
    `<${tag}>`,
    result.text,
    `</${tag}>`,
    "</task>",
  ].join("\n");
}

// ──────────────────────────────────────────────
// Task 工具定义
// ──────────────────────────────────────────────

export const taskTool: ToolDefinition<TaskInput> = {
  name: "task",
  description: [
    "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file.",
    "Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.",
    "",
    "Foreground is the default — the tool blocks until the subagent completes and returns the result.",
    "",
    "Parameters: description, prompt, subagent_type (the type of specialized agent; the exact key name is subagent_type with an underscore, NOT subagentType; pass it explicitly whenever possible — if omitted the runtime infers a sensible type from the task content, falling back to 'default'), task_id (optional, to resume).",
    "Available subagent types: default (general-purpose), coder (code writing), researcher (read-only research).",
  ].join("\n"),

  inputSchema,

  isReadOnly(): boolean {
    // task 工具本身不修改文件，但子 Agent 可能会
    return false;
  },

  isDestructive(): boolean {
    return false;
  },

  isConcurrencySafe(): boolean {
    // 子 Agent 可能修改文件系统，不应并行
    return false;
  },

  checkPermissions() {
    // task 工具默认允许（子 Agent 内部各自做权限检查）
    return ALLOW;
  },

  async execute(input: TaskInput, context: ToolContext): Promise<ToolResult> {
    // 检查是否注入了 spawnSubagent
    if (!context.spawnSubagent) {
      return {
        content:
          'Error: Task tool requires a subagent runner but none is available. This usually means the agent runtime was not configured with agent definitions.',
        isError: true,
        metadata: { reason: "no_spawnSubagent" },
      };
    }

    // 子 Agent 类型已由 schema 兜底（显式/别名 → 关键词推断 → "default"），
    // 模型缺参/传空不再失败，避免「缺 subagent_type」触发失败重试死循环（AGE-29 后续）。
    const subagentType = input.subagent_type;
    const source = input._subagentTypeSource ?? "explicit";

    // 当前深度
    const currentDepth = context.agentDepth ?? 0;

    try {
      const result = await context.spawnSubagent({
        description: input.description,
        prompt: input.prompt,
        subagentType,
        taskId: input.task_id,
        parentSessionId: context.sessionId,
        depth: currentDepth,
      });

      const output = renderResult(result);

      // 兜底备注：缺参被推断/默认时告知主 Agent，帮助其后续自纠正参数名
      const fallbackNote =
        source === "explicit"
          ? ""
          : `\n<note>subagent_type 未显式提供（${source === "inferred" ? "已按任务内容推断" : "已用默认类型 default"}），任务已正常派遣。</note>`;

      return {
        content: output + fallbackNote,
        isError: result.state === "error",
        metadata: {
          taskId: result.taskId,
          sessionId: result.sessionId,
          state: result.state,
          subagentTypeSource: source,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        content: `<task state="error">\n<task_error>\n${errorMsg}\n</task_error>\n</task>`,
        isError: true,
        metadata: { reason: "exception", error: errorMsg },
      };
    }
  },

  renderUse(input: TaskInput): string {
    return `task: ${input.description} (${input.subagent_type})`;
  },
};
