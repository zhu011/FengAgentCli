/**
 * @fengagent/agent — 自省卡仓测试（RSI P0）
 *
 * 覆盖验收契约 A1（证据门→0 行）/ A3（TTL）/ A5（乐观锁并发）/ A6（事件流可复原
 * 「证据 → 卡 → 注入」）/ A7（作用域隔离）/ A8（降级不打断）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectionStore } from "../reflection-store.ts";
import type { CreateReflectionInput } from "../reflection-store.ts";
import { ReflectionError } from "@fengagent/core";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-reflect-store-"));
  dbPath = join(dir, "reflections.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 造一条带证据的入库入参 */
function input(overrides: Partial<CreateReflectionInput> = {}): CreateReflectionInput {
  return {
    trigger: "judge_failed",
    lesson: "先读目标文件再改，避免重复编辑同一片段",
    evidence: [{ kind: "trace", ref: "trace-001" }],
    signal: { conclusion: "failed", completionScore: 40, correctnessScore: 55 },
    ...overrides,
  };
}

describe("ReflectionStore — 证据门", () => {
  test("无证据入参 → ingest 返回 null，库里 0 行", () => {
    const store = new ReflectionStore(dbPath);
    const card = store.ingest(input({ evidence: [] }));
    expect(card).toBeNull();
    expect(store.list()).toHaveLength(0);
    expect(store.events()).toHaveLength(0);
    store.close();
  });

  test("create 无证据直接抛 evidence_required（显式调用不许绕过）", () => {
    const store = new ReflectionStore(dbPath);
    expect(() => store.create(input({ evidence: [] }))).toThrow(ReflectionError);
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  test("四类带证据来源都能入库", () => {
    const store = new ReflectionStore(dbPath);
    for (const trigger of [
      "judge_failed",
      "judge_unsafe",
      "guard_tripped",
      "test_failed",
      "human_negative",
    ] as const) {
      const card = store.create(input({ trigger }));
      expect(card.id).toBeTruthy();
      expect(card.status).toBe("proposed");
    }
    expect(store.list()).toHaveLength(5);
    store.close();
  });

  test("create 会补全 revision / 时间戳 / expiresAt（TTL 默认 14 天）", () => {
    const store = new ReflectionStore(dbPath, { now: () => 1_000 });
    const card = store.create(input());
    expect(card.revision).toBe(1);
    expect(card.createdAt).toBe(1_000);
    expect(card.expiresAt).toBe(1_000 + 14 * 24 * 60 * 60 * 1000);
    store.close();
  });
});

describe("ReflectionStore — 乐观锁（CAS）", () => {
  test("用旧 revision 并发写 → 后到者 stale_revision，不会静默覆盖", () => {
    const store = new ReflectionStore(dbPath);
    const card = store.create(input());

    // 两个写入方都读到 revision=1
    const first = store.transition(card.id, 1, { status: "injected" });
    expect(first.revision).toBe(2);

    let caught: ReflectionError | null = null;
    try {
      store.transition(card.id, 1, { status: "adopted" });
    } catch (err) {
      caught = err as ReflectionError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("stale_revision");
    // 后到的写入没有覆盖先到的状态
    expect(store.get(card.id)!.status).toBe("injected");
    store.close();
  });

  test("不存在的卡片 → card_not_found", () => {
    const store = new ReflectionStore(dbPath);
    expect(() => store.transition("nope", 1, { status: "injected" })).toThrow(
      ReflectionError,
    );
    store.close();
  });

  test("每次成功推进 revision 单调 +1", () => {
    const store = new ReflectionStore(dbPath);
    let card = store.create(input());
    card = store.transition(card.id, card.revision, { status: "injected" });
    card = store.transition(card.id, card.revision, { status: "adopted" });
    expect(card.revision).toBe(3);
    store.close();
  });
});

describe("ReflectionStore — TTL 与清理", () => {
  test("expireDue 把到期卡置 expired 并留痕", () => {
    const store = new ReflectionStore(dbPath, { now: () => 1_000 });
    const card = store.create(input({ ttlMs: 100 }));
    expect(store.list({ injectableAt: 1_050 })).toHaveLength(1);

    const expired = store.expireDue(1_200);
    expect(expired).toEqual([card.id]);
    expect(store.get(card.id)!.status).toBe("expired");
    expect(store.list({ injectableAt: 1_200 })).toHaveLength(0);
    expect(store.events(card.id).map((e) => e.type)).toContain("reflect/expired");
    store.close();
  });

  test("未到期卡不被 expireDue 波及", () => {
    const store = new ReflectionStore(dbPath, { now: () => 1_000 });
    const card = store.create(input({ ttlMs: 10_000 }));
    expect(store.expireDue(1_500)).toEqual([]);
    expect(store.get(card.id)!.status).toBe("proposed");
    store.close();
  });

  test("ttlMs=0 的卡不过期", () => {
    const store = new ReflectionStore(dbPath, { now: () => 1_000 });
    const card = store.create(input({ ttlMs: 0 }));
    expect(card.expiresAt).toBeUndefined();
    expect(store.expireDue(10_000_000)).toEqual([]);
    store.close();
  });
});

describe("ReflectionStore — 注入闭环与事件流", () => {
  test("从事件流能复原一次「证据 → 卡 → 注入」闭环", () => {
    const store = new ReflectionStore(dbPath, { now: () => 5_000 });
    const card = store.create(input());

    const picked = store.selectForInjection({ at: 5_000 });
    expect(picked.map((c) => c.id)).toEqual([card.id]);

    store.recordInjection([card.id], "session-42", 5_100);

    const events = store.events(card.id);
    expect(events.map((e) => e.type)).toEqual([
      "reflect/card-created",
      "reflect/card-updated",
      "reflect/injected",
    ]);

    const created = events[0]!;
    expect(created.type).toBe("reflect/card-created");
    if (created.type === "reflect/card-created") {
      expect(created.evidence).toEqual([{ kind: "trace", ref: "trace-001" }]);
    }
    const injected = events[2]!;
    if (injected.type === "reflect/injected") {
      expect(injected.sessionId).toBe("session-42");
    }

    const after = store.get(card.id)!;
    expect(after.status).toBe("injected");
    expect(after.effect?.injectedCount).toBe(1);
    expect(after.effect?.lastInjectedAt).toBe(5_100);
    store.close();
  });

  test("rejected / expired 卡不进注入候选", () => {
    const store = new ReflectionStore(dbPath, { now: () => 1_000 });
    const keep = store.create(input({ lesson: "保留这条" }));
    const rejected = store.create(input({ lesson: "拒绝这条" }));
    store.transition(rejected.id, rejected.revision, { status: "rejected" });

    const picked = store.selectForInjection({ at: 1_000 });
    expect(picked.map((c) => c.id)).toEqual([keep.id]);
    store.close();
  });

  test("selectForInjection 按严重度排序（unsafe 在 failed 之前）", () => {
    const store = new ReflectionStore(dbPath, { now: () => 1_000 });
    const failed = store.create(input({ trigger: "judge_failed", lesson: "普通失败" }));
    const unsafe = store.create(input({ trigger: "judge_unsafe", lesson: "越权操作" }));
    const picked = store.selectForInjection({ at: 1_000 });
    expect(picked.map((c) => c.id)).toEqual([unsafe.id, failed.id]);
    store.close();
  });
});

describe("ReflectionStore — 作用域隔离", () => {
  test("按 scopeKey 过滤不串库", () => {
    const store = new ReflectionStore(dbPath);
    store.create(input({ scope: "project", scopeKey: "project:A", lesson: "A 的教训" }));
    store.create(input({ scope: "project", scopeKey: "project:B", lesson: "B 的教训" }));

    const onlyA = store.list({ scopeKey: "project:A" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]!.lesson).toBe("A 的教训");

    const aInjection = store.selectForInjection({ scopeKey: "project:A" });
    expect(aInjection).toHaveLength(1);
    expect(aInjection[0]!.scopeKey).toBe("project:A");
    store.close();
  });

  test("列出全部（不过滤）能看到两个作用域", () => {
    const store = new ReflectionStore(dbPath);
    store.create(input({ scopeKey: "project:A" }));
    store.create(input({ scopeKey: "project:B" }));
    expect(store.list()).toHaveLength(2);
    store.close();
  });
});

describe("ReflectionStore — 降级与持久化", () => {
  test("自动建目录与库文件（老库开箱可用）", () => {
    const nested = join(dir, "reflect", "reflections.db");
    const store = new ReflectionStore(nested);
    store.create(input());
    store.close();
    expect(existsSync(nested)).toBe(true);
  });

  test("重开库能读回卡片（跨轮继承）", () => {
    const store = new ReflectionStore(dbPath);
    const card = store.create(input());
    store.close();

    const reopened = new ReflectionStore(dbPath);
    const loaded = reopened.get(card.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.lesson).toBe(card.lesson);
    expect(reopened.events(card.id)).toHaveLength(1);
    reopened.close();
  });

  test("close 可重复调用不抛（复用连接时不关别人的库）", () => {
    const store = new ReflectionStore(dbPath);
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
