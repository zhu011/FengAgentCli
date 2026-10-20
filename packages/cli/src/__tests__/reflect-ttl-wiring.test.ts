/**
 * @fengagent/cli — `FENG_REFLECT_TTL_MS` 接线测试（RSI 小缺陷修复）
 *
 * 缺陷：该变量只被 `resolveReflectBudget()` 解析，三处装配点仍用库内 14 天常量，
 * 于是改环境变量不改变卡片存活期。这里从**真实装配根**（`createRuntimeAgent`）
 * 造卡，断言入库卡片的存活期就是环境变量给定的值。
 *
 * 不发网络请求：只用到装配阶段的卡片仓，模型地址指向本机不可用端口无妨。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeAgent } from "@fengagent/server";
import type { ReflectionStore } from "@fengagent/agent";
import type { ReflectionCard } from "@fengagent/core";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-reflect-ttl-"));
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
  tempDirs.length = 0;
});

/** 装配所需的模型环境（地址不可用也没关系：本测试不发 LLM 请求） */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    FENG_PROVIDER: "openai-compatible",
    FENG_MODEL: "model-a",
    OPENAI_COMPATIBLE_API_KEY: "sk-test-reflect-ttl",
    OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1",
    OPENAI_COMPATIBLE_MODEL: "model-a",
    ...extra,
  };
}

/** 造一张带证据的卡（证据门要求） */
function createCard(store: ReflectionStore): ReflectionCard {
  return store.create({
    trigger: "judge_failed",
    lesson: "TTL 接线验证：存活期应当来自 FENG_REFLECT_TTL_MS",
    evidence: [{ kind: "trace", ref: "ttl-wiring-trace" }],
  });
}

/** 卡片存活期（毫秒） */
function ttlOf(card: ReflectionCard): number {
  return (card.expiresAt ?? 0) - card.createdAt;
}

describe("FENG_REFLECT_TTL_MS — 装配点接线", () => {
  test("改环境变量就改变卡片存活期（不再只解析不生效）", async () => {
    const workdir = makeTempDir();
    const result = await createRuntimeAgent({
      env: baseEnv({ FENG_REFLECT_TTL_MS: "60000" }),
      workdir,
      cliArgs: { dataDir: workdir },
    });

    expect(result.reflectionStore).not.toBeNull();
    const card = createCard(result.reflectionStore!);
    expect(ttlOf(card)).toBe(60000);
    result.reflectionStore!.close();
  });

  test("未设置时保持 14 天默认（不回归）", async () => {
    const workdir = makeTempDir();
    const result = await createRuntimeAgent({
      env: baseEnv(),
      workdir,
      cliArgs: { dataDir: workdir },
    });

    const card = createCard(result.reflectionStore!);
    expect(ttlOf(card)).toBe(14 * 24 * 60 * 60 * 1000);
    result.reflectionStore!.close();
  });

  test("非法值回退 14 天默认（不把卡片写成不过期）", async () => {
    const workdir = makeTempDir();
    const result = await createRuntimeAgent({
      env: baseEnv({ FENG_REFLECT_TTL_MS: "not-a-number" }),
      workdir,
      cliArgs: { dataDir: workdir },
    });

    const card = createCard(result.reflectionStore!);
    expect(ttlOf(card)).toBe(14 * 24 * 60 * 60 * 1000);
    result.reflectionStore!.close();
  });
});
