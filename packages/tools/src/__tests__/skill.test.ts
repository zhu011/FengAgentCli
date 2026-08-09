/**
 * Skill system tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSkillLoader, createSkillTool } from "../builtin/skill.ts";
import type { ToolContext } from "@fengagent/core";

const TEST_WORKDIR = join(tmpdir(), "fengagent-skill-test");
const TEST_CONTEXT: ToolContext = {
  workdir: TEST_WORKDIR,
  sessionId: "test-session",
  messageId: "test-msg",
};

function setup(): void {
  if (!existsSync(TEST_WORKDIR)) {
    mkdirSync(TEST_WORKDIR, { recursive: true });
  }
}

function cleanup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
}

function writeSkillFile(name: string, content: string): void {
  const skillsDir = join(TEST_WORKDIR, ".fengagent", "skills");
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }
  writeFileSync(join(skillsDir, name + ".md"), content);
}

// ──────────────────────────────────────────────
// SkillLoader tests
// ──────────────────────────────────────────────

describe("SkillLoader", () => {
  beforeAll(() => setup());
  afterAll(() => cleanup());

  it("loads built-in skills when no files exist", async () => {
    const loader = createSkillLoader({ workdir: join(TEST_WORKDIR, "empty") });
    await loader.load();

    const skills = loader.list();
    expect(skills.length).toBeGreaterThanOrEqual(4);

    const names = loader.names();
    expect(names).toContain("code-review");
    expect(names).toContain("debug");
    expect(names).toContain("refactor");
    expect(names).toContain("test");
  });

  it("loads only once (idempotent)", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();
    const count1 = loader.list().length;

    await loader.load();
    const count2 = loader.list().length;

    expect(count1).toBe(count2);
  });

  it("loads custom skill from .fengagent/skills/*.md", async () => {
    writeSkillFile("my-skill", [
      "---",
      "name: my-skill",
      "description: A custom test skill",
      "trigger: When user says hello",
      "---",
      "",
      "This is the prompt body.",
    ].join("\n"));

    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const skill = loader.get("my-skill");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("my-skill");
    expect(skill!.description).toBe("A custom test skill");
    expect(skill!.trigger).toBe("When user says hello");
    expect(skill!.prompt).toBe("This is the prompt body.");
  });

  it("custom skills override built-in skills with same name", async () => {
    writeSkillFile("code-review", [
      "---",
      "name: code-review",
      "description: Custom code review skill",
      "trigger: On request",
      "---",
      "",
      "Custom review prompt.",
    ].join("\n"));

    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const skill = loader.get("code-review");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("Custom code review skill");
    expect(skill!.prompt).toBe("Custom review prompt.");
  });

  it("get returns undefined for nonexistent skill", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    expect(loader.get("nonexistent")).toBeUndefined();
  });

  it("names returns all skill names", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const names = loader.names();
    expect(names).toContain("code-review");
    expect(names).toContain("debug");
    expect(names).toContain("refactor");
    expect(names).toContain("test");
  });

  it("handles skill files without name gracefully", async () => {
    writeSkillFile("no-name", [
      "---",
      "description: I have no name",
      "---",
      "",
      "No name skill.",
    ].join("\n"));

    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    expect(loader.get("")).toBeUndefined();
  });

  it("handles skill files without frontmatter", async () => {
    writeSkillFile("plain", [
      "This file has no frontmatter.",
      "Just plain text.",
    ].join("\n"));

    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    expect(loader.get("")).toBeUndefined();
  });

  it("respects custom skillsDir option", async () => {
    const customDir = join(TEST_WORKDIR, "custom-skills");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, "custom-skill.md"), [
      "---",
      "name: custom-skill",
      "description: From custom dir",
      "trigger: On request",
      "---",
      "",
      "Custom prompt.",
    ].join("\n"));

    const loader = createSkillLoader({ workdir: TEST_WORKDIR, skillsDir: customDir });
    await loader.load();

    const skill = loader.get("custom-skill");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("From custom dir");
  });

  it("isLoaded flag works correctly", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    expect(loader.isLoaded).toBe(false);

    await loader.load();
    expect(loader.isLoaded).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Built-in Skill definitions
// ──────────────────────────────────────────────

describe("Built-in Skills", () => {
  it("code-review skill has correct structure", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const skill = loader.get("code-review")!;
    expect(skill.name).toBe("code-review");
    expect(skill.description).toBeTruthy();
    expect(skill.trigger).toBeTruthy();
    expect(skill.prompt).toBeTruthy();
    expect(skill.prompt).toContain("代码审查");
  });

  it("debug skill has correct structure", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const skill = loader.get("debug")!;
    expect(skill.name).toBe("debug");
    expect(skill.description).toBeTruthy();
    expect(skill.trigger).toBeTruthy();
    expect(skill.prompt).toContain("调试");
  });

  it("refactor skill has correct structure", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const skill = loader.get("refactor")!;
    expect(skill.name).toBe("refactor");
    expect(skill.description).toBeTruthy();
    expect(skill.trigger).toBeTruthy();
    expect(skill.prompt).toContain("重构");
  });

  it("test skill has correct structure", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();

    const skill = loader.get("test")!;
    expect(skill.name).toBe("test");
    expect(skill.description).toBeTruthy();
    expect(skill.trigger).toBeTruthy();
    expect(skill.prompt).toContain("测试");
  });
});

// ──────────────────────────────────────────────
// skill tool tests
// ──────────────────────────────────────────────

describe("skill tool", () => {
  beforeAll(() => setup());
  afterAll(() => cleanup());

  it("creates skill tool without explicit loader", () => {
    const tool = createSkillTool();
    expect(tool).toBeDefined();
    expect(tool.name).toBe("skill");
    expect(tool.description).toBeTruthy();
  });

  it("creates skill tool with explicit loader", async () => {
    const loader = createSkillLoader({ workdir: TEST_WORKDIR });
    await loader.load();
    const tool = createSkillTool(loader);
    expect(tool.name).toBe("skill");
  });

  it("lists skills (action=list)", async () => {
    writeSkillFile("test-skill", [
      "---",
      "name: test-skill",
      "description: Test skill for listing",
      "trigger: On test",
      "---",
      "",
      "Prompt.",
    ].join("\n"));

    const tool = createSkillTool();
    const result = await tool.execute({ action: "list" }, TEST_CONTEXT);

    expect(result.content).not.toBe("No skills available.");
    expect(result.content).toContain("code-review");
    expect(result.content).toContain("debug");
    expect(result.content).toContain("refactor");
    expect(result.content).toContain("test");
    expect(result.metadata).toBeDefined();
  });

  it("lists built-in skills in a clean empty directory", async () => {
    const cleanWorkdir = join(TEST_WORKDIR, "clean-empty-" + Date.now());
    mkdirSync(cleanWorkdir, { recursive: true });

    const loader = createSkillLoader({ workdir: cleanWorkdir });
    await loader.load();

    const skills = loader.list();
    expect(skills.length).toBeGreaterThanOrEqual(4);
    expect(skills.some((s) => s.name === "code-review")).toBe(true);
  });

  it("loads a specific skill (action=load)", async () => {
    writeSkillFile("load-test", [
      "---",
      "name: load-test",
      "description: For loading test",
      "trigger: On load test",
      "---",
      "",
      "This is the loaded prompt.",
    ].join("\n"));

    const tool = createSkillTool();
    const result = await tool.execute({ action: "load", name: "load-test" }, TEST_CONTEXT);

    expect(result.content).toBe("This is the loaded prompt.");
    expect((result.metadata as any)["name"]).toBe("load-test");
  });

  it("returns error when loading nonexistent skill", async () => {
    const tool = createSkillTool();
    const result = await tool.execute({ action: "load", name: "nonexistent-skill-xyz" }, TEST_CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when loading without name", async () => {
    const tool = createSkillTool();
    const result = await tool.execute({ action: "load" } as any, TEST_CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("renders list action correctly", () => {
    const tool = createSkillTool();
    const rendered = tool.renderUse!({ action: "list" });
    expect(rendered).toContain("list");
  });

  it("renders load action correctly", () => {
    const tool = createSkillTool();
    const rendered = tool.renderUse!({ action: "load", name: "code-review" });
    expect(rendered).toContain("code-review");
  });

  it("renders load with missing name", () => {
    const tool = createSkillTool();
    const rendered = tool.renderUse!({ action: "load" });
    expect(rendered).toContain("?");
  });

  it("is read-only", () => {
    const tool = createSkillTool();
    expect(tool.isReadOnly!({ action: "list" })).toBe(true);
    expect(tool.isReadOnly!({ action: "load", name: "test" })).toBe(true);
  });

  it("is not destructive", () => {
    const tool = createSkillTool();
    expect(tool.isDestructive!({ action: "list" })).toBe(false);
  });

  it("is concurrency safe", () => {
    const tool = createSkillTool();
    expect(tool.isConcurrencySafe!({ action: "list" })).toBe(true);
  });

  it("returns error for unknown action", async () => {
    const tool = createSkillTool();
    const result = await tool.execute({ action: "unknown" as any }, TEST_CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown action");
  });

  it("metadata for load action contains skill info", async () => {
    writeSkillFile("meta-test", [
      "---",
      "name: meta-test",
      "description: Metadata test skill",
      "trigger: On meta test",
      "---",
      "",
      "Metadata prompt.",
    ].join("\n"));

    const tool = createSkillTool();
    const result = await tool.execute({ action: "load", name: "meta-test" }, TEST_CONTEXT);

    const meta = result.metadata as any;
    expect(meta["name"]).toBe("meta-test");
    expect(meta["description"]).toBe("Metadata test skill");
    expect(meta["trigger"]).toBe("On meta test");
  });

  it("metadata for list action contains skill count and names", async () => {
    writeSkillFile("count-test", [
      "---",
      "name: count-test",
      "description: For counting",
      "trigger: On count",
      "---",
      "",
      "Count prompt.",
    ].join("\n"));

    const tool = createSkillTool();
    const result = await tool.execute({ action: "list" }, TEST_CONTEXT);

    const skills = (result.metadata as any)["skills"] as Array<{ name: string; description: string }>;
    expect(skills.some((s) => s.name === "count-test")).toBe(true);
  });
});
