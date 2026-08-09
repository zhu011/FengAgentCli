/**
 * @fengagent/server — 健康检查路由
 */

import { Hono } from "hono";

/** 创建健康检查路由 */
export function createHealthRoutes(): Hono {
  const app = new Hono();

  // GET / — 服务健康检查
  app.get("/", (c) => {
    return c.json({ status: "ok", timestamp: Date.now() });
  });

  return app;
}
