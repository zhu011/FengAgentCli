/**
 * @fengagent/server — 插件管理面 + 市场目录路由（S2 / A / B）
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/plugins` | 插件列表（含启用状态 / 是否带 UI / 重启提示） |
 * | GET | `/api/plugins/market` | 市场目录：`?q=&category=&limit=&offset=`（服务端搜索分页） |
 * | GET | `/api/plugins/market/:name` | 市场插件详情：版本列表 + 兼容档 |
 * | POST | `/api/plugins/install` | 本地源 `{source}` / 市场源 `{marketName, marketVersion}` / multipart 上传 |
 * | POST | `/api/plugins/:id/enable` | 启用 |
 * | POST | `/api/plugins/:id/disable` | 停用 |
 * | DELETE | `/api/plugins/:id` | 卸载 |
 *
 * 错误体沿用群路由的契约：`{ error: { message, code } }`，
 * `code ∈ bad_request | not_found | conflict | unsupported | internal`。
 *
 * 安全边界：本地源只接受目录 / `.tgz` 与上传包（远程 URL 由 manager 拒绝）；
 * 市场安装只接受 `marketName`/`marketVersion`，先过 catalog 策展校验，不开放
 * 任意 npm spec。插件 id 只允许单段目录名，所有落盘路径都在 `<dataRoot>/plugins` 之内。
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
import type {
  MarketCatalogQuery,
  MarketCatalogResult,
  MarketDetail,
  MarketPluginEntry,
} from "../../../cordis/src/market.ts";

/** 上传包大小上限（插件包不该是巨型文件，避免把数据根/临时目录写满） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 市场列表默认/上限条数（前端不传 limit 时按页取，绝不整发 catalog） */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

/** 路由依赖的最小管理面（cordis `ctx.plugins` 结构兼容） */
export interface PluginRouteSource {
  list(): PluginListResult;
  install(request: PluginInstallRequest): Promise<PluginMutationResult>;
  setEnabled(id: string, enabled: boolean): PluginMutationResult;
  remove(id: string): PluginRemoveResult;
}

/**
 * 市场目录面（B）：列表 + 详情 + 安装闸门。
 *
 * `assertInstallable` 是市场安装的安全面：只有 catalog 策展清单里、非 C 档的
 * 插件能被装 —— 否则 `/install` 等于「任意 npm 包执行器」。
 */
export interface MarketRouteSource {
  catalog(query?: MarketCatalogQuery): Promise<MarketCatalogResult>;
  detail(name: string): Promise<MarketDetail>;
  assertInstallable(name: string, version?: string): Promise<unknown>;
  /** 可选：列表分档回填（catalog 无协议字段时按 registry 确认）；未实现则用 catalog hint */
  enrich?(entries: MarketPluginEntry[]): Promise<MarketPluginEntry[]>;
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
  const record = body as Record<string, unknown>;
  // 市场源同时接受 `{ market: { name, version } }` 嵌套形与扁平
  // `{ marketName, marketVersion }`（扁平为规范形，嵌套为兼容别名）
  const market = record.market;
  if (market === undefined) return record as PluginInstallRequest;
  if (!market || typeof market !== "object" || Array.isArray(market)) return null;
  const nested = market as Record<string, unknown>;
  const name = typeof nested.name === "string" ? nested.name.trim() : "";
  if (!name) return null;
  const version = typeof nested.version === "string" && nested.version.trim() ? nested.version.trim() : undefined;
  return { marketName: name, ...(version ? { marketVersion: version } : {}) };
}

/** 解析非负整数查询参数（缺省/非法 → undefined） */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
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
export function createPluginRoutes(source: PluginRouteSource, market?: MarketRouteSource): Hono {
  const app = new Hono();

  // GET / — 插件列表（不缓存：装/卸/启停后前端必须看到新状态）
  app.get("/", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json(source.list());
  });

  // GET /market — 市场目录（q/category/limit/offset 全在服务端过滤分页）
  app.get("/market", async (c) => {
    c.header("Cache-Control", "no-cache");
    if (!market) {
      return fail(c, new PluginError("市场目录未启用（服务端 MarketCatalog 未装配）", "unsupported"));
    }
    const query: MarketCatalogQuery = {};
    const q = c.req.query("q")?.trim();
    if (q) query.q = q;
    const category = c.req.query("category")?.trim();
    if (category) query.category = category;
    const limit = positiveInt(c.req.query("limit"));
    query.limit = limit && limit > 0 ? Math.min(MAX_LIMIT, limit) : DEFAULT_LIMIT;
    const offset = positiveInt(c.req.query("offset"));
    query.offset = offset ?? 0;
    try {
      const result: MarketCatalogResult = await market.catalog(query);
      // 列表分档回填：catalog 条目没有协议字段，按 registry /latest 确认（可选能力）
      const plugins = market.enrich ? await market.enrich(result.plugins) : result.plugins;
      return c.json({ ...result, plugins });
    } catch (error) {
      return fail(c, error);
    }
  });

  // GET /market/:name — 详情（scoped 包名带 `/`，用通配参数）；registry 抽风时仍回 catalog 信息
  app.get("/market/:name{.+}", async (c) => {
    c.header("Cache-Control", "no-cache");
    if (!market) {
      return fail(c, new PluginError("市场目录未启用（服务端 MarketCatalog 未装配）", "unsupported"));
    }
    const name = decodeURIComponent(c.req.param("name"));
    try {
      return c.json(await market.detail(name));
    } catch (error) {
      return fail(c, error);
    }
  });

  // POST /install — 本地路径 / multipart 上传 / 市场源（marketName + marketVersion）
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
        return fail(
          c,
          new PluginError(
            '请求体必须是 JSON 对象（如 {"source": "/path/to/plugin"}、{"marketName": "dsh-better-edit"} 或 {"market": {"name": "dsh-better-edit", "version": "1.2.0"}}）或 multipart 上传包',
          ),
        );
      }
    }

    try {
      // B：市场安装先过 catalog 策展校验（名称存在、非 C 档、版本确切）
      const marketName = request.marketName?.trim();
      if (marketName) {
        if (!market) {
          return fail(c, new PluginError("市场目录未启用（服务端 MarketCatalog 未装配）", "unsupported"));
        }
        try {
          await market.assertInstallable(marketName, request.marketVersion?.trim());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code: PluginErrorCode = /没有插件|not found/i.test(message) ? "not_found" : "unsupported";
          return fail(c, new PluginError(message, code));
        }
      }
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
