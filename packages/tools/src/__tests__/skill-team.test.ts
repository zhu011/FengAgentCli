/**
 * 团队级技能库 — loader 三层合并测试
 *
 * 覆盖：内置 → 团队 → 本目录 的覆盖顺序、停用（agent 侧不可见）、mtime 失效、
 * 解析失败可观测、旧 `.fengagent/skills` 兼容。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSkillLoader } from "../builtin/skill.ts";

let root: string;
let workdir: string;
let teamDir: string;

function writeSkill(dir: string, name: string, description: string, body = `${description} prompt`): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    ["---", `name: ${name}`, `description: ${description}`, "trigger: 当需要时", "---", "", body].join("\n"),
    "utf-8",
  );
}

function writeIndex(disabled: string[]): void {
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(join(teamDir, "skills.json"), JSON.stringify({ version: 1, disabled }), "utf-8");
}

function makeLoader() {
  const loader = createSkillLoader({ workdir, teamDir, env: {} });
  loader.loadSync();
  return loader;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-skill-team-"));
  workdir = join(root, "workdir");
  teamDir = join(root, "team", "skills");
  mkdirSync(workdir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SkillLoader 三层合并", () => {
  it("团队层同名技能覆盖内置，并记录 shadowed", () => {
    writeSkill(teamDir, "code-review", "团队版代码审查");
    const loader = makeLoader();

    const skill = loader.get("code-review")!;
    expect(skill.source).toBe("team");
    expect(skill.description).toBe("团队版代码审查");
    expect(skill.shadowed.map((s) => s.source)).toEqual(["builtin"]);
  });

  it("本目录层覆盖团队层（最高优先级）", () => {
    writeSkill(teamDir, "code-review", "团队版");
    writeSkill(join(workdir, ".fengagent", "skills"), "code-review", "本目录版");

    const skill = makeLoader().get("code-review")!;
    expect(skill.source).toBe("project");
    expect(skill.description).toBe("本目录版");
    expect(skill.shadowed.map((s) => s.source)).toEqual(["builtin", "team"]);
  });

  it("团队技能跨 workdir 共享（另一个 workdir 也看得到）", () => {
    writeSkill(teamDir, "shared-skill", "团队共享技能");
    const other = createSkillLoader({ workdir: join(root, "another"), teamDir, env: {} });
    other.loadSync();

    expect(other.get("shared-skill")?.description).toBe("团队共享技能");
    expect(other.get("shared-skill")?.source).toBe("team");
  });

  it("停用后 list/get/names 都不含（对内置也生效）", () => {
    writeSkill(teamDir, "team-skill", "团队技能");
    writeIndex(["team-skill", "debug"]);

    const loader = makeLoader();
    expect(loader.names()).not.toContain("team-skill");
    expect(loader.names()).not.toContain("debug");
    expect(loader.get("team-skill")).toBeUndefined();
    expect(loader.get("debug")).toBeUndefined();
    // 管理面仍能看到（enabled=false）
    const all = loader.all();
    expect(all.find((s) => s.name === "team-skill")?.enabled).toBe(false);
    expect(all.find((s) => s.name === "debug")?.enabled).toBe(false);
    expect(all.find((s) => s.name === "code-review")?.enabled).toBe(true);
  });

  it("mtime 失效：新增/停用无需重建 loader 即可见", () => {
    const loader = makeLoader();
    expect(loader.get("late-skill")).toBeUndefined();

    writeSkill(teamDir, "late-skill", "后加的技能");
    expect(loader.get("late-skill")?.description).toBe("后加的技能");

    writeIndex(["late-skill"]);
    expect(loader.get("late-skill")).toBeUndefined();
    expect(loader.all().find((s) => s.name === "late-skill")?.enabled).toBe(false);
  });

  it("解析失败的文件进 errors，不再静默吞掉", () => {
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "broken.md"), ["---", "description: 没有 name", "---", "body"].join("\n"));
    writeSkill(teamDir, "good-skill", "正常技能");

    const loader = makeLoader();
    expect(loader.get("good-skill")).toBeDefined();
    const errors = loader.errors();
    expect(errors.length).toBe(1);
    expect(errors[0]!.path.endsWith("broken.md")).toBe(true);
    expect(errors[0]!.message).toContain("name");
  });

  it("索引损坏只记一条 error，不影响技能加载", () => {
    writeSkill(teamDir, "ok-skill", "正常");
    writeFileSync(join(teamDir, "skills.json"), "{ not json");

    const loader = makeLoader();
    expect(loader.get("ok-skill")).toBeDefined();
    expect(loader.errors().some((e) => e.path.endsWith("skills.json"))).toBe(true);
  });

  it("旧 .fengagent/skills 目录继续生效（兼容）", () => {
    writeSkill(join(workdir, ".fengagent", "skills"), "legacy-skill", "老目录技能");
    const skill = makeLoader().get("legacy-skill")!;
    expect(skill.description).toBe("老目录技能");
    expect(skill.source).toBe("project");
  });

  it("layers() 给出逐层明细与 overriddenBy", () => {
    writeSkill(teamDir, "debug", "团队版 debug");
    const layers = makeLoader().layers();

    const builtinDebug = layers.find((l) => l.name === "debug" && l.source === "builtin")!;
    expect(builtinDebug.overriddenBy).toBe("team");
    const teamDebug = layers.find((l) => l.name === "debug" && l.source === "team")!;
    expect(teamDebug.overriddenBy).toBeUndefined();
  });

  it("roots() 暴露团队与项目目录", () => {
    const roots = makeLoader().roots();
    expect(roots.team).toBe(teamDir);
    expect(roots.project.some((d) => d.endsWith(".fengagent\\skills") || d.endsWith(".fengagent/skills"))).toBe(true);
  });
});
