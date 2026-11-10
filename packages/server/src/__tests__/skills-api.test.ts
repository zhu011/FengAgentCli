/**
 * 团队级技能库 — `/api/skills` 路由测试（P0）
 *
 * 覆盖：合并视图来源/覆盖关系、新建落盘、重名 409、编辑锁名、内置编辑=团队覆盖、
 * 停用后 agent 侧不可见、删除与恢复默认、参数校验错误体。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSkillRoutes } from "../routes/skills.ts";
import { createApp } from "../server.ts";
import { createSkillLoader } from "@fengagent/tools/builtin/skill";
import { ConfigSchema, type Config } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";

let root: string;
let workdir: string;
let teamDir: string;
let app: Hono;

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-skills-api-"));
  workdir = join(root, "workdir");
  teamDir = join(root, "team", "skills");
  mkdirSync(workdir, { recursive: true });
  app = createSkillRoutes({ workdir, teamDir, env: {} });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 直接问 loader：验证「API 写的，agent 侧读到的」是同一套 */
function agentVisible(): { names: string[]; get: (n: string) => unknown } {
  const loader = createSkillLoader({ workdir, teamDir, env: {} });
  loader.loadSync();
  return { names: loader.names(), get: (n) => loader.get(n) };
}

describe("/api/skills", () => {
  test("merge 视图：内置 + 团队 + 来源/覆盖关系", async () => {
    const res = await app.request("/?merge=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; source: string }>; roots: { team: string } };
    expect(body.skills.map((s) => s.name)).toContain("code-review");
    expect(body.skills.find((s) => s.name === "code-review")?.source).toBe("builtin");
    expect(body.roots.team).toBe(teamDir);

    // 同名覆盖内置时 layers 里能看出 overriddenBy
    const created = await app.request("/", json({
      name: "code-review",
      description: "团队版审查",
      trigger: "当需要审查时",
      prompt: "团队审查 prompt",
    }));
    expect(created.status).toBe(201);

    const merged = (await (await app.request("/?merge=1")).json()) as {
      skills: Array<{ name: string; source: string; shadowed: Array<{ source: string }> }>;
      layers: Array<{ name: string; source: string; overriddenBy?: string }>;
    };
    const winner = merged.skills.find((s) => s.name === "code-review")!;
    expect(winner.source).toBe("team");
    expect(winner.shadowed.map((s) => s.source)).toContain("builtin");
    const builtinLayer = merged.layers.find((l) => l.name === "code-review" && l.source === "builtin")!;
    expect(builtinLayer.overriddenBy).toBe("team");
  });

  test("不带 merge 只回团队层", async () => {
    await app.request("/", json({ name: "team-only", description: "团队技能", prompt: "p" }));
    const body = (await (await app.request("/")).json()) as { skills: Array<{ name: string; source: string }> };
    expect(body.skills.map((s) => s.name)).toEqual(["team-only"]);
    expect(body.skills[0]!.source).toBe("team");
  });

  test("新建：落盘为团队目录 .md，agent 侧立即可见", async () => {
    const res = await app.request("/", json({ name: "api-skill", description: "接口新建", trigger: "当需要时", prompt: "hello prompt" }));
    expect(res.status).toBe(201);
    const view = (await res.json()) as { name: string; source: string; enabled: boolean; editable: boolean };
    expect(view).toMatchObject({ name: "api-skill", source: "team", enabled: true, editable: true });

    expect(existsSync(join(teamDir, "api-skill.md"))).toBe(true);
    expect(agentVisible().names).toContain("api-skill");
  });

  test("重名 409（错误体带 code）", async () => {
    await app.request("/", json({ name: "dup-skill", description: "第一次", prompt: "p" }));
    const res = await app.request("/", json({ name: "dup-skill", description: "第二次", prompt: "p" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("dup-skill");
  });

  test("参数校验：非 kebab-case 名称 400", async () => {
    const res = await app.request("/", json({ name: "Bad_Name", description: "x", prompt: "p" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");

    const noDesc = await app.request("/", json({ name: "no-desc", description: "", prompt: "p" }));
    expect(noDesc.status).toBe(400);
  });

  test("编辑锁定名称：body 里换名 400", async () => {
    await app.request("/", json({ name: "rename-me", description: "x", prompt: "p" }));
    const res = await app.request("/rename-me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "other-name", description: "y" }),
    });
    expect(res.status).toBe(400);
  });

  test("编辑内置技能 = 创建团队级同名覆盖", async () => {
    const res = await app.request("/code-review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "被团队改写的审查", prompt: "覆盖后的 prompt" }),
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { source: string; description: string };
    expect(view.source).toBe("team");
    expect(view.description).toBe("被团队改写的审查");
    expect(existsSync(join(teamDir, "code-review.md"))).toBe(true);
    expect(agentVisible().get("code-review")).toMatchObject({ description: "被团队改写的审查", source: "team" });
  });

  test("停用：API 可见 enabled=false，agent 侧 list/load 都不含", async () => {
    await app.request("/", json({ name: "switch-skill", description: "开关技能", prompt: "p" }));
    const off = await app.request("/switch-skill", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(agentVisible().names).not.toContain("switch-skill");

    // 合并视图仍列出（管理面要显示开关状态）
    const merged = (await (await app.request("/?merge=1")).json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(merged.skills.find((s) => s.name === "switch-skill")?.enabled).toBe(false);

    const on = await app.request("/switch-skill", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
    expect(agentVisible().names).toContain("switch-skill");
  });

  test("内置技能可停用（停用名单对内置生效）", async () => {
    const res = await app.request("/debug", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(agentVisible().names).not.toContain("debug");
  });

  test("删除团队技能；内置/本目录 409 提示用恢复默认", async () => {
    await app.request("/", json({ name: "delete-me", description: "待删", prompt: "p" }));
    const del = await app.request("/delete-me", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(join(teamDir, "delete-me.md"))).toBe(false);
    expect(agentVisible().names).not.toContain("delete-me");

    const delBuiltin = await app.request("/code-review", { method: "DELETE" });
    expect(delBuiltin.status).toBe(409);
    const err = (await delBuiltin.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("not_editable");
    expect(err.error.message).toContain("恢复默认");
  });

  test("恢复默认：移除团队覆盖并解除停用，回到内置定义", async () => {
    await app.request("/code-review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "临时覆盖" }),
    });
    await app.request("/code-review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(agentVisible().names).not.toContain("code-review");

    const reset = await app.request("/code-review/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const view = (await reset.json()) as { source: string; enabled: boolean };
    expect(view.source).toBe("builtin");
    expect(view.enabled).toBe(true);
    expect(existsSync(join(teamDir, "code-review.md"))).toBe(false);
    expect(agentVisible().names).toContain("code-review");
  });

  test("详情 404 与非法名字不越权读写", async () => {
    const missing = await app.request("/nope-nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");

    // 路径穿越式名字：不能读到团队目录外的文件
    const traversal = await app.request("/" + encodeURIComponent("../escape"));
    expect([400, 404]).toContain(traversal.status);
    expect(existsSync(join(teamDir, "..", "escape.md"))).toBe(false);
  });

  test("团队技能跨 workdir 可见（另一 workdir 的合并视图含同一团队技能）", async () => {
    await app.request("/", json({ name: "cross-dir", description: "跨目录共享", prompt: "p" }));

    const otherWorkdir = join(root, "other-workdir");
    mkdirSync(otherWorkdir, { recursive: true });
    const otherApp = createSkillRoutes({ workdir: otherWorkdir, teamDir, env: {} });
    const body = (await (await otherApp.request("/?merge=1")).json()) as { skills: Array<{ name: string; source: string }> };
    expect(body.skills.find((s) => s.name === "cross-dir")?.source).toBe("team");
  });

  test("本目录层覆盖团队/内置时，对外 source=workdir 且 overriddenBy 指回 workdir", async () => {
    await app.request("/", json({ name: "code-review", description: "团队版", prompt: "team prompt" }));
    const localDir = join(workdir, ".fengagent", "skills");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, "code-review.md"),
      ["---", "name: code-review", "description: 本目录版", "---", "", "local prompt"].join("\n"),
    );

    const merged = (await (await app.request("/?merge=1")).json()) as {
      skills: Array<{ name: string; source: string; shadowed: Array<{ source: string }> }>;
      layers: Array<{ name: string; source: string; overriddenBy?: string }>;
    };
    const winner = merged.skills.find((s) => s.name === "code-review")!;
    expect(winner.source).toBe("workdir");
    expect(winner.shadowed.map((s) => s.source)).toEqual(["builtin", "team"]);
    expect(merged.layers.find((l) => l.name === "code-review" && l.source === "team")?.overriddenBy).toBe("workdir");
  });

  test("解析失败文件进 errors 数组（列表不阻塞）", async () => {
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "broken.md"), ["---", "description: 缺 name", "---", "body"].join("\n"));
    const body = (await (await app.request("/?merge=1")).json()) as { errors: Array<{ path: string }> };
    expect(body.errors.some((e) => e.path.endsWith("broken.md"))).toBe(true);
  });
});

describe("createApp 装配", () => {
  test("/api/skills 常驻挂载，并可注入 workdir/teamDir", async () => {
    const config: Config = ConfigSchema.parse({ corsOrigin: "*" });
    const createAgent = (() => ({}) as Agent) as () => Agent;
    const { app: mounted } = createApp({
      config,
      createAgent,
      skills: { workdir, teamDir, env: {} },
    });

    const res = await mounted.request("/api/skills?merge=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roots: { team: string }; skills: Array<{ name: string }> };
    expect(body.roots.team).toBe(teamDir);
    expect(body.skills.map((s) => s.name)).toContain("code-review");

    const created = await mounted.request("/api/skills", json({ name: "mounted-skill", description: "装配验证", prompt: "p" }));
    expect(created.status).toBe(201);
    expect(existsSync(join(teamDir, "mounted-skill.md"))).toBe(true);
  });
});
