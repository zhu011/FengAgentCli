/**
 * @fengagent/shared — 数据根 + 会话仓解析测试（main 分支语义）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDataRoot, resolveSessionStoreRoot, getLogDir } from "../index.ts";

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

describe("resolveDataRoot（main 语义）", () => {
  test("默认解析为 <workdir>/.fengagent", () => {
    const workdir = makeTempDir();
    expect(resolveDataRoot({ workdir })).toBe(join(resolve(workdir), ".fengagent"));
  });

  test("存在 .fengagent-cordis 时优先于 .fengagent（refactor 遗留目录兼容）", () => {
    const workdir = makeTempDir();
    mkdirSync(join(workdir, ".fengagent-cordis"));
    expect(resolveDataRoot({ workdir })).toBe(join(resolve(workdir), ".fengagent-cordis"));
  });

  test("FENG_DATA_DIR 显式覆盖优先（可经 env 注入）", () => {
    const workdir = makeTempDir();
    const explicit = join(workdir, "custom-data");
    expect(resolveDataRoot({ workdir, env: { FENG_DATA_DIR: explicit } })).toBe(
      resolve(explicit),
    );
  });

  test("日志目录 = 数据根/logs", () => {
    expect(getLogDir()).toBe(join(resolveDataRoot(), "logs"));
  });
});

describe("resolveSessionStoreRoot", () => {
  test("守护进程指定会话仓时以它为准，且优先于 FENG_DATA_DIR", () => {
    const workdir = makeTempDir();
    const designated = join(workdir, "hermes-sessions", "agent", "default", "thread");
    expect(
      resolveSessionStoreRoot({
        workdir,
        env: { MULTICA_DSH_SESSION_ROOT: designated, FENG_DATA_DIR: join(workdir, "data") },
      }),
    ).toBe(resolve(designated));
  });

  test("未指定会话仓时退回 resolveDataRoot（当前生产路径行为不变）", () => {
    const workdir = makeTempDir();
    expect(resolveSessionStoreRoot({ workdir, env: {} })).toBe(
      resolveDataRoot({ workdir, env: {} }),
    );
    // 空串等同于未设置，不得把会话库写到当前目录
    expect(resolveSessionStoreRoot({ workdir, env: { MULTICA_DSH_SESSION_ROOT: "" } })).toBe(
      resolveDataRoot({ workdir, env: {} }),
    );
  });
});
