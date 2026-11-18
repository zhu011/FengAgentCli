/**
 * Skill 四路导入 + 版本/使用关系（P1）测试。
 *
 * 覆盖：manual / local / url / runtime_copy 四种导入、冲突策略（fail/overwrite/
 * rename/skip）、URL 安全（非 https、域名白名单、重定向二次校验、大小上限）、
 * 版本快照与回滚、来源台账、「被谁使用」。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SkillMountStore } from "@fengagent/agent";
import { createSkillRoutes } from "../routes/skills.ts";
import { createSkillLoader } from "@fengagent/tools/builtin/skill";
import {
  SKILL_SOURCES_FILE,
  hashSkillContent,
  type SkillFetch,
} from "../skill-service.ts";

let root: string;
let workdir: string;
let teamDir: string;
let mounts: SkillMountStore;
let app: Hono;
let fetchImpl: SkillFetch;
let fetchCalls: string[];

/** 造一个带 frontmatter 的 SKILL.md */
function skillMarkdown(name: string, description = "描述", body = "正文"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 构造带可控 status/url/body 的 Response */
function fakeResponse(
  body: string,
  init: { status?: number; url?: string; contentLength?: number } = {},
): Response {
  const response = new Response(body, { status: init.status ?? 200 });
  Object.defineProperty(response, "url", { value: init.url ?? "" });
  if (init.contentLength !== undefined) {
    Object.defineProperty(response.headers, "get", {
      value: (name: string) =>
        name.toLowerCase() === "content-length" ? String(init.contentLength) : null,
    });
  }
  return response;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-skills-p1-"));
  workdir = join(root, "workdir");
  teamDir = join(root, "team", "skills");
  mkdirSync(workdir, { recursive: true });
  mounts = new SkillMountStore(join(root, "sessions.db"));
  fetchCalls = [];
  fetchImpl = async (input) => {
    fetchCalls.push(String(input));
    return fakeResponse(skillMarkdown("url-skill", "URL 导入"), { url: String(input) });
  };
  app = createSkillRoutes({
    workdir,
    teamDir,
    env: {},
    mounts,
    fetchImpl: (input, init) => fetchImpl(input, init),
  });
});

afterEach(() => {
  mounts.close();
  rmSync(root, { recursive: true, force: true });
});

/** 内容层是否真的可被 agent 侧 loader 读到 */
function agentVisible(name: string): boolean {
  const loader = createSkillLoader({ workdir, teamDir, env: {} });
  loader.loadSync();
  return loader.names().includes(name);
}

describe("POST /api/skills/import — manual", () => {
  test("手动导入：落盘 + 版本 v1 + 来源台账", async () => {
    const res = await app.request(
      "/import",
      json({ type: "manual", name: "manual-skill", description: "手动", prompt: "按步骤执行" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      skill: { name: string; source: string };
      revision: { version: number; contentHash: string };
    };
    expect(body.skill.name).toBe("manual-skill");
    expect(body.revision.version).toBe(1);
    expect(agentVisible("manual-skill")).toBe(true);

    const ledger = JSON.parse(readFileSync(join(teamDir, SKILL_SOURCES_FILE), "utf-8")) as {
      sources: Record<string, { type: string; sha256: string }>;
    };
    expect(ledger.sources["manual-skill"]?.type).toBe("manual");
    expect(ledger.sources["manual-skill"]?.sha256).toHaveLength(64);
  });

  test("重名默认 409；overwrite 覆盖；skip 不动内容", async () => {
    await app.request(
      "/import",
      json({ type: "manual", name: "dup", description: "一", prompt: "v1" }),
    );

    const conflict = await app.request(
      "/import",
      json({ type: "manual", name: "dup", description: "二", prompt: "v2" }),
    );
    expect(conflict.status).toBe(409);

    const overwritten = await app.request(
      "/import",
      json({ type: "manual", name: "dup", description: "二", prompt: "v2", onConflict: "overwrite" }),
    );
    expect(overwritten.status).toBe(201);
    const detail = (await (await app.request("/dup")).json()) as { prompt: string };
    expect(detail.prompt).toContain("v2");

    const skipped = await app.request(
      "/import",
      json({ type: "manual", name: "dup", description: "三", prompt: "v3", onConflict: "skip" }),
    );
    expect(skipped.status).toBe(200);
    expect(((await skipped.json()) as { skipped: boolean }).skipped).toBe(true);
  });
});

describe("POST /api/skills/import — local", () => {
  test("从允许根导入：正文/描述按 frontmatter 解析", async () => {
    const source = join(workdir, "my-skill.md");
    writeFileSync(source, skillMarkdown("local-skill", "本地导入", "本地正文"), "utf-8");

    const res = await app.request("/import", json({ type: "local", path: source }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      skill: { name: string; description: string; prompt: string };
    };
    expect(body.skill.name).toBe("local-skill");
    expect(body.skill.description).toBe("本地导入");
    expect(body.skill.prompt).toContain("本地正文");
    expect(agentVisible("local-skill")).toBe(true);
  });

  test("拒绝允许根之外的路径", async () => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, skillMarkdown("outside"), "utf-8");
    const res = await app.request("/import", json({ type: "local", path: outside }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  test("缺少 frontmatter name 的 .md 拒绝导入", async () => {
    const source = join(workdir, "nameless.md");
    writeFileSync(source, "---\ndescription: 无名字\n---\n\n正文\n", "utf-8");
    const res = await app.request("/import", json({ type: "local", path: source }));
    expect(res.status).toBe(400);
  });

  test("真实 skill 的长 description（>200 字）不被导入拒绝", async () => {
    // anthropics/skills 等真实仓库的 description 常见 300+ 字；表单上限不该卡导入
    const longDescription = "场景说明".repeat(100);
    const source = join(workdir, "long-desc.md");
    writeFileSync(source, skillMarkdown("long-desc", longDescription), "utf-8");
    const res = await app.request("/import", json({ type: "local", path: source }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { skill: { description: string } };
    expect(body.skill.description.length).toBeGreaterThan(200);
  });

  test("rename 策略：重名时落 name-2，正文与来源保留", async () => {
    const source = join(workdir, "rename-me.md");
    writeFileSync(source, skillMarkdown("rename-me", "第一版"), "utf-8");
    await app.request("/import", json({ type: "local", path: source }));

    writeFileSync(source, skillMarkdown("rename-me", "第二版"), "utf-8");
    const res = await app.request(
      "/import",
      json({ type: "local", path: source, onConflict: "rename" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      skill: { name: string; description: string };
      renamedFrom: string;
    };
    expect(body.skill.name).toBe("rename-me-2");
    expect(body.skill.description).toBe("第二版");
    expect(body.renamedFrom).toBe("rename-me");
    expect(agentVisible("rename-me-2")).toBe(true);
  });
});

describe("POST /api/skills/import — url", () => {
  test("https + 白名单域名：导入成功并记录 sha256", async () => {
    const res = await app.request(
      "/import",
      json({ type: "url", url: "https://raw.githubusercontent.com/o/r/main/skill.md" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      skill: { name: string };
      source: { url: string; sha256: string };
    };
    expect(body.skill.name).toBe("url-skill");
    expect(body.source.sha256).toBe(hashSkillContent(skillMarkdown("url-skill", "URL 导入")));
  });

  test("拒绝非 https / 非白名单域名", async () => {
    const http = await app.request(
      "/import",
      json({ type: "url", url: "http://raw.githubusercontent.com/o/r/main/x.md" }),
    );
    expect(http.status).toBe(400);
    const host = await app.request(
      "/import",
      json({ type: "url", url: "https://evil.example.com/x.md" }),
    );
    expect(host.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  test("重定向后最终 host 不在白名单 → 拒绝（SSRF 兜底）", async () => {
    fetchImpl = async () =>
      fakeResponse(skillMarkdown("redir"), { url: "https://evil.example.com/x.md" });
    const res = await app.request(
      "/import",
      json({ type: "url", url: "https://github.com/o/r/raw/main/skill.md" }),
    );
    expect(res.status).toBe(400);
  });

  test("超过 1 MiB → 拒绝", async () => {
    fetchImpl = async () =>
      fakeResponse(skillMarkdown("big"), { contentLength: 2 * 1024 * 1024 });
    const res = await app.request(
      "/import",
      json({ type: "url", url: "https://raw.githubusercontent.com/o/r/main/big.md" }),
    );
    expect(res.status).toBe(400);
  });

  test("非 markdown（缺 frontmatter）→ 拒绝", async () => {
    fetchImpl = async () => fakeResponse("裸正文没有 frontmatter");
    const res = await app.request(
      "/import",
      json({ type: "url", url: "https://raw.githubusercontent.com/o/r/main/plain.md" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/skills/import — runtime_copy", () => {
  test("从运行时声明的 skills 根复制（<root>/<name>/SKILL.md）", async () => {
    const runtimeRoot = join(root, "claude-skills");
    mkdirSync(join(runtimeRoot, "runtime-skill"), { recursive: true });
    writeFileSync(
      join(runtimeRoot, "runtime-skill", "SKILL.md"),
      skillMarkdown("runtime-skill", "来自 claude"),
      "utf-8",
    );
    const runtimeApp = createSkillRoutes({
      workdir,
      teamDir,
      env: {},
      mounts,
      runtimeSkillRoots: { claude: runtimeRoot },
    });
    const res = await runtimeApp.request(
      "/import",
      json({ type: "runtime_copy", runtime: "claude", skillName: "runtime-skill" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      skill: { name: string };
      source: { runtime: string };
    };
    expect(body.skill.name).toBe("runtime-skill");
    expect(body.source.runtime).toBe("claude");
    expect(agentVisible("runtime-skill")).toBe(true);
  });

  test("运行时未声明根 / 名字不存在 → 400/404", async () => {
    const unknown = await app.request(
      "/import",
      json({ type: "runtime_copy", runtime: "nope", skillName: "x" }),
    );
    expect(unknown.status).toBe(400);
    const missing = await app.request(
      "/import",
      json({ type: "runtime_copy", runtime: "claude", skillName: "nope" }),
    );
    expect(missing.status).toBe(404);
  });
});

describe("版本与使用关系", () => {
  test("revisions 追加、restore 回滚到上一版", async () => {
    await app.request(
      "/import",
      json({ type: "manual", name: "rev", description: "d", prompt: "v1" }),
    );
    await app.request("/rev", json({ prompt: "v2" }, "PATCH"));

    const list = (await (await app.request("/rev/revisions")).json()) as {
      revisions: Array<{ version: number }>;
    };
    expect(list.revisions.map((item) => item.version)).toEqual([2, 1]);

    const restored = await app.request("/rev/restore", json({ version: 1 }));
    expect(restored.status).toBe(200);
    const detail = (await (await app.request("/rev")).json()) as { prompt: string };
    expect(detail.prompt).toContain("v1");

    const after = (await (await app.request("/rev/revisions")).json()) as {
      revisions: Array<{ version: number; source: string }>;
    };
    expect(after.revisions[0]?.version).toBe(3);
    expect(after.revisions[0]?.source).toBe("restore");
  });

  test("restore 不存在的版本 → 404", async () => {
    await app.request(
      "/import",
      json({ type: "manual", name: "rev2", description: "d", prompt: "p" }),
    );
    const res = await app.request("/rev2/restore", json({ version: 99 }));
    expect(res.status).toBe(404);
  });

  test("usage：一个 skill 被多个 agent 挂载（含停用）", async () => {
    await app.request(
      "/import",
      json({ type: "manual", name: "shared", description: "d", prompt: "p" }),
    );
    mounts.add({ agentId: "coder", skillName: "shared", source: "team" });
    mounts.add({ agentId: "reviewer", skillName: "shared", source: "team" });
    mounts.patch("reviewer", "shared", { enabled: false });

    const usage = (await (await app.request("/shared/usage")).json()) as {
      count: number;
      agents: Array<{ agentId: string; enabled: boolean }>;
    };
    expect(usage.count).toBe(2);
    expect(usage.agents.find((agent) => agent.agentId === "reviewer")?.enabled).toBe(false);
  });

  test("导入校验：type 非法 400", async () => {
    const res = await app.request("/import", json({ type: "ftp" }));
    expect(res.status).toBe(400);
  });

  test("来源台账在团队目录，不污染 skill 列表", async () => {
    await app.request(
      "/import",
      json({ type: "manual", name: "ledger", description: "d", prompt: "p" }),
    );
    expect(existsSync(join(teamDir, SKILL_SOURCES_FILE))).toBe(true);
    const list = (await (await app.request("/?merge=1")).json()) as {
      skills: Array<{ name: string }>;
    };
    expect(list.skills.map((skill) => skill.name)).not.toContain(SKILL_SOURCES_FILE);
  });
});
