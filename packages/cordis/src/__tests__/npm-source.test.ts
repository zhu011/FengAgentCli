/**
 * npm 源（P1）：spec 解析 / integrity 校验 / registry 解析 / tarball 下载。
 *
 * 全部走注入的假 fetch —— 用例不联网，也不依赖真实 registry 的目录形状。
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_TARBALL_BYTES,
  NpmSourceError,
  downloadTarball,
  fetchNpmPackument,
  isNpmSpec,
  parseNpmSpec,
  resolveNpmVersion,
  verifyIntegrity,
} from "../npm-source.ts";

const bytes = Buffer.from("fake-tarball-bytes");
const sha512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** 极简假 fetch：按 URL 命中处理器 */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = routes[url];
    if (!handler) return new Response("not found", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("npm spec 解析", () => {
  test("识别 npm: 前缀（大小写不敏感）并拒绝本地路径", () => {
    expect(isNpmSpec("npm:left-pad@1.0.0")).toBe(true);
    expect(isNpmSpec("NPM:left-pad")).toBe(true);
    expect(isNpmSpec("./plugins/demo")).toBe(false);
    expect(isNpmSpec("https://example.com/a.tgz")).toBe(false);
  });

  test("解析普通包、scoped 包与版本", () => {
    expect(parseNpmSpec("npm:left-pad")).toEqual({ name: "left-pad" });
    expect(parseNpmSpec("npm:left-pad@1.3.0")).toEqual({ name: "left-pad", version: "1.3.0" });
    expect(parseNpmSpec("npm:@scope/name@1.0.0")).toEqual({ name: "@scope/name", version: "1.0.0" });
    expect(parseNpmSpec("npm:@scope/name")).toEqual({ name: "@scope/name" });
  });

  test("非法包名抛 NpmSourceError", () => {
    expect(() => parseNpmSpec("npm:")).toThrow(NpmSourceError);
    expect(() => parseNpmSpec("npm:../evil")).toThrow(NpmSourceError);
    expect(() => parseNpmSpec("npm:has space")).toThrow(NpmSourceError);
  });
});

describe("integrity 校验", () => {
  test("sha512 命中", () => {
    expect(verifyIntegrity(bytes, sha512)).toBe(true);
  });

  test("内容不一致 / 算法未知一律 false", () => {
    expect(verifyIntegrity(Buffer.from("other"), sha512)).toBe(false);
    expect(verifyIntegrity(bytes, "md5-abc")).toBe(false);
    expect(verifyIntegrity(bytes, "not-an-integrity")).toBe(false);
  });
});

describe("registry 解析", () => {
  test("确切版本直接打版本端点（scoped 包名要转义）", async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch({
      "https://registry.npmjs.org/@scope%2Fdemo/1.2.3": () => {
        calls.push("version");
        return jsonResponse({
          name: "@scope/demo",
          version: "1.2.3",
          dist: { tarball: "https://registry.npmjs.org/@scope/demo/-/demo-1.2.3.tgz", integrity: sha512 },
        });
      },
    });
    const info = await resolveNpmVersion("@scope/demo", "1.2.3", { fetchImpl });
    expect(calls).toEqual(["version"]);
    expect(info).toMatchObject({ name: "@scope/demo", version: "1.2.3", integrity: sha512 });
  });

  test("缺省版本走 packument 的 dist-tags.latest", async () => {
    const fetchImpl = fakeFetch({
      "https://registry.npmjs.org/demo": () =>
        jsonResponse({
          name: "demo",
          "dist-tags": { latest: "2.0.0" },
          versions: {
            "2.0.0": { version: "2.0.0", dist: { tarball: "https://x/demo-2.0.0.tgz", shasum: "abc" } },
          },
        }),
    });
    const info = await resolveNpmVersion("demo", undefined, { fetchImpl });
    expect(info).toMatchObject({ version: "2.0.0", tarball: "https://x/demo-2.0.0.tgz", shasum: "abc" });
  });

  test("404 → not_found；缺 tarball → unsupported", async () => {
    const missing = fakeFetch({});
    await expect(resolveNpmVersion("nope", "1.0.0", { fetchImpl: missing })).rejects.toMatchObject({
      code: "not_found",
    });

    const noTarball = fakeFetch({
      "https://registry.npmjs.org/broken/1.0.0": () => jsonResponse({ name: "broken", version: "1.0.0", dist: {} }),
    });
    await expect(resolveNpmVersion("broken", "1.0.0", { fetchImpl: noTarball })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("packument 摘要带全部版本与 latest manifest", async () => {
    const fetchImpl = fakeFetch({
      "https://registry.npmjs.org/demo": () =>
        jsonResponse({
          name: "demo",
          "dist-tags": { latest: "2.0.0" },
          versions: {
            "1.0.0": { version: "1.0.0" },
            "2.0.0": { version: "2.0.0", dsh: { client: {} } },
          },
        }),
    });
    const packument = await fetchNpmPackument("demo", { fetchImpl });
    expect(packument.versions).toEqual(["2.0.0", "1.0.0"]);
    expect(packument.distTags.latest).toBe("2.0.0");
    expect(packument.latestManifest).toMatchObject({ dsh: { client: {} } });
  });
});

describe("tarball 下载", () => {
  let dir: string;

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), "feng-npm-test-"));
    return dir;
  }

  test("integrity 命中则落盘并回传 integrity", async () => {
    const dest = setup();
    try {
      const fetchImpl = fakeFetch({
        "https://x/demo-1.0.0.tgz": () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
      });
      const result = await downloadTarball(
        { name: "demo", version: "1.0.0", tarball: "https://x/demo-1.0.0.tgz", integrity: sha512 },
        dest,
        { fetchImpl },
      );
      expect(result.integrity).toBe(sha512);
      expect(result.size).toBe(bytes.length);
      expect(readFileSync(result.path).equals(bytes)).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("integrity 不匹配即拒（不落盘）", async () => {
    const dest = setup();
    try {
      const fetchImpl = fakeFetch({
        "https://x/demo-1.0.0.tgz": () => new Response(Buffer.from("tampered")),
      });
      await expect(
        downloadTarball(
          { name: "demo", version: "1.0.0", tarball: "https://x/demo-1.0.0.tgz", integrity: sha512 },
          dest,
          { fetchImpl },
        ),
      ).rejects.toMatchObject({ code: "integrity" });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("超过大小上限即拒", async () => {
    const dest = setup();
    try {
      const fetchImpl = fakeFetch({
        "https://x/big-1.0.0.tgz": () => new Response(Buffer.alloc(64)),
      });
      await expect(
        downloadTarball(
          { name: "big", version: "1.0.0", tarball: "https://x/big-1.0.0.tgz" },
          dest,
          { fetchImpl, maxTarballBytes: 8 },
        ),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(DEFAULT_MAX_TARBALL_BYTES).toBeGreaterThan(8);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("只有 shasum 时按 sha1 校验", async () => {
    const dest = setup();
    try {
      const shasum = createHash("sha1").update(bytes).digest("hex");
      const fetchImpl = fakeFetch({ "https://x/a-1.0.0.tgz": () => new Response(bytes) });
      const result = await downloadTarball(
        { name: "a", version: "1.0.0", tarball: "https://x/a-1.0.0.tgz", shasum },
        dest,
        { fetchImpl },
      );
      expect(result.integrity).toBe(`sha1-${shasum}`);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
