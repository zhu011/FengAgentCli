/**
 * @fengagent/server — `/api/skills` 路由（团队级技能库 P0）
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/skills?merge=1` | 三层合并视图（内置 → 团队 → 本目录）+ 逐层明细 + 解析错误 |
 * | GET | `/api/skills` | 只回团队层（写侧视角） |
 * | GET | `/api/skills/:name` | 详情（含 prompt 正文） |
 * | POST | `/api/skills` | 新建团队技能（重名 409） |
 * | PATCH | `/api/skills/:name` | 改 `description/trigger/prompt/enabled`（名称锁定；内置技能=建团队级覆盖） |
 * | PUT | `/api/skills/:name` | 同 PATCH（全量语义，前端二选一） |
 * | DELETE | `/api/skills/:name` | 删除团队技能；内置/本目录 409（提示用 reset） |
 * | POST | `/api/skills/:name/reset` | 恢复默认（移除团队覆盖 + 解除停用） |
 *
 * 错误统一 `{ error: { message, code } }`，code ∈ bad_request / not_found / conflict /
 * not_editable / internal（与 runtimes、mcp-groups 契约一致）。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import {
  SkillService,
  SkillServiceError,
  type SkillCreateInput,
  type SkillImportInput,
  type SkillServiceOptions,
  type SkillUpdateInput,
} from "../skill-service.ts";

/** 错误码 → HTTP 状态 */
const STATUS_BY_CODE: Record<string, 400 | 404 | 409 | 500> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  not_editable: 409,
  internal: 500,
};

/** 统一错误响应 */
function fail(c: Context, err: unknown): Response {
  if (err instanceof SkillServiceError) {
    return c.json({ error: { message: err.message, code: err.code } }, STATUS_BY_CODE[err.code] ?? 500);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: { message, code: "internal" } }, 500);
}

/** 从请求体里挑出技能字段（忽略未知字段，类型不对交给 service 校验兜底） */
function readBody(body: Record<string, unknown>): SkillCreateInput & SkillUpdateInput {
  const pick = (key: string): string | undefined =>
    typeof body[key] === "string" ? (body[key] as string) : undefined;
  const enabled = typeof body["enabled"] === "boolean" ? (body["enabled"] as boolean) : undefined;
  return {
    name: pick("name") ?? "",
    description: pick("description") ?? "",
    trigger: pick("trigger"),
    prompt: pick("prompt") ?? "",
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

/**
 * 技能库路由。
 *
 * @param options - workdir / 团队目录 / env（测试注入），或直接传一个 SkillService
 */
export function createSkillRoutes(options: SkillServiceOptions | SkillService): Hono {
  const service = options instanceof SkillService ? options : new SkillService(options);
  const app = new Hono();

  app.get("/", (c) => {
    const merge = c.req.query("merge");
    const merged = merge === "1" || merge === "true";
    c.header("Cache-Control", "no-cache");
    return c.json(service.list({ merge: merged }));
  });

  app.get("/:name", (c) => {
    c.header("Cache-Control", "no-cache");
    try {
      return c.json(service.detail(c.req.param("name")));
    } catch (err) {
      return fail(c, err);
    }
  });

  // POST /import — 四路导入（manual / local / url / runtime_copy）
  // 必须显式分辨 type：前端「导入」入口一个，按来源带不同字段。
  app.post("/import", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: { message: "请求体不是合法 JSON", code: "bad_request" } }, 400);
    }
    const type = body["type"];
    if (type !== "manual" && type !== "local" && type !== "url" && type !== "runtime_copy") {
      return c.json(
        {
          error: {
            message: "type 必须是 manual / local / url / runtime_copy",
            code: "bad_request",
          },
        },
        400,
      );
    }
    const pick = (key: string): string | undefined =>
      typeof body[key] === "string" ? (body[key] as string) : undefined;
    const input: SkillImportInput = {
      type,
      ...(pick("name") === undefined ? {} : { name: pick("name") }),
      ...(pick("description") === undefined ? {} : { description: pick("description") }),
      ...(pick("trigger") === undefined ? {} : { trigger: pick("trigger") }),
      ...(pick("prompt") === undefined ? {} : { prompt: pick("prompt") }),
      ...(pick("path") === undefined ? {} : { path: pick("path") }),
      ...(pick("url") === undefined ? {} : { url: pick("url") }),
      ...(pick("runtime") === undefined ? {} : { runtime: pick("runtime") }),
      ...(pick("skillName") === undefined ? {} : { skillName: pick("skillName") }),
      ...(pick("onConflict") === undefined
        ? {}
        : { onConflict: pick("onConflict") as SkillImportInput["onConflict"] }),
    };
    try {
      const result = await service.importSkill(input);
      return c.json(result, result.skipped ? 200 : 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  // GET /:name/revisions — 版本快照列表（append-only）
  app.get("/:name/revisions", (c) => {
    c.header("Cache-Control", "no-cache");
    try {
      return c.json({ name: c.req.param("name"), revisions: service.revisions(c.req.param("name")) });
    } catch (err) {
      return fail(c, err);
    }
  });

  // POST /:name/restore — 回滚到指定版本
  app.post("/:name/restore", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: { message: "请求体不是合法 JSON", code: "bad_request" } }, 400);
    }
    const version = typeof body["version"] === "number" ? body["version"] : Number(body["version"]);
    if (!Number.isInteger(version)) {
      return c.json({ error: { message: "version 必须是整数", code: "bad_request" } }, 400);
    }
    try {
      return c.json(service.restore(c.req.param("name"), version));
    } catch (err) {
      return fail(c, err);
    }
  });

  // GET /:name/usage — 被哪些智能体使用
  app.get("/:name/usage", (c) => {
    c.header("Cache-Control", "no-cache");
    try {
      return c.json(service.usage(c.req.param("name")));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: { message: "请求体不是合法 JSON", code: "bad_request" } }, 400);
    }
    try {
      const input = readBody(body);
      return c.json(service.create(input), 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  const update = async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: { message: "请求体不是合法 JSON", code: "bad_request" } }, 400);
    }
    const patch: SkillUpdateInput = {};
    if (typeof body["description"] === "string") patch.description = body["description"];
    if (typeof body["trigger"] === "string") patch.trigger = body["trigger"];
    if (typeof body["prompt"] === "string") patch.prompt = body["prompt"];
    if (typeof body["enabled"] === "boolean") patch.enabled = body["enabled"];
    const name = c.req.param("name") ?? "";
    // 名称锁定：显式改 name 一律拒绝（内置技能靠「同名覆盖」而不是改名）
    if (typeof body["name"] === "string" && body["name"] !== name) {
      return c.json({ error: { message: "技能名称不可修改（编辑内置技能=创建同名团队覆盖）", code: "bad_request" } }, 400);
    }
    try {
      return c.json(service.update(name, patch));
    } catch (err) {
      return fail(c, err);
    }
  };

  app.patch("/:name", update);
  app.put("/:name", update);

  app.delete("/:name", (c) => {
    try {
      service.remove(c.req.param("name"));
      return c.json({ ok: true, name: c.req.param("name") });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:name/reset", (c) => {
    try {
      return c.json(service.reset(c.req.param("name")));
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
