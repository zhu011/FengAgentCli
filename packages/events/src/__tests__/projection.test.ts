/**
 * @fengagent/events — 投影测试（#2 逻辑复现 / #3 会话生命周期）
 *
 * 覆盖：
 * - session/created → title/status/model/createdAt
 * - session/title / session/status 变更
 * - user/message → 用户消息
 * - assistant 消息由 step/start + assistant/chunk 投影组装（块级/流式增量）
 * - assistant/message / turn/end.assembled（FENG_EVENT_FULL_REQUEST=1）
 * - tokenCount 收集
 * - 无 session/created 的事件流返回 null
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../event-store.ts";
import { projectSession, toEventStatus, toSessionState } from "../projection.ts";
import type { SessionEvent } from "../types.ts";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "proj-test-"));
  const store = new EventStore({ dir });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function append(store: EventStore, sessionId: string, e: Omit<SessionEvent, "version" | "sessionId" | "seq" | "hash" | "prevHash">): void {
  store.append({ sessionId, type: e.type, payload: e.payload, timestamp: e.timestamp });
}

describe("projectSession — 生命周期（#3）", () => {
  test("session/created → title/status/model/createdAt；无 created 返回 null", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", {
        type: "session/created",
        timestamp: "2026-08-16T10:00:00.000Z",
        payload: { title: "我的会话", status: "created", initialModel: "deepseek-chat" },
      });
      const s = projectSession(store.replay("s1"));
      expect(s).not.toBeNull();
      expect(s!.id).toBe("s1");
      expect(s!.title).toBe("我的会话");
      expect(s!.status).toBe("idle");
      expect(s!.model).toBe("deepseek-chat");
      expect(s!.createdAt).toBe(Date.parse("2026-08-16T10:00:00.000Z"));
      expect(s!.messages).toEqual([]);

      // 只有消息没有 created → null
      const { store: s2, cleanup: c2 } = makeStore();
      try {
        append(s2, "x", { type: "user/message", timestamp: "2026-08-16T10:00:00.000Z", payload: { messageId: "m", content: [] } });
        expect(projectSession(s2.replay("x"))).toBeNull();
      } finally {
        c2();
      }
    } finally {
      cleanup();
    }
  });

  test("session/title / session/status 变更被投影", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", { type: "session/created", timestamp: "2026-08-16T10:00:00.000Z", payload: { title: "旧标题", status: "created" } });
      append(store, "s1", { type: "session/title", timestamp: "2026-08-16T10:01:00.000Z", payload: { title: "新标题" } });
      append(store, "s1", { type: "session/status", timestamp: "2026-08-16T10:02:00.000Z", payload: { status: "running" } });
      append(store, "s1", { type: "session/status", timestamp: "2026-08-16T10:03:00.000Z", payload: { status: "idle" } });
      const s = projectSession(store.replay("s1"));
      expect(s!.title).toBe("新标题");
      expect(s!.status).toBe("idle");
      expect(s!.updatedAt).toBe(Date.parse("2026-08-16T10:03:00.000Z"));
    } finally {
      cleanup();
    }
  });
});

describe("projectSession — 消息投影（#2）", () => {
  test("user/message → 用户消息", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", { type: "session/created", timestamp: "2026-08-16T10:00:00.000Z", payload: { title: "t", status: "created" } });
      append(store, "s1", {
        type: "user/message",
        timestamp: "2026-08-16T10:00:01.000Z",
        payload: { messageId: "m1", content: [{ type: "text", text: "你好" }] },
      });
      const s = projectSession(store.replay("s1"));
      expect(s!.messages).toHaveLength(1);
      expect(s!.messages[0]).toEqual({
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "你好" }],
        createdAt: Date.parse("2026-08-16T10:00:01.000Z"),
      });
    } finally {
      cleanup();
    }
  });

  test("assistant 消息由 step/start + chunk 组装（块级）", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", { type: "session/created", timestamp: "2026-08-16T10:00:00.000Z", payload: { title: "t", status: "created" } });
      append(store, "s1", {
        type: "step/start",
        timestamp: "2026-08-16T10:00:01.000Z",
        payload: { messageId: "a1", model: "deepseek-chat" },
      });
      append(store, "s1", {
        type: "assistant/chunk",
        timestamp: "2026-08-16T10:00:01.001Z",
        payload: { messageId: "a1", index: 0, delta: { type: "text", text: "你好，" } },
      });
      append(store, "s1", {
        type: "assistant/chunk",
        timestamp: "2026-08-16T10:00:01.002Z",
        payload: { messageId: "a1", index: 1, delta: { type: "text", text: "世界！" } },
      });
      append(store, "s1", {
        type: "step/end",
        timestamp: "2026-08-16T10:00:01.003Z",
        payload: { messageId: "a1" },
      });
      const s = projectSession(store.replay("s1"));
      expect(s!.messages).toHaveLength(1);
      expect(s!.messages[0]!.role).toBe("assistant");
      expect(s!.messages[0]!.content).toEqual([
        { type: "text", text: "你好，" },
        { type: "text", text: "世界！" },
      ]);
      expect(s!.messages[0]!.createdAt).toBe(Date.parse("2026-08-16T10:00:01.000Z"));
    } finally {
      cleanup();
    }
  });

  test("流式字符串增量合并进末尾文本块", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", { type: "session/created", timestamp: "2026-08-16T10:00:00.000Z", payload: { title: "t", status: "created" } });
      append(store, "s1", { type: "step/start", timestamp: "2026-08-16T10:00:01.000Z", payload: { messageId: "a1" } });
      append(store, "s1", { type: "assistant/chunk", timestamp: "2026-08-16T10:00:01.001Z", payload: { messageId: "a1", index: 0, delta: "hello " } });
      append(store, "s1", { type: "assistant/chunk", timestamp: "2026-08-16T10:00:01.002Z", payload: { messageId: "a1", index: 1, delta: "world" } });
      append(store, "s1", { type: "step/end", timestamp: "2026-08-16T10:00:01.003Z", payload: { messageId: "a1" } });
      const s = projectSession(store.replay("s1"));
      expect(s!.messages[0]!.content).toEqual([{ type: "text", text: "hello world" }]);
    } finally {
      cleanup();
    }
  });

  test("assistant/message 直接落组装结果（FENG_EVENT_FULL_REQUEST=1）", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", { type: "session/created", timestamp: "2026-08-16T10:00:00.000Z", payload: { title: "t", status: "created" } });
      append(store, "s1", { type: "step/start", timestamp: "2026-08-16T10:00:01.000Z", payload: { messageId: "a1" } });
      append(store, "s1", { type: "assistant/message", timestamp: "2026-08-16T10:00:02.000Z", payload: { messageId: "a1", assembled: [{ type: "text", text: "完整回复" }] } });
      append(store, "s1", { type: "step/end", timestamp: "2026-08-16T10:00:02.001Z", payload: { messageId: "a1" } });
      const s = projectSession(store.replay("s1"));
      expect(s!.messages[0]!.content).toEqual([{ type: "text", text: "完整回复" }]);
    } finally {
      cleanup();
    }
  });

  test("tokenCount 从 turn/end 收集；多轮消息顺序保持", () => {
    const { store, cleanup } = makeStore();
    try {
      append(store, "s1", { type: "session/created", timestamp: "2026-08-16T10:00:00.000Z", payload: { title: "t", status: "created" } });
      // 第一轮
      append(store, "s1", { type: "user/message", timestamp: "2026-08-16T10:00:01.000Z", payload: { messageId: "u1", content: [{ type: "text", text: "q1" }] } });
      append(store, "s1", { type: "step/start", timestamp: "2026-08-16T10:00:02.000Z", payload: { messageId: "a1" } });
      append(store, "s1", { type: "assistant/chunk", timestamp: "2026-08-16T10:00:03.000Z", payload: { messageId: "a1", index: 0, delta: "A1" } });
      append(store, "s1", { type: "step/end", timestamp: "2026-08-16T10:00:04.000Z", payload: { messageId: "a1" } });
      append(store, "s1", { type: "turn/end", timestamp: "2026-08-16T10:00:05.000Z", payload: { messageId: "a1", tokenCount: 120 } });
      // 第二轮
      append(store, "s1", { type: "user/message", timestamp: "2026-08-16T10:00:06.000Z", payload: { messageId: "u2", content: [{ type: "text", text: "q2" }] } });
      append(store, "s1", { type: "step/start", timestamp: "2026-08-16T10:00:07.000Z", payload: { messageId: "a2" } });
      append(store, "s1", { type: "assistant/chunk", timestamp: "2026-08-16T10:00:08.000Z", payload: { messageId: "a2", index: 0, delta: "A2" } });
      append(store, "s1", { type: "step/end", timestamp: "2026-08-16T10:00:09.000Z", payload: { messageId: "a2" } });
      append(store, "s1", { type: "turn/end", timestamp: "2026-08-16T10:00:10.000Z", payload: { messageId: "a2", tokenCount: 220 } });
      const s = projectSession(store.replay("s1"));
      expect(s!.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
      expect(s!.tokenCount).toBe(220);
    } finally {
      cleanup();
    }
  });
});

describe("状态映射", () => {
  test("toSessionState / toEventStatus 互逆（error 归 idle）", () => {
    expect(toSessionState("running")).toBe("running");
    expect(toSessionState("created")).toBe("idle");
    expect(toSessionState("closed")).toBe("idle");
    expect(toEventStatus("running")).toBe("running");
    expect(toEventStatus("idle")).toBe("idle");
    expect(toEventStatus("error")).toBe("idle");
  });
});
