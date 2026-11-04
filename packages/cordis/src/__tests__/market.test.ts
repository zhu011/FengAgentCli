/**
 * 市场目录（A）：兼容分档 / 投影 / 搜索分页 / 缓存与 stale 回退 / 安装闸门。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MarketCatalog,
  classifyCompat,
  extractCategories,
  extractEntries,
  projectEntry,
  type MarketPluginEntry,
} from "../market.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feng-market-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 三个档位的样例目录 */
const CATALOG = {
  version: 1,
  plugins: [
    {
      name: "alpha-ui",
      title: "Alpha UI",
      description: "带界面的插件",
      category: "ui",
      latestVersion: "1.0.0",
      fengagent: { webui: { entry: "./client.mjs", slots: ["settings-section"] } },
    },
    {
      name: "beta-tools",
      title: "Beta Tools",
      description: "host 侧工具",
      category: "tools",
      latestVersion: "2.0.0",
      dsh: { service: {} },
      engines: { dsh: ">=0.5.0" },
    },
    {
      name: "@acme/gamma-client",
      title: "Gamma Client",
      category: "ui",
      latestVersion: "0.3.0",
      dsh: { client: { entry: "./client.js" } },
    },
    { name: "no-meta" },
    { title: "缺 name 的条目会被丢弃" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 计数假 fetch：同一 URL 命中多次可断言缓存 */
function countingFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function makeCatalog(options: { fetchImpl: typeof fetch; now?: () => number; ttlMs?: number }): MarketCatalog {
  return new MarketCatalog({
    dataRoot: root,
    sources: ["https://market.example/catalog.json"],
    ...options,
  });
}

describe("兼容分档", () => {
  test("fengagent.webui → A；dsh 无 client → B；dsh.client → C", () => {
    expect(classifyCompat({ fengagent: { webui: "./c.mjs" } }).compat).toBe("A");
    expect(classifyCompat({ dsh: { service: {} } }).compat).toBe("B");
    expect(classifyCompat({ dsh: { client: {} } }).compat).toBe("C");
    expect(classifyCompat({ dsh: "0.5" }).compat).toBe("B");
    expect(classifyCompat({ engines: { dsh: ">=0.5" } }).compat).toBe("B");
    expect(classifyCompat({}).compat).toBe("B");
  });

  test("keywords 里的 dsh.client 也归 C 档", () => {
    expect(classifyCompat({ keywords: ["dsh.client", "ui"] }).compat).toBe("C");
  });
});

describe("条目投影", () => {
  test("A/B/C 三档 + installable 口径", () => {
    const entries = CATALOG.plugins
      .map((raw) => projectEntry(raw as Record<string, unknown>))
      .filter((entry): entry is MarketPluginEntry => entry !== null);
    expect(entries.map((entry) => entry.name)).toEqual([
      "alpha-ui",
      "beta-tools",
      "@acme/gamma-client",
      "no-meta",
    ]);
    expect(entries[0]).toMatchObject({ compat: "A", installable: true, title: "Alpha UI", category: "ui" });
    expect(entries[1]).toMatchObject({ compat: "B", installable: true, engines: { dsh: ">=0.5.0" } });
    expect(entries[2]).toMatchObject({ compat: "C", installable: false });
    expect(entries[3]!.title).toBe("no-meta");
  });

  test("repository 支持字符串与 { url }", () => {
    expect(projectEntry({ name: "a", repository: "https://g/a" })?.repository).toBe("https://g/a");
    expect(projectEntry({ name: "b", repository: { url: "https://g/b" } })?.repository).toBe("https://g/b");
  });

  test("extractEntries 兼容 {plugins} / {items} / 裸数组", () => {
    expect(extractEntries({ plugins: [{ name: "a" }] })).toHaveLength(1);
    expect(extractEntries({ items: [{ name: "a" }, { name: "b" }] })).toHaveLength(2);
    expect(extractEntries([{ name: "a" }])).toHaveLength(1);
    expect(extractEntries(null)).toHaveLength(0);
  });

  test("extractCategories：catalog format-1 的 metadata.categories 映射 → 分类表", () => {
    const payload = {
      plugins: CATALOG.plugins,
      metadata: {
        categories: {
          ui: { title: { zh: "UI 增强", en: "UI Enhancements" } },
          tools: { title: { en: "Tools" } },
          "": { title: { zh: "空 id 丢弃" } },
        },
      },
    };
    expect(extractCategories(payload)).toEqual([
      { id: "ui", title: { zh: "UI 增强", en: "UI Enhancements" } },
      { id: "tools", title: { en: "Tools" } },
    ]);
    expect(extractCategories(CATALOG)).toBeNull();
    expect(extractCategories({ metadata: { categories: [] } })).toBeNull();
  });

  test("catalog format-1：双语 description / metadata.category / versions[].version", () => {
    const entry = projectEntry({
      name: "@yolk/dsh-project-memory",
      title: "dsh-project-memory",
      description: { zh: "项目级记忆", en: "project memory" },
      homepage: "https://awesome-dsh-plugin.com/p/x",
      repository: { url: "https://github.com/x/y" },
      metadata: { category: "memory", keywords: [] },
      versions: [{ version: "0.6.9", engines: { dsh: ">=0.5.0" } }],
    });
    expect(entry).toMatchObject({
      name: "@yolk/dsh-project-memory",
      title: "dsh-project-memory",
      description: "项目级记忆",
      descriptionI18n: { zh: "项目级记忆", en: "project memory" },
      category: "memory",
      latestVersion: "0.6.9",
      engines: { dsh: ">=0.5.0" },
      repository: "https://github.com/x/y",
      compatSource: "catalog",
    });
  });
});

describe("catalog 查询", () => {
  test("catalog() 回传分类表（metadata.categories 投影，磁盘缓存往返保留）", async () => {
    const payload = {
      plugins: CATALOG.plugins,
      metadata: {
        categories: {
          ui: { title: { zh: "UI 增强", en: "UI Enhancements" } },
          tools: { title: { zh: "工具与能力" } },
        },
      },
    };
    const catalog = makeCatalog({ fetchImpl: countingFetch(payload).fetchImpl });
    const result = await catalog.catalog({});
    expect(result.categories).toEqual([
      { id: "ui", title: { zh: "UI 增强", en: "UI Enhancements" } },
      { id: "tools", title: { zh: "工具与能力" } },
    ]);
    // 磁盘缓存回读：新实例 + 拒绝式 fetch 仍能拿到分类（旧缓存无此字段则缺省）
    const reread = new MarketCatalog({
      dataRoot: root,
      sources: ["https://market.example/catalog.json"],
      fetchImpl: countingFetch(payload, 500).fetchImpl,
    });
    expect((await reread.catalog({})).categories).toEqual(result.categories);
  });

  test("默认排序 A→B→C，且 limit/offset 在服务端", async () => {
    const { fetchImpl } = countingFetch(CATALOG);
    const market = makeCatalog({ fetchImpl });
    const first = await market.catalog({ limit: 2 });
    expect(first.total).toBe(4);
    expect(first.plugins.map((entry) => entry.compat)).toEqual(["A", "B"]);
    const second = await market.catalog({ limit: 2, offset: 2 });
    expect(second.plugins.map((entry) => entry.name)).toEqual(["no-meta", "@acme/gamma-client"]);
  });

  test("关键字与分类过滤", async () => {
    const { fetchImpl } = countingFetch(CATALOG);
    const market = makeCatalog({ fetchImpl });
    const byQuery = await market.catalog({ q: "beta" });
    expect(byQuery.plugins.map((entry) => entry.name)).toEqual(["beta-tools"]);
    const byCategory = await market.catalog({ category: "ui" });
    expect(byCategory.plugins.map((entry) => entry.name)).toEqual(["alpha-ui", "@acme/gamma-client"]);
  });

  test("limit 上限 100、缺省 24，offset 不为负", async () => {
    const { fetchImpl } = countingFetch(CATALOG);
    const market = makeCatalog({ fetchImpl });
    const result = await market.catalog({ limit: 1000, offset: -5 });
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
    const fallback = await market.catalog();
    expect(fallback.limit).toBe(24);
  });

  test("FENG_MARKET_CATALOG_URL 覆盖首个源（e2e fixture 注入点）", async () => {
    const previous = process.env.FENG_MARKET_CATALOG_URL;
    process.env.FENG_MARKET_CATALOG_URL = "https://fixture.example/catalog.json";
    const seen: string[] = [];
    try {
      const fetchImpl = (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return jsonResponse(CATALOG);
      }) as unknown as typeof fetch;
      const market = new MarketCatalog({ dataRoot: root, fetchImpl });
      await market.catalog();
      expect(seen[0]).toBe("https://fixture.example/catalog.json");
    } finally {
      if (previous === undefined) delete process.env.FENG_MARKET_CATALOG_URL;
      else process.env.FENG_MARKET_CATALOG_URL = previous;
    }
  });

  test("TTL 内命中内存缓存（只抓一次）", async () => {
    const { fetchImpl, calls } = countingFetch(CATALOG);
    const market = makeCatalog({ fetchImpl });
    await market.catalog();
    await market.catalog({ q: "alpha" });
    expect(calls()).toBe(1);
  });

  test("抓取失败回退磁盘 stale 并带 error/retryable", async () => {
    let now = 1_000;
    const good = makeCatalog({ fetchImpl: countingFetch(CATALOG).fetchImpl, now: () => now, ttlMs: 10 });
    await good.catalog();
    expect(existsSync(join(root, "cache", "market-catalog.json"))).toBe(true);

    now = 1_000_000; // 远超 TTL
    const broken = makeCatalog({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      now: () => now,
      ttlMs: 10,
    });
    const result = await broken.catalog();
    expect(result.stale).toBe(true);
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.retryable).toBe(true);
    expect(result.total).toBe(4);
  });

  test("首启无网：空列表 + retryable（不抛错）", async () => {
    const market = makeCatalog({
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    const result = await market.catalog();
    expect(result.plugins).toEqual([]);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("500");
  });
});

describe("市场安装闸门", () => {
  test("目录里没有该包 → 抛错", async () => {
    const { fetchImpl } = countingFetch(CATALOG);
    const market = makeCatalog({ fetchImpl });
    await expect(market.assertInstallable("missing")).rejects.toThrow(/没有插件/);
  });

  test("C 档拒绝一键安装（装上也渲染不出来）", async () => {
    const { fetchImpl } = countingFetch(CATALOG);
    const market = makeCatalog({ fetchImpl });
    await expect(market.assertInstallable("@acme/gamma-client")).rejects.toThrow(/C 档/);
  });

  test("A/B 档放行目录版本（registry 确认版本存在）", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://market.example")) return jsonResponse(CATALOG);
      if (url === "https://registry.npmjs.org/alpha-ui") {
        return jsonResponse({
          name: "alpha-ui",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { fengagent: { webui: "./client.mjs" } } },
        });
      }
      if (url === "https://registry.npmjs.org/beta-tools") {
        return jsonResponse({
          name: "beta-tools",
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": { dsh: { service: {} } } },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const market = makeCatalog({ fetchImpl });
    expect((await market.assertInstallable("alpha-ui", "1.0.0")).name).toBe("alpha-ui");
    expect((await market.assertInstallable("beta-tools")).name).toBe("beta-tools");
  });

  test("目录里没写形态但 registry 元数据是 dsh.client → 安装前拒绝（C 档兜底）", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://market.example")) return jsonResponse(CATALOG);
      if (url === "https://registry.npmjs.org/beta-tools") {
        return jsonResponse({
          name: "beta-tools",
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": { dsh: { client: { entry: "./client.js" } } } },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const market = makeCatalog({ fetchImpl });
    await expect(market.assertInstallable("beta-tools", "2.0.0")).rejects.toThrow(/C 档/);
  });

  test("registry 查不到 → 安装前直接失败（不放行未知形态）", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://market.example")) return jsonResponse(CATALOG);
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const market = makeCatalog({ fetchImpl });
    await expect(market.assertInstallable("beta-tools")).rejects.toThrow(/registry 查询失败/);
  });

  test("指定非目录版本 → registry 确认存在，不存在则拒绝", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://market.example")) return jsonResponse(CATALOG);
      if (url === "https://registry.npmjs.org/beta-tools") {
        return jsonResponse({
          name: "beta-tools",
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": {}, "1.5.0": {} },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const market = makeCatalog({ fetchImpl });
    expect((await market.assertInstallable("beta-tools", "1.5.0")).name).toBe("beta-tools");
    await expect(market.assertInstallable("beta-tools", "9.9.9")).rejects.toThrow(/没有版本/);
  });
});

describe("详情", () => {
  test("详情合并 catalog 与 packument（registry 失败时仍返回 catalog 信息）", async () => {
    const registry = {
      name: "alpha-ui",
      "dist-tags": { latest: "1.2.0" },
      versions: {
        "1.2.0": { version: "1.2.0", fengagent: { webui: "./client.mjs" } },
        "1.0.0": { version: "1.0.0" },
      },
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://market.example")) return jsonResponse(CATALOG);
      if (url === "https://registry.npmjs.org/alpha-ui") return jsonResponse(registry);
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const market = makeCatalog({ fetchImpl });
    const detail = await market.detail("alpha-ui");
    expect(detail).toMatchObject({
      name: "alpha-ui",
      compat: "A",
      installable: true,
      latestVersion: "1.2.0",
      versions: ["1.2.0", "1.0.0"],
    });
  });

  test("registry 拉不到时降级为 catalog 信息", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://market.example")) return jsonResponse(CATALOG);
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const market = makeCatalog({ fetchImpl });
    const detail = await market.detail("beta-tools");
    expect(detail.versions).toEqual([]);
    expect(detail.compat).toBe("B");
    expect(detail.error).toContain("offline");
  });
});
