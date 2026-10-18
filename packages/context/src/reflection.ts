/**
 * @fengagent/context — 自省卡注入通道（RSI P0）
 *
 * 把 {@link ReflectionCard} 变成一个受硬预算约束的系统提示片段，插在 MEMORY 之后、
 * extraInstructions 之前（`system-context.ts` 第 4.5 步）。
 *
 * **硬预算**（不可被单张卡突破）：≤ {@link REFLECT_INJECT_DEFAULTS.maxCards} 条、
 * ≤ maxTokens token。超出时按以下确定性规则处理：
 *
 * 1. 候选按 `reflectionRank`（严重度 × 证据数 × 新近度）降序；
 * 2. 逐张累加，累计 token 超预算即停止；
 * 3. 若「下一张」超出剩余预算但剩余预算 ≥ {@link MIN_TRUNCATE_TOKENS}，就把这张卡的
 *    lesson 截断到剩余预算（`…` 收尾）——保证预算内仍尽量多一条；
 * 4. 否则丢弃（不再尝试更小的卡），条数上限同理。
 *
 * 注入失败不打断主循环：调用方（装配点）用 try/catch 包住，失败即「无卡继续」。
 */

import type { ReflectionCard } from "@fengagent/core";
import { isReflectionInjectable, reflectionRank } from "@fengagent/core";
import { REFLECT_INJECT_DEFAULTS } from "@fengagent/shared";
import { countTokensInText } from "./token-counter.ts";

/** 截断一张卡时至少要留出的 token（少于它就直接丢弃） */
export const MIN_TRUNCATE_TOKENS = 40;

/** 注入小节的标题（测试与文档共用同一事实来源） */
export const REFLECTION_SECTION_TITLE = "## 过往教训（自省卡 · 带证据）";

/** 选择/渲染选项 */
export interface ReflectionInjectionOptions {
  /** 当前时间（毫秒；默认 Date.now） */
  now?: number;
  /** 卡片条数上限（默认 5） */
  maxCards?: number;
  /** token 上限（默认 600） */
  maxTokens?: number;
}

/** 注入结果 */
export interface ReflectionInjection {
  /** 被选中的卡片（按注入顺序；可能含被截断的卡） */
  cards: ReflectionCard[];
  /** 渲染好的小节文本（为空串表示不注入） */
  text: string;
  /** 小节 token 估算 */
  tokens: number;
  /** 被截断的卡片 id */
  truncated: string[];
  /** 因预算被丢弃的卡片 id */
  dropped: string[];
}

/**
 * 渲染单张卡的正文（不含标题）。
 *
 * 格式：`- [trigger] lesson（证据: kind:ref, …）`
 */
export function renderReflectionLine(card: ReflectionCard, lesson?: string): string {
  const body = (lesson ?? card.lesson).trim();
  const refs = card.evidence
    .map((e) => `${e.kind}:${e.ref}`)
    .join(", ");
  return `- [${card.trigger}] ${body}（证据: ${refs}）`;
}

/**
 * 按预算选择卡片并渲染注入小节。
 *
 * @param cards - 候选卡片（可含 rejected / expired，会被过滤）
 * @param options - 预算与时间
 * @returns 注入结果（未选中任何卡时 `text` 为空串）
 */
export function buildReflectionInjection(
  cards: readonly ReflectionCard[],
  options: ReflectionInjectionOptions = {},
): ReflectionInjection {
  const now = options.now ?? Date.now();
  const maxCards = options.maxCards ?? REFLECT_INJECT_DEFAULTS.maxCards;
  const maxTokens = options.maxTokens ?? REFLECT_INJECT_DEFAULTS.maxTokens;

  const candidates = cards
    .filter((c) => isReflectionInjectable(c, now))
    .sort((a, b) => reflectionRank(b, now) - reflectionRank(a, now));

  const selected: ReflectionCard[] = [];
  const truncated: string[] = [];
  const dropped: string[] = [];
  const lines: string[] = [REFLECTION_SECTION_TITLE];
  // 标题本身占预算
  let used = countTokensInText(REFLECTION_SECTION_TITLE);

  for (const card of candidates) {
    if (selected.length >= maxCards) {
      dropped.push(card.id);
      continue;
    }
    const line = renderReflectionLine(card);
    const cost = countTokensInText(line);
    let lineToUse = line;

    if (used + cost > maxTokens) {
      const remaining = maxTokens - used;
      if (remaining < MIN_TRUNCATE_TOKENS) {
        dropped.push(card.id);
        continue;
      }
      // 截断：token 估算为 chars/4，按比例收缩并留出省略号
      const budgetChars = Math.max(0, remaining * 4 - 8);
      const refs = card.evidence.map((e) => `${e.kind}:${e.ref}`).join(", ");
      const head = `- [${card.trigger}] `;
      const tail = `（证据: ${refs}）…`;
      const room = Math.max(0, budgetChars - head.length - tail.length);
      if (room <= 0) {
        dropped.push(card.id);
        continue;
      }
      const clipped =
        card.lesson.length > room ? `${card.lesson.slice(0, room)}` : card.lesson;
      lineToUse = `${head}${clipped}${tail}`;
      if (countTokensInText(lineToUse) > remaining) {
        dropped.push(card.id);
        continue;
      }
      truncated.push(card.id);
    }

    lines.push(lineToUse);
    used += countTokensInText(lineToUse);
    selected.push(card);
  }

  if (selected.length === 0) {
    return { cards: [], text: "", tokens: 0, truncated, dropped };
  }

  const text = lines.join("\n");
  return {
    cards: selected,
    text,
    tokens: countTokensInText(text),
    truncated,
    dropped,
  };
}
