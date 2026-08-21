/**
 * @fengagent/agent — streaming 映射测试
 *
 * 覆盖 LLMEvent → AgentEvent 转换，重点验证思考过程内容
 * （thinking-delta）能实时转发到前端（Round 4 思考可视化）。
 */

import { describe, expect, test } from "bun:test";
import type { LLMEvent } from "@fengagent/llm";
import { llmEventToAgentEvents } from "../streaming.ts";

const MESSAGE_ID = "msg-1";

describe("llmEventToAgentEvents", () => {
  test("text-delta 转发为 text-delta（附带 messageId）", () => {
    const events = llmEventToAgentEvents(
      { type: "text-delta", text: "Hello" },
      MESSAGE_ID,
    );
    expect(events).toEqual([{ type: "text-delta", messageId: MESSAGE_ID, text: "Hello" }]);
  });

  test("thinking-delta 转发为 thinking-delta（思考过程实时转发）", () => {
    const events = llmEventToAgentEvents(
      { type: "thinking-delta", text: "先分析需求" },
      MESSAGE_ID,
    );
    expect(events).toEqual([
      { type: "thinking-delta", messageId: MESSAGE_ID, text: "先分析需求" },
    ]);
  });

  test("thinking-delta 多次增量累积转发（不丢流）", () => {
    const deltas: LLMEvent[] = [
      { type: "thinking-delta", text: "第一段，" },
      { type: "thinking-delta", text: "第二段" },
    ];
    const texts = deltas.flatMap((e) => llmEventToAgentEvents(e, MESSAGE_ID)).map(
      (e) => (e.type === "thinking-delta" ? e.text : ""),
    );
    expect(texts.join("")).toBe("第一段，第二段");
  });

  test("tool-call / usage / error 映射保持既有行为", () => {
    expect(
      llmEventToAgentEvents(
        { type: "tool-call", id: "call_1", name: "bash", input: { command: "ls" } },
        MESSAGE_ID,
      )[0],
    ).toMatchObject({ type: "tool-call-start", name: "bash" });

    expect(
      llmEventToAgentEvents(
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        MESSAGE_ID,
      )[0],
    ).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5 });

    expect(
      llmEventToAgentEvents(
        { type: "error", error: { message: "boom" } },
        MESSAGE_ID,
      )[0],
    ).toMatchObject({ type: "error" });
  });
});
