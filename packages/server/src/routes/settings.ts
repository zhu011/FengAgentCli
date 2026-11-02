/**
 * @fengagent/server — WebUI Settings 面（S3：模型 / Provider）
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/settings/model` | 当前生效的模型设置 + 每个键的来源 + 环境变量锁定项 |
 * | PATCH | `/api/settings/model` | 校验 → 落盘 `settings.json` → 热切换运行中的 client |
 * | GET | `/api/settings/providers` | Provider 目录 + 实时配置状态（Key 打码） |
 *
 * 错误体与插件 / 群路由同契约：`{ error: { message, code } }`，
 * `code ∈ bad_request | internal`。所有响应 `Cache-Control: no-cache`。
 */

import { Hono } from "hono";
import {
  ModelSettingsError,
  type ModelSettingsService,
} from "../model-settings.ts";

/** 路由只依赖设置服务的这三个方法（测试可注入内存实现） */
export type SettingsRouteSource = Pick<
  ModelSettingsService,
  "get" | "patch" | "providers"
>;

/** 统一错误响应 */
function fail(
  c: { json: (body: unknown, status: 400 | 500) => Response },
  error: unknown,
): Response {
  if (error instanceof ModelSettingsError) {
    return c.json(
      { error: { message: error.message, code: error.code } },
      error.code === "bad_request" ? 400 : 500,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: { message, code: "internal" } }, 500);
}

/**
 * 创建设置路由。
 *
 * @param source - 模型设置服务（缺省不挂载由 `server.ts` 决定）
 * @returns Hono 应用
 */
export function createSettingsRoutes(source: SettingsRouteSource): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });

  // GET /model — 生效值 + 来源 + 环境变量锁定项
  app.get("/model", (c) => {
    try {
      return c.json(source.get());
    } catch (err) {
      return fail(c, err);
    }
  });

  // PATCH /model — 持久化 + 热切换
  app.patch("/model", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { message: "请求体必须是 JSON", code: "bad_request" } },
        400,
      );
    }
    try {
      return c.json(await source.patch(body));
    } catch (err) {
      return fail(c, err);
    }
  });

  // GET /providers — Provider 目录 + 实时状态
  app.get("/providers", (c) => {
    try {
      return c.json(source.providers());
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
