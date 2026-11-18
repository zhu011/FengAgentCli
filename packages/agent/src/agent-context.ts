/**
 * @fengagent/agent — 智能体执行上下文装配（P1）
 *
 * 派单 / 会话 / 小队任务统一走这里，保证「智能体是谁、会什么」在每条执行路径上
 * 一致（spec §5.3.4）：
 * 1. `agent.md` 正文 → instructions；
 * 2. `agent_skill`（enabled）→ 逐条解析内容层（团队 > workdir > builtin 的 shadow
 *    语义由调用方传入的 executor 决定）→ 拼成 `## 技能` 段；
 * 3. 缺内容 / 已停用的挂载只记入 `missing`，不阻断执行（技能是增强，不是闸门）。
 *
 * 纯函数：不读文件、不连库。内容解析由 server 侧 `SkillService` 注入，agent 包
 * 不反向依赖 server。
 */

import type { AgentRecord } from "./agent-registry.ts";
import type { AgentSkillMount } from "./skill-mount-store.ts";

/** 已解析的 skill 内容（来自内容层合并视图） */
export interface ResolvedSkill {
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  source: string;
}

/** 装配结果 */
export interface AgentContext {
  /** agent.md 正文 */
  instructions: string;
  /** 实际注入的技能（顺序 = 挂载顺序，已去重） */
  skills: ResolvedSkill[];
  /** 拼好的 `## 技能` 段（无技能时为空串） */
  skillSection: string;
  /** 交给 runtime 的完整 prompt（instructions + 技能段） */
  prompt: string;
  /** 挂了但解析不到（已删/停用/读失败）的 skill 名 */
  missing: string[];
}

/** 装配入参 */
export interface BuildAgentContextInput {
  agent: Pick<AgentRecord, "id" | "displayName" | "instructions">;
  mounts: readonly AgentSkillMount[];
  /** 按名字解析内容层（返回 null = 解析不到） */
  resolveSkill: (name: string) => ResolvedSkill | null;
  /** 技能段总字节上限（默认 128 KiB；超出截断并记 warning） */
  maxSkillBytes?: number;
}

const DEFAULT_MAX_SKILL_BYTES = 128 * 1024;

/** 拼一段技能（与既有 skill prompt 注入形态一致，便于人读与 diff） */
function renderSkill(skill: ResolvedSkill): string {
  const lines = [`### ${skill.name}`, skill.description.trim()];
  if (skill.trigger.trim() !== "") lines.push(`触发条件：${skill.trigger.trim()}`);
  lines.push("", skill.prompt.trim());
  return lines.join("\n");
}

/**
 * 装配智能体执行上下文。
 *
 * 停用的挂载不注入（`enabled=false` 时仍保留关系，只是不生效）。
 */
export function buildAgentContext(input: BuildAgentContextInput): AgentContext {
  const maxBytes = input.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES;
  const instructions = input.agent.instructions.trim();
  const skills: ResolvedSkill[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const mount of input.mounts) {
    if (!mount.enabled) continue;
    if (seen.has(mount.skillName)) continue;
    seen.add(mount.skillName);
    const resolved = input.resolveSkill(mount.skillName);
    if (resolved === null) {
      missing.push(mount.skillName);
      continue;
    }
    skills.push(resolved);
  }

  if (skills.length === 0) {
    return {
      instructions,
      skills,
      skillSection: "",
      prompt: instructions,
      missing,
    };
  }

  const blocks: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const block = renderSkill(skill);
    const bytes = Buffer.byteLength(block, "utf-8");
    if (used + bytes > maxBytes) break;
    blocks.push(block);
    used += bytes;
  }

  const skillSection = ["## 技能", "以下技能已挂载到本智能体，执行相关任务时按正文执行。", "", blocks.join("\n\n")].join(
    "\n",
  );
  const prompt = instructions === "" ? skillSection : `${instructions}\n\n${skillSection}`;
  return { instructions, skills, skillSection, prompt, missing };
}

/**
 * 派单 prompt：装配上下文 + 本次任务正文。
 *
 * 任务正文放在最后，避免长技能段把「这次要干什么」推到上下文前部被稀释。
 */
export function renderDispatchPrompt(context: AgentContext, task: string): string {
  const body = task.trim();
  if (context.prompt === "") return body;
  return `${context.prompt}\n\n---\n\n## 本次任务\n${body}`;
}
