/**
 * `/skill` 命令 — 三层合并可见性测试（团队级技能库 P0）
 *
 * 验收点：`/skill list` 与 `skill` 工具读同一套 loader —— 团队技能可见、停用后不可见。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand, type CommandContext } from "../commands.ts";
import type { Agent } from "@fengagent/agent";

let root: string;
let workdir: string;
let teamRoot: string;
let previousTeamHome: string | undefined;

function ctx(): CommandContext {
  return {
    agent: { getWorkdir: () => workdir } as unknown as Agent,
    currentModel: "test-model",
  };
}

function writeTeamSkill(name: string, description: string, prompt: string): void {
  const dir = join(teamRoot, "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    ["---", `name: ${name}`, `description: ${description}`, "trigger: 当需要时", "---", "", prompt].join("\n"),
    "utf-8",
  );
}

function writeDisabled(names: string[]): void {
  const dir = join(teamRoot, "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skills.json"), JSON.stringify({ version: 1, disabled: names }), "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-cli-skill-"));
  workdir = join(root, "workdir");
  teamRoot = join(root, "team");
  mkdirSync(workdir, { recursive: true });
  previousTeamHome = process.env.FENG_TEAM_HOME;
  process.env.FENG_TEAM_HOME = teamRoot;
});

afterEach(() => {
  if (previousTeamHome === undefined) delete process.env.FENG_TEAM_HOME;
  else process.env.FENG_TEAM_HOME = previousTeamHome;
  rmSync(root, { recursive: true, force: true });
});

describe("/skill — 团队级技能可见", () => {
  test("团队技能出现在 /skill list，并标注 [team] 与团队目录", () => {
    writeTeamSkill("team-review", "团队审查技能", "团队审查 prompt");

    const result = handleCommand("/skill list", ctx());
    expect(result.handled).toBe(true);
    expect(result.message).toContain("team-review");
    expect(result.message).toContain("[team]");
    expect(result.message).toContain(join(teamRoot, "skills"));
    // 内置仍然在
    expect(result.message).toContain("code-review");
  });

  test("/skill <name> 取到团队技能正文（可编辑草稿）", () => {
    writeTeamSkill("team-review", "团队审查技能", "团队审查 prompt");
    const result = handleCommand("/skill team-review", ctx());
    expect(result.inputDraft).toBe("团队审查 prompt");
  });

  test("停用后 /skill list 不含、/skill <name> 也取不到（与 skill 工具同源）", () => {
    writeTeamSkill("team-review", "团队审查技能", "团队审查 prompt");
    writeDisabled(["team-review", "debug"]);

    const list = handleCommand("/skill list", ctx());
    expect(list.message).not.toContain("team-review");
    expect(list.message).not.toContain("debug");

    const draft = handleCommand("/skill team-review", ctx());
    expect(draft.inputDraft).toBeUndefined();
    expect(draft.message).toContain("未找到");
  });

  test("本目录同名技能覆盖团队版（/skill 取到本目录正文）", () => {
    writeTeamSkill("code-review", "团队版审查", "团队 prompt");
    const localDir = join(workdir, ".fengagent", "skills");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, "code-review.md"),
      ["---", "name: code-review", "description: 本目录版", "---", "", "本目录 prompt"].join("\n"),
      "utf-8",
    );

    const result = handleCommand("/skill code-review", ctx());
    expect(result.inputDraft).toBe("本目录 prompt");
  });

  test("/skill list 的本目录来源标 [workdir]（不暴露内部层名 project）", () => {
    const localDir = join(workdir, ".fengagent", "skills");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, "local-only.md"),
      ["---", "name: local-only", "description: 本目录技能", "---", "", "本目录 prompt"].join("\n"),
      "utf-8",
    );

    const result = handleCommand("/skill list", ctx());
    expect(result.message).toContain("[workdir]");
    expect(result.message).not.toContain("[project]");
  });
});
