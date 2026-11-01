/**
 * @fengagent/dsh-compat — `ctx.sessionProjections` 兼容面验收（P3 收尾）
 *
 * 覆盖 `dsh-tool-todo-plus` 的真实用法：`register({ key, stateSchema, init,
 * apply, wire, stateVersion })` + `session.append("todo/write", …)` 驱动 + 视图
 * 推送；以及 checkpoint / restore / viewCheckpoint 的读取面。
 */

import { describe, expect, test } from "bun:test";
import type { DshSessionEvent, DshSessionHeader, DshSessionLike } from "../contracts.ts";
import { SessionEventLog } from "../session-events.ts";
import { SessionProjectionsCompat } from "../session-projections.ts";

/** 最小 zod 形状（生产里是 zod schema，这里只验 `safeParse`/`parse` 两条路径） */
function schema<T>(check: (value: unknown) => value is T) {
  return {
    safeParse(value: unknown) {
      return check(value)
        ? ({ success: true, data: value } as const)
        : ({ success: false, error: new Error("invalid") } as const);
    },
    parse(value: unknown): T {
      if (!check(value)) throw new Error("invalid");
      return value;
    },
  };
}

const isTodoList = (value: unknown): value is Array<{ content: string; status: string }> =>
  Array.isArray(value) && value.every((item) => typeof item.content === "string");

const isAnything = (value: unknown): value is unknown => value !== undefined;

/** 造一个最小 session（与 `CompatSession` 同形的结构） */
function makeSession(id: string, events: DshSessionEvent[] = []): DshSessionLike {
  const header: DshSessionHeader = { version: 1, id, createdAt: 1 };
  return {
    id,
    header,
    events,
    append(type: string, data?: unknown): DshSessionEvent {
      const event: DshSessionEvent = {
        seq: events.length,
        type,
        time: 1,
        data: (data ?? {}) as Record<string, unknown>,
      };
      events.push(event);
      return event;
    },
    requestHeader: () => undefined,
    get surface(): never {
      throw new Error("unsupported");
    },
  };
}

/** todo-plus 的投影定义（与插件里的声明同形） */
function todoProjection(registry: SessionProjectionsCompat, onDispose?: () => void): () => void {
  const dispose = registry.register({
    key: "todos",
    stateSchema: schema(isTodoList),
    init: () => null,
    apply: (state, event) => {
      if (event.type === "todo/write") {
        const todos = (event.data as { todos?: unknown }).todos;
        return Array.isArray(todos) ? todos : state;
      }
      if (event.type === "turn/start") return null;
      return state;
    },
    wire: { viewSchema: schema(isAnything), view: (state) => state },
    stateVersion: 2,
  });
  return () => {
    dispose();
    onDispose?.();
  };
}

describe("sessionProjections：注册与驱动", () => {
  test("register → stateOf 从 init 折叠已提交事件", () => {
    const registry = new SessionProjectionsCompat();
    const events: DshSessionEvent[] = [];
    const session = makeSession("s1", events);
    session.append("todo/write", { todos: [{ content: "写测试", status: "pending" }] });

    todoProjection(registry);
    expect(registry.stateOf(session, "todos")).toEqual([{ content: "写测试", status: "pending" }]);
  });

  test("drive 推进状态；返回同一引用的事件不产生工作", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    todoProjection(registry);

    const first = session.append("todo/write", { todos: [{ content: "a", status: "pending" }] });
    registry.drive(session, first);
    expect(registry.stateOf(session, "todos")).toEqual([{ content: "a", status: "pending" }]);

    const unrelated = session.append("other/event", {});
    const before = registry.stateOf(session, "todos");
    registry.drive(session, unrelated);
    expect(registry.stateOf(session, "todos")).toBe(before);

    const cleared = session.append("turn/start", {});
    registry.drive(session, cleared);
    expect(registry.stateOf(session, "todos")).toBeNull();
  });

  test("snapshot 只含 wire 单元并校验视图；onChanged 只在视图引用变化时推送", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    todoProjection(registry);
    registry.register({
      key: "host-only",
      stateSchema: schema((value): value is number => typeof value === "number"),
      init: () => 0,
      apply: (state) => state,
      stateVersion: 1,
    });

    const changed: Array<{ key: string; value: unknown }> = [];
    registry.onChanged((_session, key, value) => changed.push({ key, value }));

    const event = session.append("todo/write", { todos: [{ content: "x", status: "pending" }] });
    registry.drive(session, event);
    expect(changed).toEqual([{ key: "todos", value: [{ content: "x", status: "pending" }] }]);

    const snapshot = registry.snapshot(session);
    expect(Object.keys(snapshot.values)).toEqual(["todos"]);
    expect(snapshot.asOfSeq).toBe(0);
    expect(registry.stateOf(session, "host-only")).toBe(0);
  });

  test("未注册的 key：stateOf 返回 undefined，snapshot 为空", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    expect(registry.stateOf(session, "nope")).toBeUndefined();
    expect(registry.snapshot(session)).toEqual({ asOfSeq: -1, values: {} });
  });

  test("同名注册按引用计数：最后一个 disposer 才移除单元与缓存", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    const disposeFirst = todoProjection(registry);
    const disposeSecond = todoProjection(registry);
    expect(registry.registeredKeys).toEqual(["todos"]);

    disposeFirst();
    expect(registry.registeredKeys).toEqual(["todos"]);
    expect(registry.stateOf(session, "todos")).toBeNull();

    disposeSecond();
    expect(registry.registeredKeys).toEqual([]);
    expect(registry.stateOf(session, "todos")).toBeUndefined();
  });

  test("非法定义被拒绝：空 key / 缺 apply / 负 stateVersion", () => {
    const registry = new SessionProjectionsCompat();
    expect(() =>
      registry.register({
        key: "",
        stateSchema: schema(isAnything),
        init: () => null,
        apply: (state) => state,
        stateVersion: 1,
      }),
    ).toThrow(/definition.key/);
    expect(() =>
      registry.register({
        key: "k",
        stateSchema: schema(isAnything),
        init: () => null,
        apply: undefined as never,
        stateVersion: 1,
      }),
    ).toThrow(/needs init\(\) and apply\(\)/);
    expect(() =>
      registry.register({
        key: "k",
        stateSchema: schema(isAnything),
        init: () => null,
        apply: (state) => state,
        stateVersion: -1,
      }),
    ).toThrow(/stateVersion/);
  });
});

describe("sessionProjections：检查点与冷读", () => {
  test("checkpoint 是脱离活引用的克隆；restore 从检查点续折；viewCheckpoint 只认版本匹配的行", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    todoProjection(registry);

    const first = session.append("todo/write", { todos: [{ content: "a", status: "pending" }] });
    registry.drive(session, first);
    const checkpoint = registry.checkpoint(session);
    expect(checkpoint.todos?.ver).toBe(2);
    expect(checkpoint.todos?.val).toEqual([{ content: "a", status: "pending" }]);
    // 克隆：改检查点不影响活状态
    (checkpoint.todos!.val as Array<{ content: string }>)[0]!.content = "mutated";
    expect(registry.stateOf(session, "todos")).toEqual([{ content: "a", status: "pending" }]);

    expect(registry.restoreFloor(checkpoint)).toBe(0);
    expect(registry.viewCheckpoint(checkpoint)).toEqual({
      todos: [{ content: "mutated", status: "pending" }],
    });
    expect(registry.viewCheckpoint({ todos: { ...checkpoint.todos!, ver: 1 } })).toEqual({});

    const tail: DshSessionEvent[] = [
      { seq: 0, type: "todo/write", time: 1, data: { todos: [{ content: "b", status: "completed" }] } },
    ];
    const restored = registry.restore({}, tail, 0, session.header, 0);
    expect(restored.snapshot.values.todos).toEqual([{ content: "b", status: "completed" }]);
    expect(restored.snapshot.asOfSeq).toBe(0);
  });

  test("restore 在没有可用检查点且 baseSeq>0 时抛错（要求从头折）", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    todoProjection(registry);
    expect(() => registry.restore({}, [], 3, session.header, 0)).toThrow(/refold from seq 0/);
  });

  test("cachedSnapshot 只读已物化单元", () => {
    const registry = new SessionProjectionsCompat();
    const session = makeSession("s1");
    todoProjection(registry);
    expect(registry.cachedSnapshot(session)).toBeUndefined();
    registry.stateOf(session, "todos");
    expect(registry.cachedSnapshot(session)?.values.todos).toBeNull();
  });
});

describe("session-events：进程内领域事件日志", () => {
  test("append 单调 seq；list/size/clear", () => {
    const log = new SessionEventLog();
    const a = log.append("s1", "todo/write", { todos: [] });
    const b = log.append("s1", "turn/start", {});
    expect([a.seq, b.seq]).toEqual([0, 1]);
    expect(log.size("s1")).toBe(2);
    expect(log.list("s1").map((event) => event.type)).toEqual(["todo/write", "turn/start"]);
    expect(log.clear("s1")).toBe(true);
    expect(log.size("s1")).toBe(0);
    expect(log.list("missing")).toEqual([]);
  });

  test("空事件类型被拒绝", () => {
    const log = new SessionEventLog();
    expect(() => log.append("s1", "", {})).toThrow(/non-empty string/);
  });
});
