/**
 * @fengagent/cordis — npm 源解析（市场安装的 P1 地基）
 *
 * 插件市场装的是 npm 包，但**不能**用 `bun add` 到 `<dataRoot>/plugins`（会在插件
 * 根目录生成 `package.json` / `bun.lock` / `node_modules`，`scanIds` 会把它当插件，
 * 卸载 `node_modules` 还能删掉全部插件的依赖）。这里只做三件事：
 *
 * 1. `npm:<name>@<version>` 解析成 registry 的版本对象（拿 `dist.tarball` +
 *    `dist.integrity`）；
 * 2. 流式下载 tarball 到临时文件（大小上限），按 integrity 做哈希校验；
 * 3. 把校验通过的本地 `.tgz` 交回 `PluginManager` 复用既有解包链。
 *
 * 所有网络访问都经 `fetchImpl` 注入，测试不发真请求。
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** 默认 registry（可用 `FENG_NPM_REGISTRY` 覆盖，国内建议镜像） */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** tarball 大小上限（插件包不该是巨型文件） */
export const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024;

/** npm 源解析错误（与 PluginError 解耦，管理器负责翻译） */
export class NpmSourceError extends Error {
  readonly code: "bad_request" | "not_found" | "unsupported" | "integrity";

  constructor(message: string, code: NpmSourceError["code"] = "bad_request") {
    super(message);
    this.name = "NpmSourceError";
    this.code = code;
  }
}

/** registry 版本对象里我们真正需要的字段 */
export interface NpmVersionInfo {
  /** 包名（packument `name`，缺省用请求名） */
  name: string;
  /** 解析出的确切版本 */
  version: string;
  /** tarball 地址 */
  tarball: string;
  /** `sha512-<base64>`（有则校验） */
  integrity?: string;
  /** 旧式 shasum（无 integrity 时的兜底） */
  shasum?: string;
  /** package.json 的 dsh / fengagent 自定义字段（兼容性分类用，不下载包） */
  manifest?: Record<string, unknown>;
}

/** 网络/校验选项 */
export interface NpmSourceOptions {
  /** registry 根地址（默认 `FENG_NPM_REGISTRY` 或 npmjs） */
  registry?: string;
  /** fetch 实现（测试注入） */
  fetchImpl?: typeof fetch;
  /** tarball 大小上限（字节） */
  maxTarballBytes?: number;
  /** 单次请求超时（毫秒，默认 20000） */
  timeoutMs?: number;
}

/** 是否 npm 源（`npm:name@version`；显式前缀避免与本地路径歧义） */
export function isNpmSpec(source: string): boolean {
  return /^npm:/i.test(source.trim());
}

/**
 * 解析 npm spec：`npm:left-pad`、`npm:left-pad@1.3.0`、`npm:@scope/name@1.0.0`。
 *
 * 版本可省略（走 `latest`）；只接受确切版本或 tag —— 语义化区间在这里不做
 * 求解（市场页给的永远是确切版本），传区间会退回 `latest`。
 */
export function parseNpmSpec(spec: string): { name: string; version?: string } {
  const raw = spec.trim().replace(/^npm:/i, "").trim();
  if (!raw) throw new NpmSourceError("npm 源缺少包名（形如 npm:name@version）");
  let name = raw;
  let version: string | undefined;
  const at = raw.indexOf("@", raw.startsWith("@") ? 1 : 0);
  if (at > 0) {
    name = raw.slice(0, at);
    version = raw.slice(at + 1).trim() || undefined;
  }
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new NpmSourceError(`非法 npm 包名: ${name}`);
  }
  return version ? { name, version } : { name };
}

/** registry 根地址（去尾斜杠） */
export function resolveRegistry(options: NpmSourceOptions = {}): string {
  const raw =
    options.registry?.trim() || process.env.FENG_NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY;
  return raw.replace(/\/+$/, "");
}

/** scoped 包名转 registry 路径（`@scope/name` → `@scope%2Fname`） */
function encodeName(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2F") : name;
}

/** 带超时的 fetch（AbortSignal.timeout 不可用时退回无信号） */
async function fetchWithTimeout(
  impl: typeof fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  return impl(url, signal ? { ...init, signal } : init);
}

/** 读 JSON（非 2xx / 非 JSON 都翻译成可读错误） */
async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new NpmSourceError(`${what} 请求失败：HTTP ${response.status}`, response.status === 404 ? "not_found" : "unsupported");
  }
  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("响应不是 JSON 对象");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new NpmSourceError(`${what} 响应解析失败：${error instanceof Error ? error.message : String(error)}`, "unsupported");
  }
}

/** 从版本对象取必要字段（缺 tarball 视为不可安装） */
function toVersionInfo(name: string, version: string, body: Record<string, unknown>): NpmVersionInfo {
  const dist = (body.dist ?? {}) as Record<string, unknown>;
  const tarball = typeof dist.tarball === "string" ? dist.tarball : "";
  if (!tarball) {
    throw new NpmSourceError(`${name}@${version} 缺少 dist.tarball`, "unsupported");
  }
  const info: NpmVersionInfo = { name, version, tarball };
  if (typeof dist.integrity === "string" && dist.integrity) info.integrity = dist.integrity;
  if (typeof dist.shasum === "string" && dist.shasum) info.shasum = dist.shasum;
  const manifest = body.manifest;
  if (manifest && typeof manifest === "object") info.manifest = manifest as Record<string, unknown>;
  return info;
}

/**
 * 解析 npm 版本：确切版本直接打版本端点；缺省/tag 打 packument 取 `dist-tags`。
 *
 * @example resolveNpmVersion("dsh-plugin-focus", "1.1.1")
 */
export async function resolveNpmVersion(
  name: string,
  version?: string,
  options: NpmSourceOptions = {},
): Promise<NpmVersionInfo> {
  const registry = resolveRegistry(options);
  const impl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const encoded = encodeName(name);

  const exact = version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
  if (exact) {
    const url = `${registry}/${encoded}/${encodeURIComponent(version)}`;
    const body = await readJson(await fetchWithTimeout(impl, url, timeoutMs), `npm ${name}@${version}`);
    const resolved = typeof body.version === "string" && body.version ? body.version : version;
    return toVersionInfo(name, resolved, body);
  }

  const packument = await readJson(
    await fetchWithTimeout(impl, `${registry}/${encoded}`, timeoutMs),
    `npm ${name}`,
  );
  const distTags = (packument["dist-tags"] ?? {}) as Record<string, unknown>;
  const wanted =
    version && version !== "latest"
      ? version
      : typeof distTags.latest === "string"
        ? distTags.latest
        : "";
  if (!wanted) {
    throw new NpmSourceError(`${name} 没有 latest 版本标签`, "not_found");
  }
  const versions = (packument.versions ?? {}) as Record<string, unknown>;
  const body = versions[wanted];
  if (!body || typeof body !== "object") {
    throw new NpmSourceError(`${name} 不存在版本 ${wanted}`, "not_found");
  }
  return toVersionInfo(name, wanted, body as Record<string, unknown>);
}

/** packument 摘要（市场详情页用，不做区间求解） */
export interface NpmPackument {
  name: string;
  /** `dist-tags`（latest 等） */
  distTags: Record<string, string>;
  /** 全部版本（新→旧，按字符串排序，够详情页展示） */
  versions: string[];
  /** latest 版本的 package.json（兼容性分类用） */
  latestManifest?: Record<string, unknown>;
}

/**
 * 拉取 packument（整包元数据）：详情页要列版本、判兼容档。
 *
 * 只在 `GET /api/plugins/market/:name` 用；catalog 列表不碰 packument（4200 条
 * 逐条拉会打爆 registry）。
 */
export async function fetchNpmPackument(
  name: string,
  options: NpmSourceOptions = {},
): Promise<NpmPackument> {
  const registry = resolveRegistry(options);
  const impl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const body = await readJson(
    await fetchWithTimeout(impl, `${registry}/${encodeName(name)}`, timeoutMs),
    `npm ${name}`,
  );
  const distTagsRaw = (body["dist-tags"] ?? {}) as Record<string, unknown>;
  const distTags: Record<string, string> = {};
  for (const [tag, value] of Object.entries(distTagsRaw)) {
    if (typeof value === "string" && value) distTags[tag] = value;
  }
  const versionsRaw = (body.versions ?? {}) as Record<string, unknown>;
  const versions = Object.keys(versionsRaw).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const latest = distTags.latest;
  const latestBody = latest ? versionsRaw[latest] : undefined;
  const manifest =
    latestBody && typeof latestBody === "object" ? (latestBody as Record<string, unknown>) : undefined;
  return {
    name: typeof body.name === "string" && body.name ? body.name : name,
    distTags,
    versions,
    ...(manifest ? { latestManifest: manifest } : {}),
  };
}

/** integrity 串支持 sha512/sha256/sha1（base64）；`sha512-<b64>` 形式 */
export function verifyIntegrity(buffer: Buffer, integrity: string): boolean {
  const match = /^(sha512|sha256|sha1)-(.+)$/.exec(integrity.trim());
  if (!match) return false;
  const algorithm = match[1] as "sha512" | "sha256" | "sha1";
  const expected = match[2] as string;
  const actual = createHash(algorithm).update(buffer).digest("base64");
  return actual === expected;
}

/** 下载 + 校验结果 */
export interface DownloadedTarball {
  /** 本地临时文件绝对路径 */
  path: string;
  /** 实际字节数 */
  size: number;
  /** 校验通过的 integrity（无则回退 `sha1:<shasum>`） */
  integrity: string;
}

/**
 * 下载 tarball 到 `destDir`，按 `dist.integrity` 校验。
 *
 * 上限按 `content-length` 先拦一次，落地后再按真实字节数兜一次；不匹配即抛错，
 * 调用方负责删临时目录。
 */
export async function downloadTarball(
  info: NpmVersionInfo,
  destDir: string,
  options: NpmSourceOptions = {},
): Promise<DownloadedTarball> {
  const impl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;

  const response = await fetchWithTimeout(impl, info.tarball, timeoutMs);
  if (!response.ok) {
    throw new NpmSourceError(`tarball 下载失败：HTTP ${response.status}`, "unsupported");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NpmSourceError(`tarball 过大（${declared} > ${maxBytes} 字节）`, "unsupported");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new NpmSourceError(`tarball 过大（${buffer.byteLength} > ${maxBytes} 字节）`, "unsupported");
  }

  let integrity = "";
  if (info.integrity) {
    if (!verifyIntegrity(buffer, info.integrity)) {
      throw new NpmSourceError(`integrity 校验失败（${info.name}@${info.version}）`, "integrity");
    }
    integrity = info.integrity;
  } else if (info.shasum) {
    const actual = createHash("sha1").update(buffer).digest("hex");
    if (actual !== info.shasum) {
      throw new NpmSourceError(`shasum 校验失败（${info.name}@${info.version}）`, "integrity");
    }
    integrity = `sha1-${info.shasum}`;
  }

  const fileName = `${info.name.replace(/[@/]/g, "_")}-${info.version}.tgz`;
  const path = join(destDir, fileName);
  writeFileSync(path, buffer);
  return { path, size: buffer.byteLength, integrity };
}
