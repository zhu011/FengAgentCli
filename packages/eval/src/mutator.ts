/**
 * @fengagent/eval — 最小变更器（RSI P1 写回通道）
 *
 * 首期写回边界**刻意只有一个落点**：`<数据根>/reflect/prompt-overlay.md`。
 *
 * - 不写仓库文件、不写 `AGENTS.md`、不改代码、不改 skill —— 任何越界目标直接抛
 *   {@link ReflectionError}（`write_boundary_violation`），在写盘之前就失败。
 * - 变更内容只有「追加一条带证据的规则」，且幂等（同一条教训不会重复追加）。
 * - 每次变更都带 `previous` 快照，回滚是内容级恢复（`restorePromptOverlay`）。
 *
 * 为什么只写这里：系统提示装配已经会读 `prompt-overlay.md`（见 `context` 的自省注入），
 * 所以它是唯一「改动即生效、且不动用户仓库」的落点。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ReflectionCard } from "@fengagent/core";
import { ReflectionError } from "@fengagent/core";
import { PROMPT_OVERLAY_FILE, resolvePromptOverlayPath } from "@fengagent/shared";

/** overlay 文件名（唯一允许的写回落点；与 shared 共用同一常量） */
export const PROMPT_OVERLAY_BASENAME = PROMPT_OVERLAY_FILE;

/** 不允许自动写入的仓库文件（即便调用方显式要求） */
const FORBIDDEN_TARGETS = ["agents.md", "agents.md ", "claude.md"];

/** 文件快照（回滚依据） */
export interface OverlaySnapshot {
  /** 绝对路径 */
  path: string;
  /** 变更前文件是否存在 */
  existed: boolean;
  /** 变更前内容（不存在为 null） */
  content: string | null;
}

/** 一次待应用的变更 */
export interface OverlayChange {
  /** 变更 id */
  id: string;
  /** 来源卡片 id */
  cardId: string;
  /** 追加的规则文本 */
  lesson: string;
  /** 变更后的整文件内容 */
  next: string;
  /** 变更前快照 */
  previous: OverlaySnapshot;
  /** 创建时间 */
  createdAt: number;
}

/**
 * overlay 绝对路径 = `<dataRoot>/reflect/prompt-overlay.md`。
 *
 * @param dataRoot - 数据根（`resolveDataRoot()` 的产物）
 */
export function promptOverlayPath(dataRoot: string): string {
  return resolve(resolvePromptOverlayPath(dataRoot));
}

/**
 * 写回边界守卫：只允许写 overlay 文件。
 *
 * @param dataRoot - 数据根
 * @param target - 目标路径（相对或绝对）
 * @returns 规范化后的绝对路径
 * @throws {ReflectionError} 目标不是 `<dataRoot>/reflect/prompt-overlay.md`
 */
export function assertWriteBoundary(dataRoot: string, target: string): string {
  const expected = resolve(promptOverlayPath(dataRoot));
  // 目标解析口径：绝对路径按原样；单段裸文件名（如卡片声明的 `prompt-overlay.md`）
  // 指向数据根的 reflect/ 目录；其余相对路径相对数据根解析（逃逸会落到 expected 之外）。
  const bare = !isAbsolute(target) && !target.includes("/") && !target.includes("\\");
  const actual = isAbsolute(target)
    ? resolve(target)
    : bare
      ? resolve(expected)
      : resolve(dataRoot, target);
  const basename = actual.toLowerCase();
  if (FORBIDDEN_TARGETS.some((t) => basename.endsWith(t))) {
    throw new ReflectionError(
      `write boundary violation: refusing to modify ${actual} (only ${PROMPT_OVERLAY_BASENAME} is writable)`,
      "write_boundary_violation",
    );
  }
  // 裸文件名必须就是 overlay 本名；其余必须逐字等于 overlay 路径
  if (bare && target !== PROMPT_OVERLAY_BASENAME) {
    throw new ReflectionError(
      `write boundary violation: ${target} is not ${PROMPT_OVERLAY_BASENAME}`,
      "write_boundary_violation",
    );
  }
  if (actual !== expected) {
    throw new ReflectionError(
      `write boundary violation: ${actual} is outside the allowed target ${expected}`,
      "write_boundary_violation",
    );
  }
  return expected;
}

/**
 * 读 overlay 当前状态（不存在时 `existed=false, content=null`）。
 *
 * @param dataRoot - 数据根
 */
export function readPromptOverlay(dataRoot: string): OverlaySnapshot {
  const path = resolve(promptOverlayPath(dataRoot));
  if (!existsSync(path)) {
    return { path, existed: false, content: null };
  }
  return { path, existed: true, content: readFileSync(path, "utf-8") };
}

/** 小节标题（幂等追加用） */
const OVERLAY_SECTION_TITLE = "## 本项目学到的规则";

/**
 * 生成变更（纯函数：只读当前文件，不写盘）。
 *
 * 同一教训已在 overlay 中时不重复追加（幂等）。
 *
 * @param opts - dataRoot + 来源卡片 + 时间
 * @returns 待应用的变更（含回滚快照）
 */
export function proposePromptOverlayChange(opts: {
  dataRoot: string;
  card: Pick<ReflectionCard, "id" | "lesson" | "evidence" | "trigger" | "appliesTo">;
  at?: number;
  id?: string;
}): OverlayChange {
  const { card } = opts;
  if (card.appliesTo.kind !== "system-prompt") {
    throw new ReflectionError(
      `write boundary violation: appliesTo.kind=${card.appliesTo.kind} is not writable in phase 1`,
      "write_boundary_violation",
    );
  }
  assertWriteBoundary(opts.dataRoot, card.appliesTo.target || PROMPT_OVERLAY_BASENAME);

  const previous = readPromptOverlay(opts.dataRoot);
  const current = previous.content ?? "";
  const ruleLine = renderRuleLine(card);
  const lessonKey = normalize(card.lesson);
  // 幂等：规则行形如 `- <lesson>（触发: …；证据: …）`，按「去掉前导 - 后是否以该教训开头」判定
  const alreadyPresent = current
    .split("\n")
    .filter((line) => line.trimStart().startsWith("-"))
    .some((line) => normalize(line.replace(/^\s*-\s*/, "")).startsWith(lessonKey));

  const next = alreadyPresent
    ? current
    : current.length === 0
      ? `${OVERLAY_SECTION_TITLE}\n\n${ruleLine}\n`
      : `${current.replace(/\s*$/, "")}\n${current.includes(OVERLAY_SECTION_TITLE) ? "" : `\n${OVERLAY_SECTION_TITLE}\n\n`}${ruleLine}\n`;

  const at = opts.at ?? Date.now();
  return {
    id: opts.id ?? `overlay-${at.toString(36)}-${card.id.slice(0, 8)}`,
    cardId: card.id,
    lesson: card.lesson,
    next,
    previous,
    createdAt: at,
  };
}

/**
 * 应用变更（写盘）。目标路径会再过一次边界守卫。
 *
 * @param dataRoot - 数据根
 * @param change - 变更
 * @returns 变更后的快照
 */
export function applyPromptOverlayChange(
  dataRoot: string,
  change: OverlayChange,
): OverlaySnapshot {
  const path = assertWriteBoundary(dataRoot, promptOverlayPath(dataRoot));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, change.next, "utf-8");
  return { path, existed: true, content: change.next };
}

/**
 * 回滚到变更前状态（内容级恢复：原来不存在就删回不存在）。
 *
 * @param snapshot - 变更前快照
 */
export function restorePromptOverlay(snapshot: OverlaySnapshot): void {
  if (!snapshot.existed) {
    if (existsSync(snapshot.path)) {
      // 回滚 = 恢复原状：原来没有这个文件，就删掉
      try {
        unlinkSync(snapshot.path);
      } catch {
        writeFileSync(snapshot.path, "", "utf-8");
      }
    }
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true });
  writeFileSync(snapshot.path, snapshot.content ?? "", "utf-8");
}

/** 渲染追加的规则行 */
function renderRuleLine(card: {
  lesson: string;
  evidence: readonly { kind: string; ref: string }[];
  trigger: string;
}): string {
  const refs = card.evidence.map((e) => `${e.kind}:${e.ref}`).join(", ");
  return `- ${card.lesson.trim()}（触发: ${card.trigger}；证据: ${refs}）`;
}

/** 归一化（去空白、小写）用于幂等判定 */
function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}
