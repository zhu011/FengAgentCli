/**
 * @fengagent/shared — 数据根解析 + main 数据单向导入测试（Phase 0）
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveDataRoot,
  resolveLogsDir,
  resolveMainDataRoots,
  importMainData,
  IMPORT_MARKER_FILE,
  expandTilde,
} from "../index.ts";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-data-root-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

describe("resolveDataRoot", () => {
  test("默认解析为 <workdir>/.fengagent-cordis（新分支数据根）", () => {
    const workdir = makeTempDir();
    expect(resolveDataRoot({ workdir })).toBe(join(resolve(workdir), ".fengagent-cordis"));
  });

  test("FENG_DATA_DIR 显式覆盖优先", () => {
    const workdir = makeTempDir();
    const explicit = join(workdir, "custom-data");
    expect(resolveDataRoot({ workdir, env: { FENG_DATA_DIR: explicit } })).toBe(
      resolve(explicit),
    );
  });

  test("配置文件中自定义 dataDir 次之（非默认值）", () => {
    const workdir = makeTempDir();
    const custom = join(workdir, "my-data");
    expect(
      resolveDataRoot({ workdir, configDataDir: custom }),
    ).toBe(resolve(custom));
  });

  test("配置文件 dataDir 为默认值时忽略，回落 workdir 默认", () => {
    const workdir = makeTempDir();
    expect(
      resolveDataRoot({ workdir, configDataDir: ".fengagent-cordis" }),
    ).toBe(join(resolve(workdir), ".fengagent-cordis"));
  });

  test("resolveLogsDir = <数据根>/logs", () => {
    const workdir = makeTempDir();
    expect(resolveLogsDir({ workdir })).toBe(
      join(resolve(workdir), ".fengagent-cordis", "logs"),
    );
  });
});

describe("resolveMainDataRoots", () => {
  test("探测顺序：FENG_MAIN_DATA_DIR → workdir/.fengagent → ~/.fengagent → workdir/data", () => {
    const workdir = makeTempDir();
    const explicit = join(workdir, "main-root");
    const roots = resolveMainDataRoots({ workdir, env: { FENG_MAIN_DATA_DIR: explicit } });
    expect(roots[0]).toBe(resolve(explicit));
    expect(roots[1]).toBe(join(resolve(workdir), ".fengagent"));
    expect(roots[2]).toBe(expandTilde("~/.fengagent"));
    expect(roots[3]).toBe(join(resolve(workdir), "data"));
  });
});

describe("importMainData（单向、幂等、只读）", () => {
  test("首次运行从 main 根复制 sessions.db + graph.jsonl 并写 import.marker", () => {
    const workdir = makeTempDir();
    const mainRoot = join(workdir, ".fengagent");
    mkdirSync(mainRoot, { recursive: true });
    writeFileSync(join(mainRoot, "sessions.db"), "sqlite-bytes");
    writeFileSync(join(mainRoot, "graph.jsonl"), '{"node":1}\n');

    const result = importMainData({ workdir });
    expect(result.imported).toBe(true);
    expect(result.reason).toBe("imported");
    expect(result.copiedFiles.sort()).toEqual(["graph.jsonl", "sessions.db"]);

    const dataRoot = join(resolve(workdir), ".fengagent-cordis");
    expect(result.dataRoot).toBe(dataRoot);
    expect(readFileSync(join(dataRoot, "sessions.db"), "utf-8")).toBe("sqlite-bytes");
    expect(readFileSync(join(dataRoot, "graph.jsonl"), "utf-8")).toBe('{"node":1}\n');

    // marker 记录来源根 + 时间 + 导入文件数
    const marker = JSON.parse(
      readFileSync(join(dataRoot, IMPORT_MARKER_FILE), "utf-8"),
    ) as { version: number; sourceRoot: string; importedAt: string; fileCount: number; files: string[] };
    expect(marker.version).toBe(1);
    expect(marker.sourceRoot).toBe(resolve(mainRoot));
    expect(marker.fileCount).toBe(2);
    expect(marker.files.sort()).toEqual(["graph.jsonl", "sessions.db"]);
    expect(Number.isNaN(Date.parse(marker.importedAt))).toBe(false);
  });

  test("幂等：已有 import.marker 时跳过（marker-skipped）", () => {
    const workdir = makeTempDir();
    const mainRoot = join(workdir, ".fengagent");
    mkdirSync(mainRoot, { recursive: true });
    writeFileSync(join(mainRoot, "sessions.db"), "v1");

    const first = importMainData({ workdir });
    expect(first.imported).toBe(true);

    // main 数据变化后再次导入 — 不应重新复制
    writeFileSync(join(mainRoot, "sessions.db"), "v2-changed");
    const second = importMainData({ workdir });
    expect(second.imported).toBe(false);
    expect(second.reason).toBe("marker-skipped");
    expect(second.marker?.fileCount).toBe(1);

    const dataRoot = join(resolve(workdir), ".fengagent-cordis");
    expect(readFileSync(join(dataRoot, "sessions.db"), "utf-8")).toBe("v1");
  });

  test("无 main 数据源时返回 no-source 且不创建数据根文件", () => {
    const workdir = makeTempDir();
    const fakeHome = makeTempDir(); // 空 HOME → 无任何候选含数据
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = importMainData({ workdir });
      expect(result.imported).toBe(false);
      expect(result.reason).toBe("no-source");
    } finally {
      process.env.HOME = savedHome;
    }
  });

  test("自环防护：FENG_DATA_DIR 指向 main 根时跳过导入（self-loop-excluded）", () => {
    const workdir = makeTempDir();
    const mainRoot = join(workdir, ".fengagent");
    mkdirSync(mainRoot, { recursive: true });
    writeFileSync(join(mainRoot, "sessions.db"), "sqlite-bytes");

    // FENG_DATA_DIR 显式指向 main 根 → 数据根自身被排除，绝不写入 main 目录
    const result = importMainData({ workdir, env: { FENG_DATA_DIR: mainRoot } });
    expect(result.imported).toBe(false);
    expect(result.reason).toBe("self-loop-excluded");
    expect(existsSync(join(mainRoot, IMPORT_MARKER_FILE))).toBe(false);
    // main 数据未被改动
    expect(readFileSync(join(mainRoot, "sessions.db"), "utf-8")).toBe("sqlite-bytes");
  });

  test("自环防护：FENG_DATA_DIR 指向 ~/.fengagent 时跳过导入", () => {
    const workdir = makeTempDir();
    const homeRoot = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".fengagent");
    const result = importMainData({
      workdir,
      env: { FENG_DATA_DIR: homeRoot, FENG_MAIN_DATA_DIR: homeRoot },
    });
    expect(result.imported).toBe(false);
    expect(result.reason).toBe("self-loop-excluded");
  });

  test("FENG_MAIN_DATA_DIR 显式指定导入源", () => {
    const workdir = makeTempDir();
    const explicitMain = join(workdir, "legacy-root");
    mkdirSync(explicitMain, { recursive: true });
    writeFileSync(join(explicitMain, "graph.jsonl"), "legacy-graph");

    const result = importMainData({ workdir, env: { FENG_MAIN_DATA_DIR: explicitMain } });
    expect(result.imported).toBe(true);
    expect(result.marker?.sourceRoot).toBe(resolve(explicitMain));
    expect(result.copiedFiles).toEqual(["graph.jsonl"]);
  });

  test("探测优先 workdir/.fengagent（首个含数据者胜）", () => {
    const workdir = makeTempDir();
    const mainRoot = join(workdir, ".fengagent");
    mkdirSync(mainRoot, { recursive: true });
    writeFileSync(join(mainRoot, "sessions.db"), "project-sessions");
    // ~/.fengagent 也存在（真实环境）— 但 workdir 级优先

    const result = importMainData({ workdir });
    expect(result.imported).toBe(true);
    expect(result.marker?.sourceRoot).toBe(resolve(mainRoot));
  });
});
