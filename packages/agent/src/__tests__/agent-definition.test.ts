/**
 * @fengagent/agent — Agent 定义系统测试
 */

import { describe, test, expect } from "bun:test";
import {
  parseAgentMarkdown,
  createAgentDefinitionLoader,
  BUILTIN_AGENTS,
} from "../agent-definition.ts";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// parseAgentMarkdown
// ──────────────────────────────────────────────

describe("parseAgentMarkdown", () => {
  test("解析 frontmatter + body", () => {
    const content = `---
name: my-agent
description: 测试 Agent
model: claude-sonnet-4
tools:
  - file-read
  - grep
max_turns: 20
---
你是一个测试 Agent。`;
    const { frontmatter, body } = parseAgentMarkdown(content);

    expect(frontmatter["name"]).toBe("my-agent");
    expect(frontmatter["description"]).toBe("测试 Agent");
    expect(frontmatter["model"]).toBe("claude-sonnet-4");
    expect(frontmatter["tools"]).toEqual(["file-read", "grep"]);
    expect(frontmatter["max_turns"]).toBe(20);
    expect(body).toBe("你是一个测试 Agent。");
  });

  test("无 frontmatter 时返回全部作为 body", () => {
    const content = "这是纯文本内容，没有 frontmatter。";
    const { frontmatter, body } = parseAgentMarkdown(content);

    expect(frontmatter).toEqual({});
    expect(body).toBe("这是纯文本内容，没有 frontmatter。");
  });

  test("解析带引号的值", () => {
    const content = `---
name: "quoted-name"
description: 'single quoted'
---
body`;
    const { frontmatter } = parseAgentMarkdown(content);

    expect(frontmatter["name"]).toBe("quoted-name");
    expect(frontmatter["description"]).toBe("single quoted");
  });

  test("解析布尔值", () => {
    const content = `---
name: test
enabled: true
disabled: false
---
body`;
    const { frontmatter } = parseAgentMarkdown(content);

    expect(frontmatter["enabled"]).toBe(true);
    expect(frontmatter["disabled"]).toBe(false);
  });

  test("解析空列表", () => {
    const content = `---
name: test
tools: []
---
body`;
    const { frontmatter } = parseAgentMarkdown(content);

    // 空列表值 "[]" 被解析为字符串 "[]"
    // 这是简易解析器的限制 — 空列表需要用多行格式
    expect(frontmatter["tools"]).toBe("[]");
  });
});

// ──────────────────────────────────────────────
// BUILTIN_AGENTS
// ──────────────────────────────────────────────

describe("BUILTIN_AGENTS", () => {
  test("包含 default、coder、researcher", () => {
    expect(BUILTIN_AGENTS["default"]).toBeDefined();
    expect(BUILTIN_AGENTS["coder"]).toBeDefined();
    expect(BUILTIN_AGENTS["researcher"]).toBeDefined();
  });

  test("coder 只包含只读+写入+编辑+bash+glob+grep 工具", () => {
    const coder = BUILTIN_AGENTS["coder"]!;
    expect(coder.tools).toEqual([
      "file-read",
      "file-write",
      "file-edit",
      "bash",
      "glob",
      "grep",
    ]);
    // 不应包含 task 工具
    expect(coder.tools).not.toContain("task");
  });

  test("researcher 只包含只读工具", () => {
    const researcher = BUILTIN_AGENTS["researcher"]!;
    expect(researcher.tools).toEqual(["file-read", "glob", "grep"]);
    expect(researcher.tools).not.toContain("bash");
    expect(researcher.tools).not.toContain("file-write");
  });

  test("default 的 tools 为空（继承全部）", () => {
    const def = BUILTIN_AGENTS["default"]!;
    expect(def.tools).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// AgentDefinitionLoader
// ──────────────────────────────────────────────

describe("AgentDefinitionLoader", () => {
  const testDir = join(tmpdir(), "fengagent-agent-def-test");

  function setupTestDir(files: Record<string, string>): void {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(join(testDir, ".fengagent", "agents"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(testDir, ".fengagent", "agents", name),
        content,
      );
    }
  }

  function cleanup(): void {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  }

  test("加载内置 Agent 定义", async () => {
    cleanup();
    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();

    expect(loader.get("default")).toBeDefined();
    expect(loader.get("coder")).toBeDefined();
    expect(loader.get("researcher")).toBeDefined();
  });

  test("从 .fengagent/agents/*.md 加载自定义 Agent", async () => {
    setupTestDir({
      "code-reviewer.md": `---
name: code-reviewer
description: 代码审查专家
model: claude-sonnet-4
tools:
  - file-read
  - grep
  - glob
max_turns: 15
---
你是一个代码审查专家。`,
    });

    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();

    const reviewer = loader.get("code-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer!.name).toBe("code-reviewer");
    expect(reviewer!.description).toBe("代码审查专家");
    expect(reviewer!.model).toBe("claude-sonnet-4");
    expect(reviewer!.tools).toEqual(["file-read", "grep", "glob"]);
    expect(reviewer!.maxTurns).toBe(15);
    expect(reviewer!.systemPrompt).toBe("你是一个代码审查专家。");

    cleanup();
  });

  test("自定义定义覆盖内置定义", async () => {
    setupTestDir({
      "coder.md": `---
name: coder
description: 自定义 coder
model: gpt-4o
tools:
  - file-read
max_turns: 10
---
自定义 coder 系统提示。`,
    });

    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();

    const coder = loader.get("coder");
    expect(coder!.description).toBe("自定义 coder");
    expect(coder!.model).toBe("gpt-4o");
    expect(coder!.maxTurns).toBe(10);

    cleanup();
  });

  test("目录不存在时仅返回内置定义", async () => {
    cleanup();
    const loader = createAgentDefinitionLoader({
      workdir: join(testDir, "nonexistent"),
    });
    await loader.load();

    expect(loader.list().length).toBeGreaterThanOrEqual(3);
    expect(loader.get("default")).toBeDefined();

    cleanup();
  });

  test("list() 返回所有定义", async () => {
    setupTestDir({
      "extra.md": `---
name: extra
description: 额外 Agent
---
额外提示。`,
    });

    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();

    const all = loader.list();
    const names = all.map((d) => d.name);
    expect(names).toContain("default");
    expect(names).toContain("coder");
    expect(names).toContain("researcher");
    expect(names).toContain("extra");

    cleanup();
  });

  test("names() 返回所有名称", async () => {
    cleanup();
    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();

    const names = loader.names();
    expect(names).toContain("default");
    expect(names).toContain("coder");
    expect(names).toContain("researcher");
  });

  test("reset() 后重新加载", async () => {
    cleanup();
    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();
    expect(loader.isLoaded).toBe(true);

    loader.reset();
    expect(loader.isLoaded).toBe(false);
    expect(loader.get("default")).toBeUndefined();

    await loader.load();
    expect(loader.isLoaded).toBe(true);
    expect(loader.get("default")).toBeDefined();
  });

  test("load() 幂等（多次调用不重复加载）", async () => {
    cleanup();
    const loader = createAgentDefinitionLoader({ workdir: testDir });
    await loader.load();
    const count1 = loader.list().length;

    await loader.load(); // 第二次不应改变
    const count2 = loader.list().length;

    expect(count1).toBe(count2);
  });
});
