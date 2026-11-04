/**
 * @fengagent/cordis — 插件市场目录（A）
 *
 * 市场页不能直接吃源站的整包：实测 `index.json` 3.5 MB、`plugins.json` 11.1 MB，
 * 整包发给浏览器不可行。所以这里做四件事：
 *
 * 1. **服务端抓取**：`FENG_MARKET_CATALOG_URL` → jsDelivr 的 format-1 索引 → 源站；
 * 2. **缓存**：进程内存 + `<dataRoot>/cache/market-catalog.json`，TTL 1 小时，
 *    抓取失败回退 stale 并标 `stale: true`（不把「网断了」显示成「没有插件」）；
 * 3. **裁剪 + 分页**：只投影市场页需要的字段，搜索/分类/翻页都在服务端做
 *    （`GET /api/plugins/market?q=&category=&limit=&offset=`）；
 * 4. **兼容分类**：用包元数据（不用下 tarball）分 A/B/C 三档 ——
 *    A = 声明 `fengagent.webui`（即装即渲染）；B = dsh host 侧（试装 + 重启）；
 *    C = `dsh.client`（本期不渲染，标灰当对照组）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fetchNpmLatestManifest, fetchNpmPackument, type NpmPackument } from "./npm-source.ts";

/** 兼容档位 */
export type MarketCompat = "A" | "B" | "C";

/** 市场条目（裁剪后的公开字段） */
export interface MarketPluginEntry {
  /** npm 包名 */
  name: string;
  /** 展示标题（缺省用 name） */
  title: string;
  /** 描述（优先中文；catalog format-1 是 `{zh,en}`） */
  description?: string;
  /** 双语描述（catalog 提供时） */
  descriptionI18n?: { zh?: string; en?: string };
  /** 分类 id（catalog `metadata.category`；缺省空串） */
  category: string;
  repository?: string;
  homepage?: string;
  /** 展示用版本（catalog 策展版本；缺省空串，前端不显示 undefined） */
  version: string;
  /** catalog 里的最新版本（可能缺省） */
  latestVersion?: string;
  /** `engines.dsh` 之类的宿主要求 */
  engines?: Record<string, string>;
  /** 兼容档位 */
  compat: MarketCompat;
  /** 档位说明（市场页徽标 tooltip） */
  compatReason: string;
  /** 档位依据：catalog 只有包名/分类（hint） → registry 元数据（确认） */
  compatSource: "catalog" | "registry";
  /** 能否一键安装（C 档 false：装上也渲染不出来，只作对照） */
  installable: boolean;
}

/** catalog 查询参数（`GET /api/plugins/market?q=&category=&limit=&offset=`） */
export interface MarketCatalogQuery {
  /** 关键字（name / title / description） */
  q?: string;
  category?: string;
  /** 每页条数（默认 24，上限 100） */
  limit?: number;
  /** 偏移（从 0 开始） */
  offset?: number;
}

/** catalog 响应 */
export interface MarketCatalogResult {
  plugins: MarketPluginEntry[];
  /** 过滤后的总数（分页前） */
  total: number;
  /** 本次返回条数上限 */
  limit: number;
  /** 本次偏移 */
  offset: number;
  /** 目录来源（抓取 URL） */
  source?: string;
  fetchedAt?: string;
  /** true = 本次用的是过期缓存（抓取失败） */
  stale?: boolean;
  /** 抓取失败原因（成功时缺省） */
  error?: string;
  /** 值得重试（网络类错误） */
  retryable?: boolean;
  /** 分类 chips：只含本次结果集里出现的分类（按 catalog 声明顺序） */
  categories: MarketCategory[];
}

/** 市场分类（id + 双语标题，来自 catalog 顶层 `metadata.categories`） */
export interface MarketCategory {
  id: string;
  title: { zh: string; en: string };
}

/** 列表分档探测选项（catalog 没有协议字段，按 registry latest 元数据确认） */
export interface MarketCompatProbeOptions {
  /** 关闭探测（`FENG_MARKET_PROBE=0` 也可关）；默认开 */
  enabled?: boolean;
  /** 单包请求超时（默认 2.5s） */
  timeoutMs?: number;
  /** 并发（默认 8；registry 限流时会被熔断兜住） */
  concurrency?: number;
  /** 结果缓存 TTL（默认 1h） */
  ttlMs?: number;
  /** 连续失败多少次后熔断（默认 6） */
  failureThreshold?: number;
  /** 熔断冷却（默认 5 分钟） */
  cooldownMs?: number;
}

/** 市场目录选项 */
export interface MarketCatalogOptions {
  /** 数据根（磁盘缓存落在 `<dataRoot>/cache/market-catalog.json`） */
  dataRoot: string;
  /** fetch 注入（测试不发真请求） */
  fetchImpl?: typeof fetch;
  /** 覆盖源列表（`FENG_MARKET_CATALOG_URL` 优先） */
  sources?: string[];
  /** 缓存 TTL（毫秒，默认 1 小时） */
  ttlMs?: number;
  /** 时间注入（测试） */
  now?: () => number;
  /** 磁盘缓存路径覆盖 */
  cacheFile?: string;
  /** 源响应大小上限（字节，默认 32 MB） */
  maxBytes?: number;
  /** npm registry 覆盖（详情页 / 分档探测用） */
  registry?: string;
  /** 列表分档探测（catalog 无协议字段时的 registry 确认） */
  compatProbe?: MarketCompatProbeOptions;
}

/** 市场详情（`GET /api/plugins/market/:name`） */
export interface MarketDetail {
  name: string;
  title: string;
  description?: string;
  category?: string;
  repository?: string;
  homepage?: string;
  /** 全部版本（新→旧；registry 拉不到时为空） */
  versions: string[];
  latestVersion?: string;
  compat: MarketCompat;
  compatReason: string;
  /** 档位依据（详情页通常已用 registry 元数据确认） */
  compatSource: "catalog" | "registry";
  installable: boolean;
  /** registry 拉取失败原因（详情页仍可展示 catalog 信息） */
  error?: string;
}

/** 默认源顺序：国内镜像优先 → 源站 */
export const DEFAULT_MARKET_SOURCES = [
  "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json",
  "https://awesome-dsh-plugin.com/plugins.json",
];

/** 默认缓存 TTL（1 小时：catalog 每日更新，没必要每次开市场页都回源） */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** 默认源响应上限 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** 默认每页条数 */
const DEFAULT_LIMIT = 24;
/** 单页上限（防止前端一次拉全量） */
const MAX_LIMIT = 100;

/** 原始目录条目（源站字段形状不统一，统一收敛） */
type RawEntry = Record<string, unknown>;

/** 缓存实体 */
interface CatalogCache {
  /** 抓取到的原始条目（已归一 name） */
  entries: RawEntry[];
  /** 顶层分类 id → 双语标题（catalog `metadata.categories`） */
  categories?: Record<string, { zh: string; en: string }>;
  source?: string;
  fetchedAt: number;
}

/** 取第一个字符串字段 */
function pickString(entry: RawEntry, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** repository 字段可能是字符串或 `{ url }` */
function repoOf(entry: RawEntry): string | undefined {
  const raw = entry.repository;
  if (typeof raw === "string") return raw || undefined;
  if (raw && typeof raw === "object") {
    const url = (raw as Record<string, unknown>).url;
    if (typeof url === "string" && url) return url;
  }
  return pickString(entry, ["repo", "github"]);
}

/** 归一 name：源站有的条目用 `pkg` / `package` 字段 */
function nameOf(entry: RawEntry): string | undefined {
  return pickString(entry, ["name", "package", "npm", "pkg"]);
}

/** 描述字段：format-1 catalog 是 `{ zh, en }`，旧源/包元数据是字符串 */
function descriptionOf(raw: RawEntry): { text?: string; i18n: { zh?: string; en?: string } } {
  const value = raw.description ?? raw.summary ?? raw.desc;
  const i18n: { zh?: string; en?: string } = {};
  if (typeof value === "string") {
    return value.trim() ? { text: value.trim(), i18n } : { i18n };
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      if (key === "zh" || key === "en") i18n[key] = entry.trim();
    }
    const text = i18n.zh ?? i18n.en;
    if (text) return { text, i18n };
  }
  return { i18n };
}

/** catalog format-1：分类在 `metadata.category`，版本/engines 在 `versions[0]` */
function metadataOf(raw: RawEntry): Record<string, unknown> | undefined {
  const meta = raw.metadata;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined;
}

/** 版本列表里的第一条（format-1 每条只给一个策展版本） */
function firstVersion(raw: RawEntry): Record<string, unknown> | undefined {
  const versions = raw.versions;
  if (!Array.isArray(versions)) return undefined;
  const first = versions[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
}

/** 兼容分类：包元数据 → A/B/C（不用下 tarball） */
export function classifyCompat(meta: {
  fengagent?: unknown;
  dsh?: unknown;
  keywords?: unknown;
  engines?: unknown;
}): { compat: MarketCompat; reason: string } {
  const fengagent = meta.fengagent;
  if (fengagent && typeof fengagent === "object" && (fengagent as Record<string, unknown>).webui !== undefined) {
    return { compat: "A", reason: "声明 fengagent.webui：装完刷新页面即渲染" };
  }
  const dsh = meta.dsh;
  if (dsh && typeof dsh === "object") {
    const record = dsh as Record<string, unknown>;
    if (record.client !== undefined) {
      return { compat: "C", reason: "dsh.client 客户端插件：需要 dsh UI 兼容层，本期不渲染（对照组）" };
    }
    return { compat: "B", reason: "dsh host 侧插件：走 dsh-compat 装载，装完需重启宿主" };
  }
  if (typeof dsh === "string" && dsh) {
    return { compat: "B", reason: "dsh host 侧插件：走 dsh-compat 装载，装完需重启宿主" };
  }
  const engines = meta.engines;
  if (engines && typeof engines === "object" && (engines as Record<string, unknown>).dsh) {
    return { compat: "B", reason: "面向 dsh 的 host 侧插件（engines.dsh）：试装 + 重启" };
  }
  const keywords = Array.isArray(meta.keywords) ? meta.keywords.filter((k): k is string => typeof k === "string") : [];
  if (keywords.includes("dsh.client")) {
    return { compat: "C", reason: "dsh.client 客户端插件：需要 dsh UI 兼容层，本期不渲染（对照组）" };
  }
  return { compat: "B", reason: "未声明 dsh 形态，按 host 侧插件试装（失败会显示原因）" };
}

/** 把源站条目投影成市场条目（无法归一的条目丢弃） */
export function projectEntry(raw: RawEntry): MarketPluginEntry | null {
  const name = nameOf(raw);
  if (!name) return null;
  const meta = metadataOf(raw);
  const version = firstVersion(raw);
  const title =
    pickString(raw, ["title", "displayName", "display_name", "label"]) ??
    pickString(meta ?? {}, ["title", "displayName"]) ??
    name;

  const { text: description, i18n } = descriptionOf(raw);
  const categoryRaw = raw.category ?? raw.categories ?? meta?.category;
  const category =
    typeof categoryRaw === "string"
      ? categoryRaw
      : Array.isArray(categoryRaw)
        ? categoryRaw.find((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;

  const latestVersion =
    pickString(raw, ["latestVersion", "latest", "version"]) ??
    (version ? pickString(version, ["version"]) : undefined);
  const enginesRaw = raw.engines ?? version?.engines;
  const engines =
    enginesRaw && typeof enginesRaw === "object"
      ? Object.fromEntries(
          Object.entries(enginesRaw as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .slice(0, 8),
        )
      : undefined;
  const keywords = meta?.keywords ?? raw.keywords;

  const { compat, reason } = classifyCompat({
    fengagent: raw.fengagent,
    dsh: raw.dsh,
    keywords,
    engines: enginesRaw,
  });

  return {
    name,
    title,
    ...(description ? { description } : {}),
    ...(i18n.zh || i18n.en ? { descriptionI18n: i18n } : {}),
    category: category ?? "",
    version: latestVersion ?? "",
    ...(repoOf(raw) ? { repository: repoOf(raw) } : {}),
    ...(pickString(raw, ["homepage", "url"]) ? { homepage: pickString(raw, ["homepage", "url"]) } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    ...(engines && Object.keys(engines).length > 0 ? { engines } : {}),
    compat,
    compatReason: reason,
    // catalog 只给包名/描述/分类，没有 package.json 的 dsh/fengagent 字段：
    // 列表徽标是 hint，安装时 assertInstallable 再用 registry 元数据确认。
    compatSource: raw.fengagent !== undefined || raw.dsh !== undefined || raw.keywords !== undefined ? "registry" : "catalog",
    installable: compat !== "C",
  };
}

/** 从源站 JSON 里取出条目数组（兼容 `{plugins}` / `{items}` / 裸数组） */
export function extractEntries(payload: unknown): RawEntry[] {
  const candidates = Array.isArray(payload)
    ? [payload]
    : payload && typeof payload === "object"
      ? [
          (payload as Record<string, unknown>).plugins,
          (payload as Record<string, unknown>).items,
          (payload as Record<string, unknown>).data,
        ]
      : [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is RawEntry => Boolean(entry) && typeof entry === "object");
    }
  }
  return [];
}

/** 双语标题字段归一（catalog format-1 是 `{ title: { zh, en } }`） */
function titleOf(value: unknown): { zh: string; en: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>).title ?? value;
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? { zh: text, en: text } : undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const zh = typeof record.zh === "string" ? record.zh.trim() : "";
  const en = typeof record.en === "string" ? record.en.trim() : "";
  if (!zh && !en) return undefined;
  // 单语时另一语回退同一文本，前端 `title.zh` 永远有值
  return { zh: zh || en, en: en || zh };
}

/**
 * 从源站 JSON 顶层取分类表（catalog format-1：`metadata.categories`，
 * 源站：顶层 `categories`），归一成 `id → {zh,en}`。
 *
 * 市场页的分类 chips 消费这张表；条目里只有 `metadata.category` id。
 */
export function extractCategories(payload: unknown): Record<string, { zh: string; en: string }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const meta = record.metadata;
  const raw =
    (meta && typeof meta === "object" ? (meta as Record<string, unknown>).categories : undefined) ??
    record.categories;
  const out: Record<string, { zh: string; en: string }> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = pickString(item as RawEntry, ["id", "slug", "name"]);
      const title = titleOf(item);
      if (id && title) out[id] = title;
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const title = titleOf(value);
      if (title) out[id] = title;
    }
  }
  return out;
}

/** 结果集里的分类（按 catalog 声明顺序，未知 id 追加在末尾按字母序） */
export function projectCategories(
  entries: MarketPluginEntry[],
  titles: Record<string, { zh: string; en: string }> | undefined,
): MarketCategory[] {
  const present = new Set(entries.map((entry) => entry.category).filter((id) => id.length > 0));
  const declared = Object.keys(titles ?? {});
  const out: MarketCategory[] = [];
  for (const id of declared) {
    if (!present.has(id)) continue;
    present.delete(id);
    out.push({ id, title: titles?.[id] ?? { zh: id, en: id } });
  }
  for (const id of [...present].sort()) {
    out.push({ id, title: { zh: id, en: id } });
  }
  return out;
}

/** 关键字匹配（name / title / description，大小写不敏感） */
function matches(entry: MarketPluginEntry, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.title.toLowerCase().includes(needle) ||
    (entry.description ?? "").toLowerCase().includes(needle)
  );
}

/** 排序：A → B → C，同档按名字（市场页默认 A/B 优先、C 折叠） */
const COMPAT_ORDER: Record<MarketCompat, number> = { A: 0, B: 1, C: 2 };

function compare(a: MarketPluginEntry, b: MarketPluginEntry): number {
  const byCompat = COMPAT_ORDER[a.compat] - COMPAT_ORDER[b.compat];
  return byCompat !== 0 ? byCompat : a.name.localeCompare(b.name);
}

/**
 * 市场目录：抓取 + 缓存 + 分页 + 兼容分类。
 *
 * `catalog()` 永不抛网络错误：抓不到就用 stale 缓存并带 `error`，首启无网返回空
 * 列表 + `retryable: true` —— 市场页打开不该被网络阻塞。
 */
export class MarketCatalog {
  private readonly dataRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sources: string[];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cacheFile: string;
  private readonly maxBytes: number;
  private readonly registryUrl: string | null;
  private readonly probe: Required<MarketCompatProbeOptions>;
  private readonly probeCache = new Map<string, { at: number; compat: MarketCompat; reason: string }>();
  /** 探测熔断截止时间（registry 不可达时不把市场页拖死） */
  private probeCooldownUntil = 0;
  private memory: CatalogCache | null = null;
  /** 避免并发请求打爆源站：进行中的抓取共享同一个 Promise */
  private inflight: Promise<CatalogCache | null> | null = null;

  constructor(options: MarketCatalogOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sources =
      options.sources ??
      (process.env.FENG_MARKET_CATALOG_URL?.trim()
        ? [process.env.FENG_MARKET_CATALOG_URL.trim(), ...DEFAULT_MARKET_SOURCES]
        : DEFAULT_MARKET_SOURCES);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.cacheFile = resolve(options.cacheFile ?? resolve(this.dataRoot, "cache", "market-catalog.json"));
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.registryUrl = options.registry?.trim() || null;
    const probe = options.compatProbe ?? {};
    this.probe = {
      enabled: probe.enabled ?? process.env.FENG_MARKET_PROBE !== "0",
      timeoutMs: probe.timeoutMs ?? 2_500,
      concurrency: Math.max(1, Math.floor(probe.concurrency ?? 8)),
      ttlMs: probe.ttlMs ?? DEFAULT_TTL_MS,
      failureThreshold: Math.max(1, Math.floor(probe.failureThreshold ?? 6)),
      cooldownMs: probe.cooldownMs ?? 5 * 60 * 1000,
    };
  }

  /** 目录查询（搜索 + 分类 + 分页都在服务端） */
  async catalog(query: MarketCatalogQuery = {}): Promise<MarketCatalogResult> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const { cache, stale, error, retryable } = await this.load();
    const entries = (cache?.entries ?? [])
      .map((raw) => projectEntry(raw))
      .filter((entry): entry is MarketPluginEntry => entry !== null)
      .sort(compare);

    const q = query.q?.trim();
    const category = query.category?.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (q && !matches(entry, q)) return false;
      if (category && (entry.category ?? "").toLowerCase() !== category) return false;
      return true;
    });

    return {
      plugins: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
      ...(cache?.source ? { source: cache.source } : {}),
      ...(cache?.fetchedAt ? { fetchedAt: new Date(cache.fetchedAt).toISOString() } : {}),
      ...(stale ? { stale: true } : {}),
      ...(error ? { error } : {}),
      ...(retryable ? { retryable: true } : {}),
      categories: projectCategories(filtered, cache?.categories),
    };
  }

  /**
   * 列表分档回填：catalog 没有协议字段，用 registry 的 `/latest` 元数据为**当前页**
   * 条目确认档位（A/C 才会真实出现），带 1h 缓存与熔断。
   *
   * 只处理 `compatSource: "catalog"` 的 hint；失败一律保留原 hint —— 市场页不该被
   * registry 的可用性拖垮（连续失败 N 次后冷却，期间直接返回原条目）。
   */
  async enrich(entries: MarketPluginEntry[]): Promise<MarketPluginEntry[]> {
    if (!this.probe.enabled || entries.length === 0) return entries;
    if (this.now() < this.probeCooldownUntil) return entries;
    const pending = entries.filter((entry) => entry.compatSource === "catalog");
    if (pending.length === 0) return entries;

    const resolved = new Map<string, { compat: MarketCompat; reason: string }>();
    let failures = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        if (failures >= this.probe.failureThreshold) {
          this.probeCooldownUntil = this.now() + this.probe.cooldownMs;
          return;
        }
        const entry = pending[cursor++]!;
        const cached = this.probeCache.get(entry.name);
        if (cached && this.now() - cached.at <= this.probe.ttlMs) {
          resolved.set(entry.name, cached);
          continue;
        }
        try {
          const manifest = await fetchNpmLatestManifest(entry.name, {
            ...(this.registryUrl ? { registry: this.registryUrl } : {}),
            fetchImpl: this.fetchImpl,
            timeoutMs: this.probe.timeoutMs,
          });
          const classified = classifyCompat(manifest);
          const value = { at: this.now(), compat: classified.compat, reason: classified.reason };
          this.probeCache.set(entry.name, value);
          resolved.set(entry.name, value);
        } catch (error) {
          // 404 = 这个包没发布到 npm（永久性），不算连通性失败、不熔断
          const permanent =
            error instanceof Error && "code" in error && (error as { code?: string }).code === "not_found";
          if (!permanent) failures += 1;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.probe.concurrency, pending.length) }, () => worker()),
    );
    if (resolved.size === 0) return entries;

    return entries.map((entry) => {
      const hit = resolved.get(entry.name);
      if (!hit) return entry;
      return {
        ...entry,
        compat: hit.compat,
        compatReason: hit.reason,
        compatSource: "registry",
        installable: hit.compat !== "C",
      };
    });
  }

  /** 市场条目里是否有这个包（安装前校验用） */
  async find(name: string): Promise<MarketPluginEntry | null> {
    const { cache } = await this.load();
    const raw = (cache?.entries ?? []).find((entry) => nameOf(entry) === name);
    return raw ? projectEntry(raw) : null;
  }

  /**
   * 插件详情（`GET /api/plugins/market/:name`）：catalog 条目 + packument 版本。
   *
   * registry 拉不到时只回 catalog 已知信息（`versions` 为空，`error` 带原因），
   * 详情页不该因为 registry 抽风而整页 500。
   */
  async detail(name: string): Promise<MarketDetail> {
    const entry = await this.find(name);
    let packument: NpmPackument | null = null;
    let error: string | undefined;
    try {
      packument = await fetchNpmPackument(name, {
        ...(this.registryUrl ? { registry: this.registryUrl } : {}),
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const manifest = packument?.latestManifest;
    const classified = manifest ? classifyCompat(manifest) : null;
    const compat = classified?.compat ?? entry?.compat ?? "B";
    const compatReason = classified?.reason ?? entry?.compatReason ?? "未知形态：按 host 侧插件试装";
    return {
      name: packument?.name ?? name,
      title: entry?.title ?? name,
      ...(entry?.description ? { description: entry.description } : {}),
      ...(entry?.category ? { category: entry.category } : {}),
      ...(entry?.repository ? { repository: entry.repository } : {}),
      ...(entry?.homepage ? { homepage: entry.homepage } : {}),
      versions: packument?.versions ?? [],
      latestVersion: packument?.distTags.latest ?? entry?.latestVersion,
      compat,
      compatReason,
      compatSource: classified ? "registry" : (entry?.compatSource ?? "catalog"),
      installable: compat !== "C",
      ...(error ? { error } : {}),
    };
  }

  /**
   * 市场安装校验：名称必须在 catalog 策展清单里、C 档拒绝、版本必须存在。
   *
   * 拒绝 C 档是有意的：装上也渲染不出来，只会让用户以为「装成功了但没界面」。
   * catalog 只给包名/描述/分类（没有 package.json 的 dsh/fengagent 字段），所以
   * 安装前回 registry 取一次 packument：一是确认确切版本存在，二是用真实元数据
   * 再判一次档 —— 后端不能靠「目录里没写」就放 C 档插件进来。
   */
  async assertInstallable(name: string, version?: string): Promise<MarketPluginEntry> {
    const entry = await this.find(name);
    if (!entry) {
      throw new Error(`市场目录里没有插件 ${name}`);
    }
    if (!entry.installable) {
      throw new Error(`${name} 是 C 档（dsh.client）插件：本期不渲染界面，市场不支持一键安装`);
    }
    let packument: NpmPackument;
    try {
      packument = await fetchNpmPackument(name, {
        ...(this.registryUrl ? { registry: this.registryUrl } : {}),
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      throw new Error(
        `无法校验 ${name}（registry 查询失败）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (version && !packument.versions.includes(version)) {
      throw new Error(`${name} 没有版本 ${version}`);
    }
    const manifest = packument.latestManifest;
    if (manifest) {
      const classified = classifyCompat(manifest);
      if (classified.compat === "C") {
        throw new Error(
          `${name} 是 C 档（dsh.client）插件：本期不渲染界面，市场不支持一键安装`,
        );
      }
    }
    return entry;
  }

  /** 读取缓存：内存 → 磁盘 → 抓取；抓取失败回退 stale */
  private async load(): Promise<{
    cache: CatalogCache | null;
    stale?: boolean;
    error?: string;
    retryable?: boolean;
  }> {
    const fresh = this.freshFromMemory() ?? this.freshFromDisk();
    if (fresh) return { cache: fresh };
    try {
      const fetched = await this.refresh();
      return fetched ? { cache: fetched } : { cache: this.staleFallback() };
    } catch (error) {
      const stale = this.staleFallback();
      return {
        cache: stale,
        ...(stale ? { stale: true } : {}),
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  private freshFromMemory(): CatalogCache | null {
    if (!this.memory) return null;
    return this.now() - this.memory.fetchedAt <= this.ttlMs ? this.memory : null;
  }

  private freshFromDisk(): CatalogCache | null {
    const disk = this.readDisk();
    if (!disk) return null;
    if (this.now() - disk.fetchedAt <= this.ttlMs) {
      this.memory = disk;
      return disk;
    }
    return null;
  }

  private staleFallback(): CatalogCache | null {
    return this.memory ?? this.readDisk();
  }

  private readDisk(): CatalogCache | null {
    try {
      if (!existsSync(this.cacheFile)) return null;
      const raw = JSON.parse(readFileSync(this.cacheFile, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return null;
      const record = raw as Record<string, unknown>;
      const entries = extractEntries(record.entries);
      const fetchedAt = typeof record.fetchedAt === "number" ? record.fetchedAt : 0;
      if (entries.length === 0 || fetchedAt <= 0) return null;
      const categories = extractCategories({ metadata: { categories: record.categories } });
      return {
        entries,
        ...(Object.keys(categories).length > 0 ? { categories } : {}),
        fetchedAt,
        ...(typeof record.source === "string" ? { source: record.source } : {}),
      };
    } catch {
      return null;
    }
  }

  private writeDisk(cache: CatalogCache): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const body = `${JSON.stringify({ version: 1, ...cache }, null, 0)}\n`;
      const tmp = `${this.cacheFile}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.cacheFile);
    } catch {
      try {
        rmSync(`${this.cacheFile}.tmp`, { force: true });
      } catch {
        // 缓存写不进去不影响本次响应
      }
    }
  }

  /** 并发共享一次抓取；全部源失败则抛最后一个错误 */
  private refresh(): Promise<CatalogCache | null> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchAll(): Promise<CatalogCache | null> {
    let lastError: Error | null = null;
    for (const url of this.sources) {
      try {
        const response = await this.fetchImpl(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > this.maxBytes) throw new Error(`目录响应过大（>${this.maxBytes} 字节）`);
        const payload = JSON.parse(text) as unknown;
        const entries = extractEntries(payload);
        if (entries.length === 0) throw new Error("目录里没有条目");
        const categories = extractCategories(payload);
        const cache: CatalogCache = {
          entries,
          ...(Object.keys(categories).length > 0 ? { categories } : {}),
          fetchedAt: this.now(),
          source: url,
        };
        this.memory = cache;
        this.writeDisk(cache);
        return cache;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (lastError) throw lastError;
    return null;
  }
}
