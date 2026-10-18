/**
 * @fengagent/context — 自省注入通道测试（RSI P0）
 *
 * 覆盖验收契约 A2（硬预算 ≤5 条 / ≤600 token + 截断规则）/ A3（TTL）/
 * A4（`FENG_REFLECT_INJECT=off` 注入为 0）/ A8（注入失败降级）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReflectionCard } from "@fengagent/core";
import {
  buildReflectionInjection,
  renderReflectionLine,
  REFLECTION_SECTION_TITLE,
} from "../reflection.ts";
import { loadSystemContext } from "../system-context.ts";
import { countTokensInText } from "../token-counter.ts";

// 用真实墙钟做基准：注入通道的默认 now 是 Date.now()，写死过去的时间会让卡片被当成过期。
const NOW = Date.now();

function card(overrides: Partial<ReflectionCard> = {}): ReflectionCard {
  return {
    id: `card-${Math.random().toString(36).slice(2, 8)}`,
    revision: 1,
    scope: "project",
    scopeKey: "project:default",
    status: "proposed",
    trigger: "judge_failed",
    signal: { conclusion: "failed" },
    lesson: "改文件前先读目标文件",
    evidence: [{ kind: "trace", ref: "trace-001" }],
    appliesTo: { kind: "system-prompt", target: "prompt-overlay.md" },
    effect: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  };
}

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("注入通道 — 硬预算", () => {
  test("6 条候选只注入 5 条（条数上限）", () => {
    const cards = Array.from({ length: 6 }, (_, i) =>
      card({ id: `c${i}`, lesson: `教训 ${i}` }),
    );
    const result = buildReflectionInjection(cards, { now: NOW, maxCards: 5, maxTokens: 600 });
    expect(result.cards).toHaveLength(5);
    expect(result.dropped).toHaveLength(1);
    expect(result.text.split("\n")).toHaveLength(6); // 标题 + 5 行
  });

  test("超长卡被截断到 token 上限之内（≤600）", () => {
    const longLesson = "很长的教训".repeat(2_000); // ≈ 4000 token
    const cards = [card({ id: "long", lesson: longLesson })];
    const result = buildReflectionInjection(cards, { now: NOW, maxCards: 5, maxTokens: 600 });
    expect(result.tokens).toBeLessThanOrEqual(600);
    expect(result.truncated).toContain("long");
    expect(result.cards).toHaveLength(1);
    // 截断是「留住 lesson 头部 + 收尾省略号」，证引仍在
    expect(result.text).toContain("…");
    expect(result.text).toContain("（证据: trace:trace-001）");
  });

  test("多条中等长度卡合计超预算时按排序逐张截断/丢弃，总数不超预算", () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      card({
        id: `m${i}`,
        lesson: `第 ${i} 条教训`.repeat(200), // ≈ 300 token/条
        updatedAt: NOW - i * 3_600_000,
      }),
    );
    const result = buildReflectionInjection(cards, { now: NOW, maxCards: 5, maxTokens: 600 });
    expect(result.tokens).toBeLessThanOrEqual(600);
    expect(result.truncated.length + result.dropped.length).toBeGreaterThan(0);
  });

  test("预算极小（放不下整张卡且剩余 < MIN_TRUNCATE_TOKENS）时不注入", () => {
    // 标题 ~9 token，卡本身 ~60 token：预算 30 放不下整卡、剩余也不够截断 → 丢弃
    const result = buildReflectionInjection(
      [card({ lesson: "这是一条需要不少 token 才能说完的教训".repeat(20) })],
      {
        now: NOW,
        maxCards: 5,
        maxTokens: 30,
      },
    );
    expect(result.cards).toHaveLength(0);
    expect(result.text).toBe("");
    expect(result.tokens).toBe(0);
  });

  test("注入小节 token 计数与实际渲染一致", () => {
    const result = buildReflectionInjection([card()], { now: NOW });
    expect(result.tokens).toBe(countTokensInText(result.text));
  });

  test("排序：unsafe 卡排在 failed 卡前面", () => {
    const failed = card({ id: "f", trigger: "judge_failed", lesson: "普通失败" });
    const unsafe = card({ id: "u", trigger: "judge_unsafe", lesson: "越权操作" });
    const result = buildReflectionInjection([failed, unsafe], { now: NOW });
    expect(result.cards[0]!.id).toBe("u");
  });
});

describe("注入通道 — 过滤", () => {
  test("rejected / expired 卡不注入", () => {
    const result = buildReflectionInjection(
      [
        card({ id: "r", status: "rejected" }),
        card({ id: "e", status: "expired" }),
        card({ id: "ok" }),
      ],
      { now: NOW },
    );
    expect(result.cards.map((c) => c.id)).toEqual(["ok"]);
  });

  test("TTL 到期卡不注入", () => {
    const result = buildReflectionInjection(
      [card({ id: "old", expiresAt: NOW - 1 }), card({ id: "new", expiresAt: NOW + 1 })],
      { now: NOW },
    );
    expect(result.cards.map((c) => c.id)).toEqual(["new"]);
  });

  test("无证据卡不注入（纵深防御：存储层已挡，注入层再挡）", () => {
    const result = buildReflectionInjection([card({ evidence: [] })], { now: NOW });
    expect(result.cards).toHaveLength(0);
    expect(result.text).toBe("");
  });

  test("空候选 → 空小节（不产生空标题噪声）", () => {
    const result = buildReflectionInjection([], { now: NOW });
    expect(result.text).toBe("");
  });
});

describe("注入通道 — 渲染格式", () => {
  test("单行渲染包含触发源、教训、证据引用", () => {
    const line = renderReflectionLine(
      card({ trigger: "guard_tripped", lesson: "别重复调用同一工具", evidence: [
        { kind: "guard", ref: "repeat-call" },
        { kind: "trace", ref: "t-9" },
      ] }),
    );
    expect(line).toBe("- [guard_tripped] 别重复调用同一工具（证据: guard:repeat-call, trace:t-9）");
  });

  test("小节带固定标题（可被下游识别/去重）", () => {
    const result = buildReflectionInjection([card()], { now: NOW });
    expect(result.text.startsWith(REFLECTION_SECTION_TITLE)).toBe(true);
  });
});

describe("loadSystemContext — 注入接线", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feng-reflect-ctx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("传入卡片 → 系统提示出现「过往教训」小节，且位于 MEMORY 之后、额外指令之前", async () => {
    writeFileSync(join(dir, "MEMORY.md"), "# 记忆\n- 用户偏好中文", "utf-8");
    const ctx = await loadSystemContext({
      workdir: dir,
      extraInstructions: "EXTRA-MARKER",
      reflections: [card({ lesson: "LESSON-MARKER" })],
      reflectEnv: EMPTY_ENV,
    });

    expect(ctx).toContain("过往教训");
    expect(ctx).toContain("LESSON-MARKER");
    const lessonIdx = ctx.indexOf("过往教训");
    const memoryIdx = ctx.indexOf("用户偏好中文");
    const extraIdx = ctx.indexOf("EXTRA-MARKER");
    expect(lessonIdx).toBeGreaterThan(memoryIdx);
    expect(lessonIdx).toBeLessThan(extraIdx);
  });

  test("FENG_REFLECT_INJECT=off → 注入为 0，其余内容不变", async () => {
    const withOff = await loadSystemContext({
      workdir: dir,
      reflections: [card({ lesson: "LESSON-MARKER" })],
      reflectEnv: { FENG_REFLECT_INJECT: "off" },
    });
    expect(withOff).not.toContain("过往教训");
    expect(withOff).not.toContain("LESSON-MARKER");

    const baseline = await loadSystemContext({ workdir: dir });
    // 只比较非时间部分（每次调用的 ISO 时间戳必然不同）
    const stripTime = (s: string) => s.replace(/Current date and time: .*/g, "");
    expect(stripTime(baseline)).toBe(stripTime(withOff));
  });

  test("卡片以函数形式提供时每次重载都重新取（下一轮能看到新卡）", async () => {
    let current: ReflectionCard[] = [];
    const ctx1 = await loadSystemContext({
      workdir: dir,
      reflections: () => current,
      reflectEnv: EMPTY_ENV,
    });
    expect(ctx1).not.toContain("新鲜教训");

    current = [card({ lesson: "新鲜教训" })];
    const ctx2 = await loadSystemContext({
      workdir: dir,
      reflections: () => current,
      reflectEnv: EMPTY_ENV,
    });
    expect(ctx2).toContain("新鲜教训");
  });

  test("注入过程抛错 → 降级为无卡继续（不打断系统提示）", async () => {
    const ctx = await loadSystemContext({
      workdir: dir,
      reflections: () => {
        throw new Error("store 挂了");
      },
      reflectEnv: EMPTY_ENV,
    });
    expect(ctx).toContain("You are a helpful AI coding assistant.");
    expect(ctx).not.toContain("过往教训");
  });

  test("环境变量可收紧预算（FENG_REFLECT_MAX_CARDS=2）", async () => {
    const cards = Array.from({ length: 4 }, (_, i) => card({ lesson: `教训${i}` }));
    const ctx = await loadSystemContext({
      workdir: dir,
      reflections: cards,
      reflectEnv: { FENG_REFLECT_MAX_CARDS: "2" },
    });
    const section = ctx.slice(ctx.indexOf("过往教训"));
    expect(section.split("\n").filter((l) => l.startsWith("- [")).length).toBe(2);
  });
});
