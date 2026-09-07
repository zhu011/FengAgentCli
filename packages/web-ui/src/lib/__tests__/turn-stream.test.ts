/**
 * @fengagent/web-ui — SSE 轮次流式渲染状态机测试
 *
 * 覆盖：
 * 1. 正常流式渲染：单轮多步骤聚合进同一助手气泡，delta 累积、end 关闭；
 * 2. AGE-29 R1：运行中 rejoin（页面刷新 / 第二 tab / 切回）时，GET /:id/events
 *    会把本次运行已产生的事件整轮回放，而展示列表已由快照/本地流构建 ——
 *    message-start 按 messageId 去重：已完成轮次不再复制（行数与步骤数不变），
 *    流式 delta 原位更新既有行（含快照投影的单步扁平行）；
 * 3. 回放中本就不存在的新步骤（快照尚未包含的进行中步骤）仍正常新建行。
 *
 * 运行：bun test packages/web-ui/src/lib/__tests__/turn-stream.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  ContentBlock,
  Message,
  Session,
} from "../../api/types.ts";
import { sessionToTurnMessages } from "../turn-messages.ts";
import type { DisplayMessage } from "../turn-messages.ts";
import { createTurnStreamCtx, handleTurnEvent } from "../turn-stream.ts";

// ──────────────────────────────────────────────
// 构造辅助
// ──────────────────────────────────────────────

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function msg(
  id: string,
  role: Message["role"],
  blocks: ContentBlock[],
): Message {
  return { id, role, content: blocks, createdAt: 1000 };
}

function makeSession(messages: Message[]): Session {
  return {
    id: "s1",
    title: "test",
    model: "mock",
    status: "idle",
    tokenCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    messages,
  };
}

/** 以可变数组为底的流式渲染测试上下文（模拟 use-session 的状态切片 + ref 镜像） */
function makeHarness(initial: DisplayMessage[]) {
  let messages = initial;
  const ctx = createTurnStreamCtx({
    setDisplayMessages: (updater) => {
      messages = typeof updater === "function" ? updater(messages) : updater;
    },
    readMessages: () => messages,
    setError: () => {},
    setSessionTokenStats: () => {},
  });
  const feed = (events: AgentEvent[]): void => {
    for (const e of events) handleTurnEvent(e, ctx);
  };
  return {
    ctx,
    feed,
    messages: () => messages,
  };
}

/** 一轮完整回复的流式事件序列 */
function fullTurnEvents(opts: {
  step1: { messageId: string; text: string };
  step2?: { messageId: string; text: string };
  hasToolCall?: boolean;
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  const s1 = opts.step1;
  events.push({ type: "message-start", messageId: s1.messageId, role: "assistant" });
  for (const ch of s1.text) {
    events.push({ type: "text-delta", messageId: s1.messageId, text: ch });
  }
  if (opts.hasToolCall) {
    events.push({
      type: "tool-call-start",
      toolUseId: "tool-1",
      name: "grep",
      input: { pattern: "x" },
    });
    events.push({
      type: "tool-call-result",
      toolUseId: "tool-1",
      input: { pattern: "x" },
      result: { content: "hit" },
    });
  }
  events.push({ type: "message-end", messageId: s1.messageId });
  if (opts.step2) {
    const s2 = opts.step2;
    events.push({ type: "message-start", messageId: s2.messageId, role: "assistant" });
    for (const ch of s2.text) {
      events.push({ type: "text-delta", messageId: s2.messageId, text: ch });
    }
    events.push({ type: "message-end", messageId: s2.messageId });
  }
  events.push({ type: "turn-end", reason: "end_turn" });
  events.push({ type: "session-end" });
  return events;
}

// ──────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────

describe("handleTurnEvent — 流式渲染", () => {
  test("正常流式：同轮多步骤聚合进同一助手气泡，delta 累积", () => {
    const h = makeHarness([]);
    h.feed([
      { type: "session-start", session: makeSession([msg("u1", "user", [textBlock("hi")])]) },
    ]);
    h.feed([
      { type: "message-start", messageId: "a1", role: "assistant" },
      { type: "text-delta", messageId: "a1", text: "你" },
      { type: "text-delta", messageId: "a1", text: "好" },
      { type: "message-end", messageId: "a1" },
      { type: "message-start", messageId: "a2", role: "assistant" },
      { type: "text-delta", messageId: "a2", text: "再见" },
      { type: "message-end", messageId: "a2" },
      { type: "turn-end", reason: "end_turn" },
      { type: "session-end" },
    ]);

    const rows = h.messages().filter((m) => m.role === "assistant");
    // 同轮两步骤聚合进同一气泡
    expect(rows).toHaveLength(1);
    expect(rows[0]!.steps).toHaveLength(2);
    expect(rows[0]!.text).toBe("你好\n\n再见");
    // session-end 后行不再 streaming
    expect(rows[0]!.streaming).toBe(false);
    expect(rows[0]!.steps!.every((s) => !s.streaming)).toBe(true);
  });

  test("R1：rejoin 回放已完成轮次 → 行不重复、delta 不产生新步骤", () => {
    // 快照（运行中刷新 / 二 tab）已包含该轮：用户提问 + 单步助手回答
    const snapshot = makeSession([
      msg("u1", "user", [textBlock("调研一下")]),
      msg("a1", "assistant", [textBlock("结果：…")]),
    ]);
    const initial = sessionToTurnMessages(snapshot.messages);
    expect(initial.filter((m) => m.role === "assistant")).toHaveLength(1);

    const h = makeHarness(initial);
    // GET /:id/events 回放整轮事件（该轮 messageId 与快照同一批）
    h.feed(fullTurnEvents({ step1: { messageId: "a1", text: "结果：…" } }));

    const rows = h.messages().filter((m) => m.role === "assistant");
    expect(rows).toHaveLength(1); // 不再复制出第二行
    expect(rows[0]!.text).toBe("结果：…");
    // 快照单步助手行保持扁平（不因回放 message-start 复制出第二行 / 步骤数组）
    expect(rows[0]!.steps).toBeUndefined();
    expect(rows[0]!.streaming).toBe(false);
  });

  test("R1：rejoin 回放已完成多步轮次 → 步骤数不变", () => {
    // 快照：多步轮（工具步骤 + 最终文字）
    const snapshot = makeSession([
      msg("u1", "user", [textBlock("查一下")]),
      msg("a1", "assistant", [{ type: "tool-use", id: "tool-1", name: "grep", input: {} }]),
      msg("r1", "user", [{ type: "tool-result", toolUseId: "tool-1", content: "hit" }]),
      msg("a2", "assistant", [textBlock("查到 1 条")]),
    ]);
    const initial = sessionToTurnMessages(snapshot.messages);
    const rows0 = initial.filter((m) => m.role === "assistant");
    expect(rows0).toHaveLength(1);
    expect(rows0[0]!.steps).toHaveLength(2);

    const h = makeHarness(initial);
    h.feed(
      fullTurnEvents({
        step1: { messageId: "a1", text: "" },
        step2: { messageId: "a2", text: "查到 1 条" },
        hasToolCall: true,
      }),
    );

    const rows = h.messages().filter((m) => m.role === "assistant");
    expect(rows).toHaveLength(1); // 不复制行
    expect(rows[0]!.steps).toHaveLength(2); // 不重复追加步骤
    expect(rows[0]!.steps!.map((s) => s.messageId)).toEqual(["a1", "a2"]);
    expect(rows[0]!.toolCalls).toHaveLength(1);
    expect(rows[0]!.toolCalls[0]!.status).toBe("completed");
  });

  test("R1：快照单步扁平行（无 steps）被回放原位更新", () => {
    // 快照投影对单步助手省略 steps —— 回放 delta 应原位更新扁平字段而非新建行
    const snapshot = makeSession([
      msg("u1", "user", [textBlock("写首诗")]),
      msg("a1", "assistant", [textBlock("未完成")]),
    ]);
    const initial = sessionToTurnMessages(snapshot.messages);
    const flat = initial.find((m) => m.role === "assistant");
    expect(flat).toBeDefined();
    expect(flat!.steps).toBeUndefined(); // 快照单步 → 扁平行

    const h = makeHarness(initial);
    h.feed(fullTurnEvents({ step1: { messageId: "a1", text: "春眠不觉晓" } }));

    const rows = h.messages().filter((m) => m.role === "assistant");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("春眠不觉晓"); // 回放 delta 原位更新扁平行
    expect(rows[0]!.streaming).toBe(false); // message-end 关闭
  });

  test("R1：回放中快照尚未包含的新步骤 → 正常新建行", () => {
    // 运行中 rejoin：已完成轮在快照里，进行中的新轮只在回放里
    const snapshot = makeSession([
      msg("u1", "user", [textBlock("上一轮")]),
      msg("a1", "assistant", [textBlock("上一轮回答")]),
    ]);
    const initial = sessionToTurnMessages(snapshot.messages);
    const h = makeHarness(initial);

    // 回放：已完成轮（去重）+ 进行中新轮的 message-start/delta（新建行）
    const replay: AgentEvent[] = [
      ...fullTurnEvents({ step1: { messageId: "a1", text: "上一轮回答" } }),
      { type: "message-start", messageId: "a-new", role: "assistant" },
      { type: "text-delta", messageId: "a-new", text: "进行中" },
    ];
    h.feed(replay);

    const rows = h.messages().filter((m) => m.role === "assistant");
    expect(rows).toHaveLength(2); // 旧轮不重复 + 新轮正常出现
    const newRow = rows.find((m) => m.id === "a-new");
    expect(newRow).toBeDefined();
    expect(newRow!.text).toBe("进行中");
  });

  test("R1：同一步骤的重复 message-start 只渲染一次", () => {
    // 服务端重复投递同一 message-start（防御性）：不产生第二行/步骤
    const h = makeHarness([]);
    h.feed([
      { type: "message-start", messageId: "a1", role: "assistant" },
      { type: "text-delta", messageId: "a1", text: "第一段" },
    ]);
    h.feed([
      { type: "message-start", messageId: "a1", role: "assistant" },
      { type: "text-delta", messageId: "a1", text: "第" },
      { type: "text-delta", messageId: "a1", text: "二段" },
    ]);
    const rows = h.messages().filter((m) => m.role === "assistant");
    expect(rows).toHaveLength(1);
    // 第二次重复 message-start 不入新步骤：仍在同一行同一步骤累积
    expect(rows[0]!.steps ?? []).toHaveLength(1);
    expect(rows[0]!.text).toBe("第一段第二段");
  });
});
