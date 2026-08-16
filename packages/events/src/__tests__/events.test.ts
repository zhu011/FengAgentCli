/**
 * @fengagent/events — 类型级测试（Phase 0：零运行时行为变化）
 *
 * 覆盖：
 * - SESSION_EVENT_TYPES 常量完整性 / 唯一性
 * - SessionEvent 判别联合的 type ↔ payload 联动（编译期 + 运行时结构）
 * - hash/prevHash 信封字段（#5）
 * - 注册表接口的最小实现（#1）
 */

import { describe, test, expect, expectTypeOf } from "bun:test";
import {
  SESSION_EVENT_TYPES,
  createEventRegistry,
  type SessionEvent,
  type SessionEventBase,
  type SessionEventPayloads,
  type SessionEventRegistry,
  type SessionStatus,
} from "../index.ts";

describe("SESSION_EVENT_TYPES", () => {
  test("包含 #2/#3/#6 核心事件类型", () => {
    const types = new Set(SESSION_EVENT_TYPES);
    expect(types.has("session/created")).toBe(true);
    expect(types.has("session/title")).toBe(true);
    expect(types.has("session/status")).toBe(true);
    expect(types.has("user/message")).toBe(true);
    expect(types.has("step/start")).toBe(true);
    expect(types.has("assistant/chunk")).toBe(true);
    expect(types.has("assistant/message")).toBe(true);
    expect(types.has("turn/end")).toBe(true);
    expect(types.has("node/quality")).toBe(true);
    expect(types.has("rollback")).toBe(true);
    expect(types.has("fork")).toBe(true);
  });

  test("类型唯一（无重复）", () => {
    expect(new Set(SESSION_EVENT_TYPES).size).toBe(SESSION_EVENT_TYPES.length);
  });

  test("SESSION_EVENT_TYPES 为只读常量", () => {
    // @ts-expect-error — 常量数组不可写（as const 只读元组）
    SESSION_EVENT_TYPES[0] = "session/created";
    expect(SESSION_EVENT_TYPES[0]).toBe("session/created");
  });
});

describe("SessionEvent 类型（编译期）", () => {
  test("type ↔ payload 联动：session/created 负载含 title/status", () => {
    const event: SessionEvent<"session/created"> = {
      version: 1,
      sessionId: "s1",
      seq: 1,
      type: "session/created",
      timestamp: "2026-08-16T00:00:00.000Z",
      hash: "h",
      prevHash: null,
      payload: { title: "t", status: "created" },
    };
    expectTypeOf(event.payload.title).toBeString();
    expectTypeOf(event.payload.status).toEqualTypeOf<"created" | "running" | "idle" | "closed">();
  });

  test("node/quality 负载为事实事件（#6）", () => {
    const event: SessionEvent<"node/quality"> = {
      version: 1,
      sessionId: "s1",
      seq: 2,
      type: "node/quality",
      timestamp: "2026-08-16T00:00:00.000Z",
      hash: "h2",
      prevHash: "h",
      payload: { nodeId: "n1", quality: "poor", note: "用户回退" },
    };
    expectTypeOf(event.payload.quality).toEqualTypeOf<"good" | "poor" | "unrated">();
  });

  test("错误负载类型在编译期被拒绝", () => {
    const bad: SessionEvent<"session/title"> = {
      version: 1,
      sessionId: "s1",
      seq: 1,
      type: "session/title",
      timestamp: "t",
      hash: "h",
      prevHash: null,
      // @ts-expect-error — session/title 的负载只允许 title 字段
      payload: { status: "running" },
    };
    expect(bad).toBeDefined();
  });

  test("信封含 hash/prevHash（#5）", () => {
    const event: SessionEvent = {
      version: 1,
      sessionId: "s1",
      seq: 1,
      type: "turn/end",
      timestamp: "t",
      hash: "sha256",
      prevHash: "prev",
      payload: { messageId: "m1" },
    };
    expectTypeOf(event.hash).toBeString();
    expectTypeOf(event.prevHash).toEqualTypeOf<string | null>();
    const base: SessionEventBase = event;
    expect(base.prevHash).toBe("prev");
  });
});

describe("createEventRegistry（#1 注册表契约）", () => {
  test("预置核心类型均可校验", () => {
    const reg: SessionEventRegistry = createEventRegistry();
    const event: SessionEvent<"session/created"> = {
      version: 1,
      sessionId: "s1",
      seq: 1,
      type: "session/created",
      timestamp: "t",
      hash: "h",
      prevHash: null,
      payload: { title: "t", status: "created" },
    };
    expect(reg.has("session/created")).toBe(true);
    expect(reg.validate(event)).toBe(true);
  });

  test("未注册类型校验失败", () => {
    const reg = createEventRegistry();
    expect(reg.has("custom/type")).toBe(false);
    const event = {
      version: 1 as const,
      sessionId: "s1",
      seq: 1,
      type: "custom/type" as const,
      timestamp: "t",
      hash: "h",
      prevHash: null,
      payload: {},
    };
    expect(reg.validate(event as unknown as SessionEvent)).toBe(false);
  });

  test("自定义类型注册校验器后生效（运行时扩展）", () => {
    const reg = createEventRegistry();
    reg.registerEventType("custom/type", (e) => e.payload !== null && e.seq > 0);
    expect(reg.has("custom/type")).toBe(true);
    const ok = {
      version: 1 as const,
      sessionId: "s1",
      seq: 5,
      type: "custom/type" as const,
      timestamp: "t",
      hash: "h",
      prevHash: null,
      payload: { foo: "bar" },
    };
    expect(reg.validate(ok as unknown as SessionEvent)).toBe(true);
  });

  test("校验器返回 false 或抛错视为校验失败", () => {
    const reg = createEventRegistry();
    reg.registerEventType("custom/reject", () => false);
    reg.registerEventType("custom/throw", () => {
      throw new Error("boom");
    });
    const base = {
      version: 1 as const,
      sessionId: "s1",
      seq: 1,
      timestamp: "t",
      hash: "h",
      prevHash: null,
    };
    expect(
      reg.validate({ ...base, type: "custom/reject" as const, payload: {} } as unknown as SessionEvent),
    ).toBe(false);
    expect(
      reg.validate({ ...base, type: "custom/throw" as const, payload: {} } as unknown as SessionEvent),
    ).toBe(false);
  });

  test("SessionEventPayloads 可被 declare module 扩展（编译期钩子）", () => {
    // 该接口必须存在且可合并（Phase 0 只验证类型骨架）
    expectTypeOf<keyof SessionEventPayloads>().toMatchTypeOf<string>();
    expectTypeOf<SessionEventPayloads["session/created"]>().toMatchTypeOf<{
      title: string;
      status: SessionStatus;
    }>();
  });
});
