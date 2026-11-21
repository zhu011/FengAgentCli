/**
 * @fengagent/agent — briefing 三段构造测试（P2）
 *
 * 队长 prompt 的形态是验收点（「队长运行记录里能看出它调了 dispatch_task」），
 * 所以这里把三段（协议 / roster / 小队指令 + Squad Context）逐条钉死：
 * - roster 带 role 与 skill，队长自己被标 `[队长]`（防止把活派回给自己）；
 * - squad 指令为空时**整段省略**（不产生空标题）；
 * - `composeSquadLeaderPrompt` 的任务正文在最后（不被长 briefing 稀释）。
 */

import { describe, expect, test } from "bun:test";
import {
  buildSquadBriefing,
  composeSquadLeaderPrompt,
  composeSquadWakePrompt,
  DEFAULT_SQUAD_PROTOCOL,
} from "../briefing.ts";

describe("buildSquadBriefing", () => {
  test("三段齐全：协议 / Squad Context / roster / 小队指令", () => {
    const briefing = buildSquadBriefing({
      squad: { id: "sq_fe", name: "前端小队", instructions: "改动先跑 typecheck" },
      leaderId: "coder",
      squadTaskId: "sqt_1",
      members: [
        { memberId: "coder", role: "leader", skills: ["webui", "review"] },
        { memberId: "researcher", role: "调研", skills: [] },
      ],
    });
    expect(briefing.protocol).toContain("## Squad Operating Protocol");
    expect(briefing.protocol).toContain("dispatch_task");
    expect(briefing.context).toContain("squad: sq_fe");
    expect(briefing.context).toContain("leader_task: sqt_1");
    expect(briefing.roster).toContain("- coder（leader） **[队长]** skills: webui, review");
    expect(briefing.roster).toContain("- researcher（调研）");
    expect(briefing.instructions).toBe("## Squad Instructions\n改动先跑 typecheck");
    expect(briefing.text.indexOf("## Squad Operating Protocol")).toBeLessThan(
      briefing.text.indexOf("## Squad Context"),
    );
    expect(briefing.text.indexOf("## Squad Context")).toBeLessThan(briefing.text.indexOf("## Roster"));
    expect(briefing.text.indexOf("## Roster")).toBeLessThan(briefing.text.indexOf("## Squad Instructions"));
  });

  test("小队指令为空 → 整段省略，不留空标题", () => {
    const briefing = buildSquadBriefing({
      squad: { id: "sq_x", name: "队", instructions: "   " },
      leaderId: "coder",
      members: [{ memberId: "coder", role: "", skills: [] }],
    });
    expect(briefing.instructions).toBe("");
    expect(briefing.text).not.toContain("## Squad Instructions");
    // 没有技能时不写 skills 段（避免 `skills:` 空悬）
    expect(briefing.roster).toBe("## Roster\n- coder **[队长]**");
  });

  test("无成员时 roster 给出明确占位（不让模型以为 roster 段丢了）", () => {
    const briefing = buildSquadBriefing({
      squad: { id: "sq_x", name: "队", instructions: "" },
      leaderId: "coder",
      members: [],
    });
    expect(briefing.roster).toContain("（暂无成员）");
  });

  test("协议可覆盖（定制小队规则时不动默认文案）", () => {
    const briefing = buildSquadBriefing({
      squad: { id: "sq_x", name: "队", instructions: "" },
      leaderId: "coder",
      members: [{ memberId: "coder", role: "", skills: [] }],
      protocol: "## Squad Operating Protocol\n只做 A，不做 B",
    });
    expect(briefing.protocol).toBe("## Squad Operating Protocol\n只做 A，不做 B");
    expect(DEFAULT_SQUAD_PROTOCOL).toContain("resolve_approval");
  });
});

describe("composeSquadLeaderPrompt / composeSquadWakePrompt", () => {
  const briefing = buildSquadBriefing({
    squad: { id: "sq_fe", name: "前端小队", instructions: "先跑 typecheck" },
    leaderId: "coder",
    squadTaskId: "sqt_1",
    members: [{ memberId: "coder", role: "leader", skills: ["webui"] }],
  });

  test("leader prompt：基础 prompt → briefing → 本次任务（任务在最后）", () => {
    const prompt = composeSquadLeaderPrompt("你是 coder。", briefing, "把技能页改好");
    expect(prompt.indexOf("你是 coder。")).toBeLessThan(prompt.indexOf("## Squad Operating Protocol"));
    expect(prompt.indexOf("## Squad Operating Protocol")).toBeLessThan(prompt.indexOf("## 本次任务"));
    expect(prompt).toContain("把技能页改好");
  });

  test("无基础 prompt 时不留空段", () => {
    const prompt = composeSquadLeaderPrompt("", briefing, "只做任务");
    expect(prompt.startsWith("## Squad Operating Protocol")).toBe(true);
  });

  test("wake prompt：成员回报按成员分组，附带收口指令", () => {
    const prompt = composeSquadWakePrompt("你是 coder。", briefing, [
      { memberId: "researcher", status: "completed", body: "调研结论：没有现成 claim 模型" },
      { memberId: "worker", status: "failed", body: "命令超时" },
    ]);
    expect(prompt).toContain("## 成员回报");
    expect(prompt).toContain("### researcher · completed");
    expect(prompt).toContain("### worker · failed");
    expect(prompt).toContain("请据此继续派活，或输出小队汇总收口。");
  });

  test("成员回报为空时写「（无输出）」而不是空段", () => {
    const prompt = composeSquadWakePrompt("", "", [{ memberId: "w", status: "completed", body: "  " }]);
    expect(prompt).toContain("（无输出）");
  });
});
