/**
 * @fengagent/events — EventStore 测试（Phase 1 写路径 / 重放 / 崩溃自愈）
 *
 * 覆盖：
 * - 每会话单文件 append-only（events/{sessionId}.jsonl），多会话隔离
 * - seq 单调递增 + #5 hash/prevHash 链（确定性哈希）
 * - append 校验走运行时注册表（#1）：未注册类型拒绝、registerEventType 后放行
 * - isSessionEvent 走注册表
 * - 重放按 seq 返回
 * - 尾部半行 JSON 崩溃自愈：healTail 截断、后续 append 从正确 seq 继续
 * - 无尾部换行的完整行视为完整（宽容读取）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  EventStore,
  createEventRegistry,
  type SessionEvent,
} from "../index.ts";

let dir: string;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "events-test-"));
  store = new EventStore({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EventStore 写路径", () => {
  test("append 落盘为 events/{sessionId}.jsonl，每行一条事件", () => {
    const e1 = store.append({
      sessionId: "s1",
      type: "session/created",
      payload: { title: "会话", status: "created" },
      timestamp: "2026-08-16T00:00:00.000Z",
    });
    store.append({
      sessionId: "s1",
      type: "user/message",
      payload: { messageId: "m1", content: [{ type: "text", text: "你好" }] },
      timestamp: "2026-08-16T00:00:01.000Z",
    });
    const path = store.pathFor("s1");
    expect(path).toBe(join(dir, "s1.jsonl"));
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as SessionEvent);
    expect(parsed[0]!.type).toBe("session/created");
    expect(parsed[1]!.type).toBe("user/message");
    expect(e1.sessionId).toBe("s1");
  });

  test("seq 单调递增，多会话各自独立", () => {
    const a1 = store.append({ sessionId: "a", type: "session/created", payload: { title: "A", status: "created" } });
    const a2 = store.append({ sessionId: "a", type: "session/title", payload: { title: "A2" } });
    const b1 = store.append({ sessionId: "b", type: "session/created", payload: { title: "B", status: "created" } });
    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1);
    expect(store.lastSeq("a")).toBe(2);
    expect(store.lastSeq("b")).toBe(1);
    expect(store.lastSeq("nonexistent")).toBe(0);
  });

  test("hash/prevHash 链：#5 信封，首事件 prevHash=null", () => {
    const e1 = store.append({
      sessionId: "s1",
      type: "session/created",
      payload: { title: "t", status: "created" },
      timestamp: "2026-08-16T00:00:00.000Z",
    });
    const e2 = store.append({
      sessionId: "s1",
      type: "session/title",
      payload: { title: "t2" },
      timestamp: "2026-08-16T00:00:01.000Z",
    });
    expect(e1.prevHash).toBeNull();
    expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e2.hash).toMatch(/^[0-9a-f]{64}$/);
    // 确定性：同负载同哈希
    const e1b = store.append({
      sessionId: "s2",
      type: "session/created",
      payload: { title: "t", status: "created" },
      timestamp: "2026-08-16T00:00:00.000Z",
    });
    expect(e1b.hash).toBe(e1.hash);
  });
});

describe("EventStore 注册表校验（#1）", () => {
  test("未注册类型 append 被拒绝", () => {
    expect(() =>
      store.append({ sessionId: "s1", type: "custom/not-registered", payload: {} }),
    ).toThrow(/未注册或校验失败/);
  });

  test("registerEventType 注册后 append 放行（运行时扩展）", () => {
    store.registry.registerEventType("custom/foo", (e) => e.payload !== null);
    const ev = store.append({
      sessionId: "s1",
      type: "custom/foo",
      payload: { foo: 1 },
    });
    expect(ev.seq).toBe(1);
    expect(store.replay("s1")).toHaveLength(1);
  });

  test("校验器返回 false 时 append 拒绝", () => {
    store.registry.registerEventType("custom/reject", () => false);
    expect(() =>
      store.append({ sessionId: "s1", type: "custom/reject", payload: {} }),
    ).toThrow(/未注册或校验失败/);
  });

  test("isSessionEvent 走注册表：合法事件 true，未注册类型/坏信封 false", () => {
    const ok = store.append({
      sessionId: "s1",
      type: "session/created",
      payload: { title: "t", status: "created" },
    });
    expect(store.isSessionEvent(ok)).toBe(true);
    expect(store.isSessionEvent({ ...ok, type: "custom/nope" })).toBe(false);
    expect(store.isSessionEvent({ ...ok, payload: undefined })).toBe(false);
    expect(store.isSessionEvent(null)).toBe(false);
    expect(store.isSessionEvent("string")).toBe(false);
  });
});

describe("EventStore 重放", () => {
  test("replay 按 seq 顺序返回全部事件", () => {
    store.append({ sessionId: "s1", type: "session/created", payload: { title: "t", status: "created" }, timestamp: "2026-08-16T00:00:00.000Z" });
    store.append({ sessionId: "s1", type: "user/message", payload: { messageId: "m1", content: [] }, timestamp: "2026-08-16T00:00:01.000Z" });
    store.append({ sessionId: "s1", type: "turn/end", payload: { messageId: "m1", tokenCount: 10 }, timestamp: "2026-08-16T00:00:02.000Z" });
    const events = store.replay("s1");
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual(["session/created", "user/message", "turn/end"]);
    // 不存在的会话返回空
    expect(store.replay("ghost")).toEqual([]);
  });
});

describe("EventStore 崩溃自愈（尾部半行）", () => {
  test("replay 跳过尾部半行并截断，后续 append 从正确 seq 继续", () => {
    store.append({ sessionId: "s1", type: "session/created", payload: { title: "t", status: "created" } });
    store.append({ sessionId: "s1", type: "user/message", payload: { messageId: "m1", content: [] } });
    // 模拟崩溃：尾部残留半行 JSON（无换行结尾）
    const path = store.pathFor("s1");
    appendFileSync(path, '{"version":1,"sessionId":"s1","seq":3,"type":"turn/en', "utf8");

    // 重放只返回完整事件
    const events = store.replay("s1");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);

    // 自愈后追加从 seq=3 继续
    const e3 = store.append({ sessionId: "s1", type: "turn/end", payload: { messageId: "m1", tokenCount: 5 } });
    expect(e3.seq).toBe(3);
    expect(e3.prevHash).toBe(events[1]!.hash);

    // 文件恢复为 3 行完整 JSON
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  test("healTail 返回被截断字节数；无残留返回 0", () => {
    store.append({ sessionId: "s1", type: "session/created", payload: { title: "t", status: "created" } });
    expect(store.healTail("s1")).toBe(0);
    const path = store.pathFor("s1");
    const garbage = '{"partial":true';
    appendFileSync(path, garbage, "utf8");
    const healed = store.healTail("s1");
    expect(healed).toBe(Buffer.byteLength(garbage, "utf8"));
    expect(store.replay("s1")).toHaveLength(1);
    expect(store.healTail("s1")).toBe(0); // 已恢复
  });

  test("末尾完整行但无换行符：宽容读取为完整，append 自动补换行不粘连", () => {
    store.append({ sessionId: "s1", type: "session/created", payload: { title: "t", status: "created" } });
    const path = store.pathFor("s1");
    // 去掉末尾换行（模拟最后一行写入后崩溃在换行前）
    const withoutNl = readFileSync(path, "utf8").replace(/\n$/, "");
    rmSync(path);
    appendFileSync(path, withoutNl, "utf8");
    expect(store.replay("s1")).toHaveLength(1);
    const e2 = store.append({ sessionId: "s1", type: "user/message", payload: { messageId: "m1", content: [] } });
    expect(e2.seq).toBe(2);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  test("selfHeal=false 时不截断（只读场景）", () => {
    const ro = new EventStore({ dir, selfHeal: false });
    ro.append({ sessionId: "s1", type: "session/created", payload: { title: "t", status: "created" } });
    const path = ro.pathFor("s1");
    appendFileSync(path, '{"partial":', "utf8");
    expect(ro.replay("s1")).toHaveLength(1);
    // 未截断：文件仍含半行
    expect(readFileSync(path, "utf8")).toContain('{"partial":');
    expect(ro.healTail("s1")).toBe(0);
  });
});

describe("EventStore 边界", () => {
  test("自定义 registry 注入（ctx.events 复用点）", () => {
    const registry = createEventRegistry();
    const custom = new EventStore({ dir, registry });
    custom.registry.registerEventType("plugin/event", () => true);
    const ev = custom.append({ sessionId: "s", type: "plugin/event", payload: { x: 1 } });
    expect(ev.seq).toBe(1);
    // 注入同一 registry 的新 store 共享注册表
    const shared = new EventStore({ dir, registry });
    expect(shared.isSessionEvent(ev)).toBe(true);
  });

  test("会话 id 中的危险字符被安全化（文件名防穿越）", () => {
    const ev = store.append({ sessionId: "a/b\\c", type: "session/created", payload: { title: "t", status: "created" } });
    const p = store.pathFor("a/b\\c");
    // 只检查文件名本身（Windows 目录分隔符反斜杠不属于文件名部分）
    expect(basename(p)).toBe("a_b_c.jsonl");
    expect(basename(p)).not.toContain("/");
    expect(basename(p)).not.toContain("\\");
    expect(store.replay(ev.sessionId)).toHaveLength(1);
  });

  test("空文件 / 不存在文件按无事件处理", () => {
    expect(store.replay("missing")).toEqual([]);
    expect(store.lastSeq("missing")).toBe(0);
    expect(store.healTail("missing")).toBe(0);
  });
});
