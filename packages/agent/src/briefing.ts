/**
 * @fengagent/agent — 小队 briefing（P2，纯函数）
 *
 * 队长模式的 system prompt 由三段拼成（对齐 Multica `squad_briefing.go`）：
 *
 * 1. `## Squad Operating Protocol`：只协调不实现、用 `dispatch_task` 派活、派完就停；
 * 2. `## Roster`：一行一个成员 `- <id>（<role>）skills: a, b` —— **让队长按能力选人**
 *    （skill 名来自 P1 的 `agent_skill`，启用中的才算）；
 * 3. `## Squad Instructions`：小队级指令，空则整段省略（不产生空标题）。
 *
 * 职责边界：只做文本，不读库、不连 registry —— 成员能力由调用方（SquadService）查好传进来，
 * 这样这段 prompt 可以被单测钉死，也方便以后从 Multica 的措辞对齐。
 */

import type { SquadMember } from "./squad-store.ts";

/** roster 一行需要的成员信息 */
export interface SquadRosterEntry {
  memberId: string;
  role: string;
  /** 该成员启用中的技能名（顺序稳定，空数组则不写 skills 段） */
  skills: readonly string[];
}

/** 装配入参 */
export interface BuildSquadBriefingInput {
  squad: { id: string; name: string; instructions: string };
  leaderId: string;
  members: readonly SquadRosterEntry[];
  /** 本次队长任务 id（派活时模型要原样带给 `dispatch_task`） */
  squadTaskId?: string;
  /** 覆盖协议段（测试/定制用；缺省用内置协议） */
  protocol?: string;
}

/** 装配结果（分段保留，便于单测与按需省略） */
export interface SquadBriefing {
  protocol: string;
  roster: string;
  /** `## Squad Context`（squad id + leader_task id，派活时照抄） */
  context: string;
  instructions: string;
  /** 全部段拼接后的完整 briefing（空段已省略） */
  text: string;
}

/** 默认协议段（措辞与 Multica 的 leader 语义对齐：只协调、派完就停、最后收口） */
export const DEFAULT_SQUAD_PROTOCOL = [
  "## Squad Operating Protocol",
  "你是本小队的队长，负责协调与验收，不亲自实现成员能做的事。",
  "1. 用 `dispatch_task(agent=\"<成员id>\", task=\"<自包含任务>\", squad=\"<squad>\", leader_task=\"<leader_task>\")` 把子任务派给成员（两个 id 见下面的 Squad Context）；它建完任务就返回 task id，不要等结果、不要自己轮询。",
  "2. 每个子任务都要写清背景、目标、交付物、边界（成员看不到本会话上下文）。",
  "3. 成员到终态（replied / failed / cancelled）后，结果会作为「成员回报」回到你这里；据此继续派活或收口。",
  "4. 全部子任务终态后输出小队汇总：结论、证据、未完成项与风险。",
  "5. 成员遇到需要批准的操作会挂起并生成审批请求：用 `resolve_approval` 裁决（once / session / permanent），拿不准就用 `escalate_approval` 上抛人类发起人。每一笔裁决都会进审计。",
].join("\n");

/** 拼 roster 一行 */
function renderRosterLine(entry: SquadRosterEntry, isLeader: boolean): string {
  const role = entry.role.trim();
  const rolePart = role === "" ? "" : `（${role}）`;
  const leaderPart = isLeader ? " **[队长]**" : "";
  const skills = entry.skills.map((name) => name.trim()).filter((name) => name !== "");
  const skillPart = skills.length === 0 ? "" : ` skills: ${skills.join(", ")}`;
  return `- ${entry.memberId}${rolePart}${leaderPart}${skillPart}`;
}

/**
 * 装配队长 briefing。
 *
 * 队长自己也在 roster 里（带 `[队长]` 标记）—— 模型看得到「谁能干活」，也看得到
 * 「我是谁」，避免它把任务再派回给自己的死循环。
 */
export function buildSquadBriefing(input: BuildSquadBriefingInput): SquadBriefing {
  const protocol = (input.protocol ?? DEFAULT_SQUAD_PROTOCOL).trim();

  const lines: string[] = ["## Roster"];
  if (input.members.length === 0) {
    lines.push("- （暂无成员）");
  } else {
    for (const member of input.members) {
      lines.push(renderRosterLine(member, member.memberId === input.leaderId));
    }
  }
  const roster = lines.join("\n");

  const instructionsText = input.squad.instructions.trim();
  const instructions =
    instructionsText === "" ? "" : ["## Squad Instructions", instructionsText].join("\n");

  const contextLines = ["## Squad Context", `- squad: ${input.squad.id}`];
  if (input.squadTaskId !== undefined && input.squadTaskId !== "") {
    contextLines.push(`- leader_task: ${input.squadTaskId}`);
  }
  contextLines.push(
    `派活时照抄：\`dispatch_task(agent="<成员id>", task="<任务>", squad="${input.squad.id}"` +
      (input.squadTaskId === undefined || input.squadTaskId === ""
        ? ")"
        : `, leader_task="${input.squadTaskId}")`) +
      "`",
  );
  const context = contextLines.join("\n");

  const text = [protocol, context, roster, instructions].filter((part) => part !== "").join("\n\n");
  return { protocol, roster, context, instructions, text };
}

/**
 * 队长派单 prompt：`智能体上下文` + `briefing` + `本次任务`。
 *
 * 任务正文放最后（与 `renderDispatchPrompt` 同序）：长 briefing 不该把「这次要干什么」
 * 推到上下文前部被稀释。
 */
export function composeSquadLeaderPrompt(
  agentPrompt: string,
  briefing: SquadBriefing | string,
  task: string,
): string {
  const briefingText = typeof briefing === "string" ? briefing.trim() : briefing.text.trim();
  const parts: string[] = [];
  if (agentPrompt.trim() !== "") parts.push(agentPrompt.trim());
  if (briefingText !== "") parts.push(briefingText);
  parts.push(["## 本次任务", task.trim()].join("\n"));
  return parts.join("\n\n---\n\n");
}

/**
 * 唤醒队长的「成员回报」prompt：`briefing` + 若干条成员终态 + 行动提示。
 *
 * 本地没有评论流（Multica 用 comment 唤醒队长），这里用「再派一轮队长任务、把回报
 * 作为任务正文」代替 —— 队长看到的是一条新的 user 消息，语义等价。
 */
export function composeSquadWakePrompt(
  agentPrompt: string,
  briefing: SquadBriefing | string,
  reports: readonly { memberId: string; status: string; body: string }[],
): string {
  const briefingText = typeof briefing === "string" ? briefing.trim() : briefing.text.trim();
  const body = reports
    .map((report) => {
      const text = report.body.trim() === "" ? "（无输出）" : report.body.trim();
      return `### ${report.memberId} · ${report.status}\n${text}`;
    })
    .join("\n\n");
  const task = ["## 成员回报", body, "", "请据此继续派活，或输出小队汇总收口。"].join("\n");
  const parts: string[] = [];
  if (agentPrompt.trim() !== "") parts.push(agentPrompt.trim());
  if (briefingText !== "") parts.push(briefingText);
  parts.push(task);
  return parts.join("\n\n---\n\n");
}

/** 参与 roster 的成员（去掉人占位：只有 agent 能被派活） */
export function assignableMembers(members: readonly SquadMember[]): SquadMember[] {
  return members.filter((member) => member.memberType === "agent");
}
