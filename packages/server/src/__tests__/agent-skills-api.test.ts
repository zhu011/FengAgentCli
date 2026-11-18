/**
 * `/api/agents/:id/skills` 挂载层（P1）+ 上下文装配测试。
 *
 * 覆盖：增量添加 / 全量替换 / 启停 / 覆盖 trigger / 卸载只删关系 /
 * `config.skills` 双写 / 未挂载与不存在 skill 的错误体 / buildAgentContext 注入。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry,
  RunIndex,
  SkillMountStore,
  buildAgentContext,
  renderDispatchPrompt,
} from "@fengagent/agent";
import { createAgentRoutes } from "../routes/agents.ts";
import { SkillService } from "../skill-service.ts";

let root: string;
let workdir: string;
let teamDir: string;
let registry: AgentRegistry;
let runIndex: RunIndex;
let mounts: SkillMountStore;
let service: SkillService;
let app: ReturnType<typeof createAgentRoutes>;

function json(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-agent-skills-"));
  workdir = join(root, "workdir");
  teamDir = join(root, "team", "skills");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(
    join(teamDir, "code-review.md"),
    "---\nname: code-review\ndescription: 代码审查\ntrigger: 需要审查时\n---\n\n审查正文\n",
    "utf-8",
  );
  registry = new AgentRegistry({ dataRoot: root, workdir });
  runIndex = new RunIndex({ dataRoot: root });
  mounts = new SkillMountStore(join(root, "sessions.db"));
  service = new SkillService({ workdir, teamDir, env: {}, mounts });
  app = createAgentRoutes({
    registry,
    runIndex,
    listRuntimes: () => [],
    skillMounts: mounts,
    skillCatalog: service,
  });
  registry.create({ id: "coder", displayName: "代码工程师" });
  registry.create({ id: "reviewer", displayName: "评审员" });
});

afterEach(() => {
  mounts.close();
  runIndex.close();
  rmSync(root, { recursive: true, force: true });
});

describe("/api/agents/:id/skills", () => {
  test("增量添加 → 列表 → config.skills 双写", async () => {
    const added = await app.request("/coder/skills", json({ name: "code-review" }));
    expect(added.status).toBe(201);
    // 前端契约（KG）：返回裸数组，shadowed 是布尔
    const body = (await added.json()) as Array<{
      name: string;
      enabled: boolean;
      source: string;
      shadowed: boolean;
    }>;
    expect(body.map((item) => item.name)).toEqual(["code-review"]);
    expect(body[0]?.enabled).toBe(true);
    expect(body[0]?.source).toBe("team");
    expect(body[0]?.shadowed).toBe(false);

    // 再点一次「添加」：不重复、不改启停
    mounts.patch("coder", "code-review", { enabled: false });
    const again = await app.request("/coder/skills", json({ name: "code-review" }));
    expect(again.status).toBe(200);
    expect(mounts.get("coder", "code-review")?.enabled).toBe(false);

    // P0 详情页仍读 config.skills
    expect(registry.get("coder")?.config.skills).toEqual(["code-review"]);
  });

  test("全量替换：多删少增，保留已挂载项的启停", async () => {
    mounts.add({ agentId: "coder", skillName: "code-review", source: "team" });
    mounts.patch("coder", "code-review", { enabled: false });

    const replaced = await app.request("/coder/skills", json({ names: ["code-review"] }, "PUT"));
    expect(replaced.status).toBe(200);
    expect(mounts.get("coder", "code-review")?.enabled).toBe(false);

    const empty = await app.request("/coder/skills", json({ names: [] }, "PUT"));
    expect(empty.status).toBe(200);
    expect(mounts.listForAgent("coder")).toHaveLength(0);
    expect(registry.get("coder")?.config.skills).toEqual([]);
  });

  test("启停 + 覆盖 trigger + 清除 trigger", async () => {
    mounts.add({ agentId: "coder", skillName: "code-review", source: "team" });

    const patched = await app.request(
      "/coder/skills/code-review",
      json({ enabled: false, trigger: "只在 PR 时" }, "PATCH"),
    );
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as Array<{
      name: string;
      enabled: boolean;
      trigger?: string;
    }>;
    expect(body[0]?.enabled).toBe(false);
    expect(body[0]?.trigger).toBe("只在 PR 时");

    const cleared = await app.request(
      "/coder/skills/code-review",
      json({ trigger: null }, "PATCH"),
    );
    expect(cleared.status).toBe(200);
    // 清掉覆盖后回落到 skill 自身的 trigger
    expect(((await cleared.json()) as Array<{ trigger?: string }>)[0]?.trigger).toBe(
      "需要审查时",
    );
  });

  test("卸载只删关系：skill 内容仍在技能库，另一个 agent 还能用", async () => {
    mounts.add({ agentId: "coder", skillName: "code-review", source: "team" });
    mounts.add({ agentId: "reviewer", skillName: "code-review", source: "team" });

    const removed = await app.request("/coder/skills/code-review", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(mounts.get("coder", "code-review")).toBeUndefined();
    expect(mounts.get("reviewer", "code-review")?.enabled).toBe(true);
    // 内容层没被删
    expect(existsSync(join(teamDir, "code-review.md"))).toBe(true);
    expect(service.detail("code-review").name).toBe("code-review");
    expect(registry.get("coder")?.config.skills).toEqual([]);
  });

  test("错误体：agent 不存在 404 / skill 不存在 404 / 未挂载 404", async () => {
    const noAgent = await app.request("/nope/skills", json({ name: "code-review" }));
    expect(noAgent.status).toBe(404);

    const noSkill = await app.request("/coder/skills", json({ name: "missing-skill" }));
    expect(noSkill.status).toBe(404);
    expect(((await noSkill.json()) as { error: { code: string } }).error.code).toBe("skill_not_found");

    const notMounted = await app.request("/coder/skills/code-review", { method: "DELETE" });
    expect(notMounted.status).toBe(404);
  });

  test("PUT 里带不存在的 skill → 404，不产生半套挂载", async () => {
    mounts.add({ agentId: "coder", skillName: "code-review", source: "team" });
    const res = await app.request(
      "/coder/skills",
      json({ names: ["code-review", "missing-skill"] }, "PUT"),
    );
    expect(res.status).toBe(404);
    expect(mounts.listForAgent("coder").map((mount) => mount.skillName)).toEqual(["code-review"]);
  });
});

describe("buildAgentContext", () => {
  const agent = { id: "coder", displayName: "代码工程师", instructions: "你是代码工程师。" };
  const resolved: Record<
    string,
    { name: string; description: string; trigger: string; prompt: string; source: string }
  > = {
    "code-review": {
      name: "code-review",
      description: "代码审查",
      trigger: "需要审查时",
      prompt: "审查正文",
      source: "team",
    },
  };

  test("只注入 enabled 的挂载；缺失的记 missing 不阻断", () => {
    const context = buildAgentContext({
      agent,
      mounts: [
        { agentId: "coder", skillName: "code-review", source: "team", enabled: true, createdAt: 0, updatedAt: 0 },
        { agentId: "coder", skillName: "gone", source: "team", enabled: true, createdAt: 0, updatedAt: 0 },
        { agentId: "coder", skillName: "code-review", source: "team", enabled: false, createdAt: 0, updatedAt: 0 },
      ],
      resolveSkill: (name) => resolved[name] ?? null,
    });
    expect(context.skills.map((skill) => skill.name)).toEqual(["code-review"]);
    expect(context.missing).toEqual(["gone"]);
    expect(context.prompt).toContain("你是代码工程师。");
    expect(context.prompt).toContain("## 技能");
    expect(context.prompt).toContain("### code-review");
    expect(context.prompt).toContain("触发条件：需要审查时");
    expect(context.prompt).toContain("审查正文");
  });

  test("无挂载时 prompt 就是 instructions（零回归）", () => {
    const context = buildAgentContext({ agent, mounts: [], resolveSkill: () => null });
    expect(context.prompt).toBe("你是代码工程师。");
    expect(context.skillSection).toBe("");
  });

  test("renderDispatchPrompt：任务正文在最后；无 instructions 时原样返回", () => {
    const context = buildAgentContext({
      agent,
      mounts: [
        { agentId: "coder", skillName: "code-review", source: "team", enabled: true, createdAt: 0, updatedAt: 0 },
      ],
      resolveSkill: (name) => resolved[name] ?? null,
    });
    const prompt = renderDispatchPrompt(context, "  修复登录 bug  ");
    expect(prompt).toContain("你是代码工程师。");
    expect(prompt.endsWith("## 本次任务\n修复登录 bug")).toBe(true);

    // 空 instructions + 无挂载 = 只发任务正文（直接按 runtime 派单的老行为）
    const empty = buildAgentContext({
      agent: { id: "x", displayName: "x", instructions: "" },
      mounts: [],
      resolveSkill: () => null,
    });
    expect(renderDispatchPrompt(empty, "直接干")).toBe("直接干");
  });

  test("技能段超过上限时截断（不让单条 skill 撑爆 prompt）", () => {
    const context = buildAgentContext({
      agent,
      mounts: [
        { agentId: "coder", skillName: "code-review", source: "team", enabled: true, createdAt: 0, updatedAt: 0 },
      ],
      resolveSkill: () => ({
        name: "code-review",
        description: "d",
        trigger: "",
        prompt: "x".repeat(1024),
        source: "team",
      }),
      maxSkillBytes: 64,
    });
    expect(context.skills).toHaveLength(1);
    expect(context.prompt).not.toContain("x".repeat(1024));
  });
});
