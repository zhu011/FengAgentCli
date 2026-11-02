/**
 * @fengagent/server — 插件管理面路由（S2）
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/plugins` | 插件列表（含启用状态 / 是否带 UI / 重启提示） |
 * | POST | `/api/plugins/install` | 安装插件：JSON `{source}`（本地目录/`.tgz` 路径）或 multipart 上传包 |
 * | POST | `/api/plugins/:id/enable` | 启用 |
 * | POST | `/api/plugins/:id/disable` | 停用 |
 * | DELETE | `/api/plugins/:id` | 卸载 |
 *
 * 错误体沿用群路由的契约：`{ error: { message, code } }`，
 * `code ∈ bad_request | not_found | conflict | unsupported | internal`。
 *
 * 安全边界：只接受本地源（远程 URL 由 manager 拒绝）与上传的本地包，插件 id
 * 只允许单段目录名，所有落盘路径都在 `<dataRoot>/plugins` 之内。
 */

import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  PluginErrorCode,
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
  PluginRemoveResult,
} from "../../../cordis/src/plugin-manager.ts";
import { PluginError } from "../../../cordis/src/plugin-manager.ts";

/** 上传包大小上限（插件包不该是巨型文件，避免把数据根/临时目录写满） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 路由依赖的最小管理面（cordis `ctx.plugins` 结构兼容） */
export interface PluginRouteSource {
  list(): PluginListResult;
  install(request: PluginInstallRequest): Promise<PluginMutationResult>;
  setEnabled(id: string, enabled: boolean): PluginMutationResult;
  remove(id: string): PluginRemoveResult;
}

/** HTTP 错误码（多一个 internal） */
type ErrorCode = PluginErrorCode | "internal";

/** 错误码 → 状态码 */
const STATUS_BY_CODE: Record<ErrorCode, 400 | 404 | 409 | 500> = {
  bad_request: 400,
  unsupported: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

/** 统一错误响应 */
function fail(c: { json: (body: unknown, status: 400 | 404 | 409 | 500) => Response }, error: unknown): Response {
  if (error instanceof PluginError) {
    return c.json({ error: { message: error.message, code: error.code } }, STATUS_BY_CODE[error.code]);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: { message, code: "internal" } }, STATUS_BY_CODE.internal);
}

/** 解析安装请求体（非法 JSON / 非对象 → null） */
async function readInstallRequest(request: { json: () => Promise<unknown> }): Promise<PluginInstallRequest | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  return body as PluginInstallRequest;
}

/**
 * 把 multipart 上传的包落到临时目录，得到一个本地 `source` 路径。
 *
 * 只接受 `.tgz`/`.tar.gz`（与本地路径安装同一条链路），文件名取 basename，
 * 包体写入系统临时目录；安装结束由调用方清理。
 */
async function stageUpload(
  body: Record<string, unknown>,
): Promise<{ request: PluginInstallRequest; cleanup: () => void }> {
  const file = body.file;
  if (!(file instanceof File)) {
    throw new PluginError("缺少 file 字段（multipart 上传 .tgz/.tar.gz）");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PluginError(`上传包过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB）`);
  }
  const filename = basename(file.name || "plugin.tgz");
  if (!/\.(tgz|tar\.gz)$/i.test(filename)) {
    throw new PluginError("上传文件必须是 .tgz/.tar.gz", "unsupported");
  }

  const dir = mkdtempSync(join(tmpdir(), "feng-plugin-upload-"));
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响安装结果
    }
  };
  try {
    const target = join(dir, filename);
    writeFileSync(target, Buffer.from(await file.arrayBuffer()));
    const idRaw = body.id;
    const id = typeof idRaw === "string" && idRaw.trim() ? idRaw.trim() : undefined;
    const enableRaw = body.enable;
    const enable = typeof enableRaw === "string" ? !(enableRaw === "false" || enableRaw === "0") : undefined;
    return {
      request: {
        source: target,
        // 临时上传路径装完即删，状态里记一个人能看懂的来源标签
        sourceLabel: `upload:${filename}`,
        ...(id ? { id } : {}),
        ...(enable === undefined ? {} : { enable }),
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** 创建插件管理面路由 */
export function createPluginRoutes(source: PluginRouteSource): Hono {
  const app = new Hono();

  // GET / — 插件列表（不缓存：装/卸/启停后前端必须看到新状态）
  app.get("/", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json(source.list());
  });

  // POST /install — 安装插件：JSON 本地路径，或 multipart 上传 .tgz
  app.post("/install", async (c) => {
    let request: PluginInstallRequest | null = null;
    let cleanup: (() => void) | undefined;

    if ((c.req.header("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
      try {
        const staged = await stageUpload((await c.req.parseBody()) as Record<string, unknown>);
        request = staged.request;
        cleanup = staged.cleanup;
      } catch (error) {
        return fail(c, error);
      }
    } else {
      request = await readInstallRequest(c.req);
      if (!request) {
        return fail(c, new PluginError('请求体必须是 JSON 对象（如 {"source": "/path/to/plugin"}）或 multipart 上传包'));
      }
    }

    try {
      const result = await source.install(request);
      return c.json(result, 201);
    } catch (error) {
      return fail(c, error);
    } finally {
      cleanup?.();
    }
  });

  // POST /:id/enable | /:id/disable — 启停
  app.post("/:id/enable", (c) => {
    try {
      return c.json(source.setEnabled(c.req.param("id"), true));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/:id/disable", (c) => {
    try {
      return c.json(source.setEnabled(c.req.param("id"), false));
    } catch (error) {
      return fail(c, error);
    }
  });

  // DELETE /:id — 卸载
  app.delete("/:id", (c) => {
    try {
      return c.json(source.remove(c.req.param("id")));
    } catch (error) {
      return fail(c, error);
    }
  });

  return app;
}
