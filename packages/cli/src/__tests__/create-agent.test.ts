/**
 * @fengagent/cli — createAgent / reloadProvider 热替换机制测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, reloadProvider } from "../create-agent.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-agent-reload-"));
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

describe("reloadProvider（/provider set 热加载机制）", () => {
  test("热替换 LLM Client 并原地更新 Agent 配置", async () => {
    const dataDir = makeTempDir();
    const env = {
      FENG_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_API_KEY: "sk-original",
      OPENAI_COMPATIBLE_BASE_URL: "https://api.original.com",
      OPENAI_COMPATIBLE_MODEL: "model-a",
      FENG_MAX_TOKENS: "1024",
    };

    const result = await createAgent({
      env,
      cliArgs: { dataDir },
      enableSessionStore: false,
      workdir: process.cwd(),
    });

    const originalClient = result.llmClient.getClient();
    const agentConfigRef = result.agent.getConfig();

    const newConfig = reloadProvider({
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-new-key-123456",
      openaiCompatibleBaseUrl: "https://api.new.com",
      openaiCompatibleModel: "model-b",
      model: "model-b",
    });

    expect(newConfig).not.toBeNull();
    expect(newConfig!.openaiCompatibleApiKey).toBe("sk-new-key-123456");
    expect(newConfig!.openaiCompatibleBaseUrl).toBe("https://api.new.com");
    expect(newConfig!.model).toBe("model-b");

    // Agent 持有的 Config 是同一引用 — 原地更新后 getConfig() 立即反映新值
    expect(agentConfigRef.openaiCompatibleApiKey).toBe("sk-new-key-123456");
    expect(result.config.openaiCompatibleApiKey).toBe("sk-new-key-123456");

    // 底层 LLM Client 已被替换（热加载），Agent 无需重建
    expect(result.llmClient.getClient()).not.toBe(originalClient);
    expect(originalClient).toBeDefined();
  });
});
