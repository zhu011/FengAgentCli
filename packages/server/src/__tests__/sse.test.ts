/**
 * @fengagent/server — SSE 工具测试
 */

import { describe, it, expect } from "bun:test";
import {
  agentEventToSSE,
  encodeSSEFrame,
  encodeAgentEventStream,
  SSE_HEARTBEAT,
} from "../sse.ts";
import type { AgentEvent } from "@fengagent/core";

describe("SSE helpers", () => {
  it("agentEventToSSE — text-delta 事件", () => {
    const event: AgentEvent = {
      type: "text-delta",
      messageId: "msg-1",
      text: "hello",
    };
    const frame = agentEventToSSE(event);

    expect(frame.event).toBe("text-delta");
    expect(JSON.parse(frame.data)).toEqual(event);
  });

  it("agentEventToSSE — session-start 事件", () => {
    const event: AgentEvent = {
      type: "session-start",
      session: {
        id: "s-1",
        title: "Test",
        messages: [],
        model: "test-model",
        createdAt: 1000,
        updatedAt: 1000,
        status: "idle",
        tokenCount: 0,
      },
    };
    const frame = agentEventToSSE(event);

    expect(frame.event).toBe("session-start");
    expect(JSON.parse(frame.data)).toEqual(event);
  });

  it("agentEventToSSE — error 事件", () => {
    const event: AgentEvent = {
      type: "error",
      error: { message: "something went wrong" },
    };
    const frame = agentEventToSSE(event);

    expect(frame.event).toBe("error");
    expect(JSON.parse(frame.data)).toEqual(event);
  });

  it("encodeSSEFrame — 生成正确的 SSE 文本格式", () => {
    const frame = { event: "text-delta", data: '{"text":"hi"}' };
    const encoded = encodeSSEFrame(frame);

    expect(encoded).toBe('event: text-delta\ndata: {"text":"hi"}\n\n');
  });

  it("SSE_HEARTBEAT — 注释行格式", () => {
    expect(SSE_HEARTBEAT).toBe(": heartbeat\n\n");
  });

  it("encodeAgentEventStream — 流式编码", async () => {
    const events: AgentEvent[] = [
      { type: "text-delta", messageId: "m1", text: "a" },
      { type: "text-delta", messageId: "m1", text: "b" },
      { type: "message-end", messageId: "m1" },
    ];

    async function* gen(): AsyncGenerator<AgentEvent> {
      for (const e of events) yield e;
    }

    const result: string[] = [];
    for await (const chunk of encodeAgentEventStream(gen())) {
      result.push(chunk);
    }

    expect(result.length).toBe(3);
    expect(result[0]).toContain("event: text-delta");
    expect(result[2]).toContain("event: message-end");
  });
});
