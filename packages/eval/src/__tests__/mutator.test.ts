/**
 * @fengagent/eval — 最小变更器测试（RSI P1）
 *
 * 覆盖验收契约 B2（写回边界只写数据根 `prompt-overlay.md`）/ B5（回滚内容级）：
 * - 变更只落在 `<dataRoot>/reflect/prompt-overlay.md`；
 * - 目标越界（AGENTS.md、代码文件、绝对路径逃逸、非 system-prompt 落点）在写盘前就抛；
 * - 幂等：同一教训不会重复追加；
 * - 回滚：原先不存在 → 删回不存在；原先有内容 → 内容级恢复。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectionError } from "@fengagent/core";
import {
  applyPromptOverlayChange,
  assertWriteBoundary,
  promptOverlayPath,
  proposePromptOverlayChange,
  readPromptOverlay,
  restorePromptOverlay,
  PROMPT_OVERLAY_BASENAME,
} from "../mutator.ts";

const CARD = {
  id: "card-1",
  lesson: "改文件前先读目标文件",
  evidence: [{ kind: "trace" as const, ref: "trace-001" }],
  trigger: "judge_failed" as const,
  appliesTo: { kind: "system-prompt" as const, target: PROMPT_OVERLAY_BASENAME },
};

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "feng-mutator-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("写回边界", () => {
  test("overlay 路径固定在数据根 reflect/ 下", () => {
    expect(promptOverlayPath(dataRoot)).toBe(join(dataRoot, "reflect", PROMPT_OVERLAY_BASENAME));
  });

  test("只允许写 prompt-overlay.md", () => {
    expect(assertWriteBoundary(dataRoot, promptOverlayPath(dataRoot))).toBe(
      promptOverlayPath(dataRoot),
    );
  });

  test("拒绝 AGENTS.md（不自动改用户仓库文件）", () => {
    let err: ReflectionError | null = null;
    try {
      assertWriteBoundary(dataRoot, join(dataRoot, "AGENTS.md"));
    } catch (e) {
      err = e as ReflectionError;
    }
    expect(err).not.toBeNull();
    expect(err!.code).toBe("write_boundary_violation");
  });

  test("拒绝仓库代码文件与路径逃逸", () => {
    for (const target of [
      join(dataRoot, "packages", "core", "src", "index.ts"),
      join(dataRoot, "..", "outside.md"),
      join(dataRoot, "reflect", "other.md"),
    ]) {
      expect(() => assertWriteBoundary(dataRoot, target)).toThrow(ReflectionError);
    }
  });

  test("appliesTo.kind 不是 system-prompt → 拒绝（首期只做提示词落点）", () => {
    expect(() =>
      proposePromptOverlayChange({
        dataRoot,
        card: { ...CARD, appliesTo: { kind: "skill", target: PROMPT_OVERLAY_BASENAME } },
      }),
    ).toThrow(ReflectionError);
  });
});

describe("变更生成与应用", () => {
  test("首次变更创建 overlay 并写入带证据的规则行", () => {
    const change = proposePromptOverlayChange({ dataRoot, card: CARD, at: 1_000, id: "chg-1" });
    expect(change.previous.existed).toBe(false);
    applyPromptOverlayChange(dataRoot, change);

    const content = readFileSync(promptOverlayPath(dataRoot), "utf-8");
    expect(content).toContain("## 本项目学到的规则");
    expect(content).toContain("改文件前先读目标文件");
    expect(content).toContain("证据: trace:trace-001");
  });

  test("追加到既有 overlay 之后（不覆盖原内容）", () => {
    mkdirSync(join(dataRoot, "reflect"), { recursive: true });
    writeFileSync(promptOverlayPath(dataRoot), "## 本项目学到的规则\n\n- 旧规则\n", "utf-8");

    const change = proposePromptOverlayChange({ dataRoot, card: CARD });
    applyPromptOverlayChange(dataRoot, change);

    const content = readFileSync(promptOverlayPath(dataRoot), "utf-8");
    expect(content).toContain("- 旧规则");
    expect(content).toContain("改文件前先读目标文件");
    // 小节标题只出现一次
    expect(content.match(/## 本项目学到的规则/g)).toHaveLength(1);
  });

  test("幂等：同一教训不会重复追加", () => {
    const first = proposePromptOverlayChange({ dataRoot, card: CARD });
    applyPromptOverlayChange(dataRoot, first);

    const second = proposePromptOverlayChange({ dataRoot, card: CARD });
    applyPromptOverlayChange(dataRoot, second);

    const content = readFileSync(promptOverlayPath(dataRoot), "utf-8");
    expect(content.match(/改文件前先读目标文件/g)).toHaveLength(1);
  });

  test("变更不会触碰数据根之外的文件（除 overlay 外目录无新文件）", () => {
    const change = proposePromptOverlayChange({ dataRoot, card: CARD });
    applyPromptOverlayChange(dataRoot, change);

    // 只有 reflect/prompt-overlay.md 一个文件被创建
    expect(existsSync(promptOverlayPath(dataRoot))).toBe(true);
    expect(existsSync(join(dataRoot, "AGENTS.md"))).toBe(false);
  });
});

describe("回滚（内容级）", () => {
  test("原先不存在 → 回滚后文件不存在", () => {
    const snapshot = readPromptOverlay(dataRoot);
    const change = proposePromptOverlayChange({ dataRoot, card: CARD });
    applyPromptOverlayChange(dataRoot, change);
    expect(existsSync(promptOverlayPath(dataRoot))).toBe(true);

    restorePromptOverlay(snapshot);
    expect(existsSync(promptOverlayPath(dataRoot))).toBe(false);
  });

  test("原先有内容 → 回滚后内容逐字符一致", () => {
    mkdirSync(join(dataRoot, "reflect"), { recursive: true });
    const original = "## 本项目学到的规则\n\n- 旧规则\n";
    writeFileSync(promptOverlayPath(dataRoot), original, "utf-8");

    const snapshot = readPromptOverlay(dataRoot);
    const change = proposePromptOverlayChange({ dataRoot, card: CARD });
    applyPromptOverlayChange(dataRoot, change);
    expect(readFileSync(promptOverlayPath(dataRoot), "utf-8")).not.toBe(original);

    restorePromptOverlay(snapshot);
    expect(readFileSync(promptOverlayPath(dataRoot), "utf-8")).toBe(original);
  });
});
