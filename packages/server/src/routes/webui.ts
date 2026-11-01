/**
 * @fengagent/server — WebUI 插件路由（S1）
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/webui/manifest` | 已装插件的 webui 声明（id/版本/入口/slots） |
 * | GET | `/api/webui/assets/:pluginId/:file{.+}` | 插件目录内的静态资源 |
 *
 * 安全边界：
 * - 只服务插件目录内、且 package.json 声明了 `fengagent.webui` 的插件；
 * - 路径穿越（`..`、绝对路径、盘符、NUL）一律 404；
 * - 不做目录列表，只返回真实存在的普通文件。
 */

import { Hono } from "hono";
import { readFileSync } from "node:fs";
import type { WebuiAsset, WebuiManifest } from "../../../cordis/src/webui.ts";

/** 路由依赖的最小注册表面（cordis `ctx.webui` 结构兼容） */
export interface WebuiRouteSource {
  manifest(): WebuiManifest;
  resolveAsset(pluginId: string, relativePath: string): WebuiAsset | null;
}

/** 创建 WebUI 插件路由 */
export function createWebuiRoutes(source: WebuiRouteSource): Hono {
  const app = new Hono();

  // GET /manifest — 宿主 WebUI 免重启拉取插件清单
  app.get("/manifest", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json(source.manifest());
  });

  // GET /assets/:pluginId/:file — 插件静态资源（白名单 + 防目录穿越）
  app.get("/assets/:pluginId/:file{.+}", (c) => {
    const pluginId = c.req.param("pluginId");
    const relativePath = c.req.param("file");
    const asset = source.resolveAsset(pluginId, relativePath);
    if (!asset) {
      return c.json({ error: "asset not found" }, 404);
    }

    let body: Uint8Array;
    try {
      body = new Uint8Array(readFileSync(asset.path));
    } catch {
      return c.json({ error: "asset not readable" }, 404);
    }

    return new Response(body.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(body.byteLength),
        // 插件装/卸即时生效：禁止中间层缓存（S1 不做内容哈希）
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return app;
}
