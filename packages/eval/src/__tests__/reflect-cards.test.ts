/**
 * @fengagent/eval — judge 结论 → 自省卡映射测试（RSI P0）
 *
 * 覆盖验收契约 A1（四类带证据来源；judge 调用失败不入库）：
 * 只有「非 completed 且有判分依据」的结论才产生草稿，且每条草稿都带 trace 证据指针。
 */

import { describe, test, expect } from "bun:test";
import type { JudgeResult } from "../analyzer.ts";
import {
  cardsFromJudgeResults,
  triggerForConclusion,
  lessonForConclusion,
} from "../reflect-cards.ts";
import { LLM_FAILURE_NOTE_PREFIX } from "../judge.ts";

function result(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    sessionId: "session-1",
    completionScore: 30,
    correctnessScore: 40,
    conclusion: "failed",
    note: "没有读文件就改了",
    ...overrides,
  };
}

describe("triggerForConclusion", () => {
  test("failed / partial / tool_misused / inefficient → judge_failed", () => {
    for (const conclusion of ["failed", "partial", "tool_misused", "inefficient"] as const) {
      expect(triggerForConclusion(conclusion)).toBe("judge_failed");
    }
  });

  test("unsafe → judge_unsafe", () => {
    expect(triggerForConclusion("unsafe")).toBe("judge_unsafe");
  });

  test("completed → 不产生卡片（没有可反思的外部信号）", () => {
    expect(triggerForConclusion("completed")).toBeNull();
  });
});

describe("cardsFromJudgeResults", () => {
  test("失败结论生成带证据的草稿", () => {
    const drafts = cardsFromJudgeResults([result()]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.trigger).toBe("judge_failed");
    expect(drafts[0]!.evidence).toEqual([
      { kind: "trace", ref: "session-1#judge", detail: "没有读文件就改了" },
    ]);
    expect(drafts[0]!.signal.completionScore).toBe(30);
    expect(drafts[0]!.appliesTo).toEqual({
      kind: "system-prompt",
      target: "prompt-overlay.md",
    });
  });

  test("completed 不产生草稿", () => {
    expect(cardsFromJudgeResults([result({ conclusion: "completed", completionScore: 95 })])).toHaveLength(0);
  });

  test("judge 调用本身失败 → 不产生草稿（评测器坏了不是被评对象的问题）", () => {
    const drafts = cardsFromJudgeResults([
      result({ note: `${LLM_FAILURE_NOTE_PREFIX}: timeout` }),
    ]);
    expect(drafts).toHaveLength(0);
  });

  test("unsafe 结论的教训强调安全动作（停止确认）", () => {
    const lesson = lessonForConclusion(result({ conclusion: "unsafe" }));
    expect(lesson).toContain("安全风险");
    expect(lesson).toContain("确认");
  });

  test("sessionIds 过滤只处理指定会话", () => {
    const drafts = cardsFromJudgeResults(
      [result({ sessionId: "a" }), result({ sessionId: "b" })],
      { sessionIds: ["b"] },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.evidence[0]!.ref).toBe("b#judge");
  });

  test("自定义写回目标透传到 appliesTo", () => {
    const drafts = cardsFromJudgeResults([result()], { target: "custom.md" });
    expect(drafts[0]!.appliesTo.target).toBe("custom.md");
  });
});
