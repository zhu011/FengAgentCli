/**
 * 智能体仓（P0）测试：目录形态 / 模板一键创建 / 绑定与解绑 / 归档 / 旧平铺迁移。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, AgentRegistryError } from "../agent-registry.ts";
import { createAgentDefinitionLoader } from "../agent-definition.ts";

let root: string;
let workdir: string;
let registry: AgentRegistry;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-agent-registry-"));
  workdir = join(root, "workdir");
  mkdirSync(workdir, { recursive: true });
  registry = new AgentRegistry({ dataRoot: root, workdir });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("AgentRegistry — 目录即真相", () => {
  test("模板一键创建：落 agent.md + config.json，字段来自模板", async () => {
    const agent = registry.create({ template: "coder", runtime: "claude" });
    expect(agent.id).toBe("coder");
    expect(agent.displayName).toBe("代码工程师");
    expect(agent.runtime).toBe("claude");
    expect(agent.tools).toContain("file-read");
    expect(agent.instructions).toContain("代码编写 Agent");

    const dir = join(root, "agents", "coder");
    expect(existsSync(join(dir, "agent.md"))).toBe(true);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    const markdown = readFileSync(join(dir, "agent.md"), "utf8");
    expect(markdown).toContain("name: coder");
    expect(markdown).toContain("runtime: claude");
    expect(markdown).toContain("---");

    // 既有 loader 也能读到目录形态（迁移期双读）
    const loader = createAgentDefinitionLoader({ agentsDir: registry.directory });
    await loader.load();
    const info = loader.get("coder");
    expect(info?.description).toContain("代码编写");
    expect(info?.systemPrompt).toContain("代码编写 Agent");
  });

  test("绑定 → 解绑：解绑只置空，agent 与历史仍在", () => {
    registry.create({ id: "reviewer-x", displayName: "评审", runtime: "dsh" });
    const unbound = registry.update("reviewer-x", { runtime: null });
    expect(unbound.runtime).toBeNull();
    expect(registry.get("reviewer-x")?.runtime).toBeNull();
    // 重新绑定
    expect(registry.update("reviewer-x", { runtime: "claude" }).runtime).toBe("claude");
  });

  test("归档 = 软删：列表隐藏，get 仍可读，目录不删", () => {
    registry.create({ id: "old", displayName: "老 agent" });
    const archived = registry.archive("old");
    expect(archived.archivedAt).toBeGreaterThan(0);
    expect(registry.list().map((agent) => agent.id)).not.toContain("old");
    expect(registry.list({ includeArchived: true }).map((agent) => agent.id)).toContain("old");
    expect(registry.get("old")?.archivedAt).toBeGreaterThan(0);
    expect(existsSync(join(root, "agents", "old", "agent.md"))).toBe(true);
  });

  test("重名 / 非法 id / 坏参数都有明确错误码", () => {
    registry.create({ id: "dup" });
    try {
      registry.create({ id: "dup" });
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentRegistryError);
      expect((err as AgentRegistryError).code).toBe("conflict");
    }
    expect(() => registry.create({ id: "Bad ID" })).toThrow(/agent id/);
    expect(() =>
      registry.create({ id: "args", config: { args: ["line1\nline2"] } }),
    ).toThrow(/换行/);
    expect(() => registry.create({ template: "nope" })).toThrow(/模板不存在/);
  });

  test("旧平铺 .fengagent/agents/*.md 可读，migrateLegacy 幂等且保留原文件", () => {
    const legacyDir = join(workdir, ".fengagent", "agents");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "legacy.md"),
      [
        "---",
        "name: legacy",
        "description: 旧格式 agent",
        "tools:",
        "  - file-read",
        "---",
        "你是旧格式 agent。",
      ].join("\n"),
      "utf8",
    );

    const list = registry.list();
    expect(list.map((agent) => agent.id)).toContain("legacy");
    const legacy = registry.get("legacy")!;
    expect(legacy.instructions).toContain("旧格式");
    expect(legacy.runtime).toBeNull();

    const first = registry.migrateLegacy();
    expect(first).toContain("legacy");
    expect(existsSync(join(root, "agents", "legacy", "agent.md"))).toBe(true);
    // 原文件保留
    expect(existsSync(join(legacyDir, "legacy.md"))).toBe(true);
    // 幂等
    expect(registry.migrateLegacy()).toEqual([]);
  });

  test("config.json 读写往返：env / args / skills / cwd", () => {
    registry.create({
      id: "configured",
      config: {
        env: { NODE_ENV: "development" },
        envSecrets: { GITHUB_TOKEN: "secret://github.token" },
        args: ["--max-output", "64000"],
        skills: ["code-review"],
        mcp: ["context7"],
      },
    });
    const agent = registry.get("configured")!;
    expect(agent.config.env.NODE_ENV).toBe("development");
    expect(agent.config.envSecrets.GITHUB_TOKEN).toBe("secret://github.token");
    expect(agent.config.args).toEqual(["--max-output", "64000"]);
    expect(agent.config.skills).toEqual(["code-review"]);
    expect(agent.config.mcp).toEqual(["context7"]);
  });
});
