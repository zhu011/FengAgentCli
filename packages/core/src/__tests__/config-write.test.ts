/**
 * @fengagent/core — 配置持久化 / API Key 打码测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskApiKey, writeConfigFile, readConfigFileSync } from "../config.ts";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-config-test-"));
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

describe("maskApiKey", () => {
  test("空值返回未配置", () => {
    expect(maskApiKey(undefined)).toBe("未配置");
    expect(maskApiKey("")).toBe("未配置");
    expect(maskApiKey(null)).toBe("未配置");
  });

  test("短 Key（<=4 位）返回 ****", () => {
    expect(maskApiKey("ab")).toBe("****");
    expect(maskApiKey("abcd")).toBe("****");
  });

  test("只保留前 4 位 + ****，不泄露其余明文", () => {
    const key = "sk-ant-0123456789abcdef";
    const masked = maskApiKey(key);
    expect(masked).toBe("sk-a****");
    expect(masked).not.toContain("0123456789");
    expect(masked).not.toContain(key);
  });

  test("DeepSeek 格式 Key 打码", () => {
    expect(maskApiKey("sk-1349d75cc2a14d53af7880718d694200")).toBe("sk-1****");
  });
});

describe("writeConfigFile", () => {
  test("写入项目级配置并保留已有键（deepMerge）", () => {
    const dir = makeTempDir();
    const configPath = join(dir, ".fengagent", "config.json");

    // 先写入一部分配置
    const first = writeConfigFile(
      { provider: "openai-compatible", contextWindow: 200000, model: "deepseek-v4-pro" },
      { path: configPath },
    );
    expect(first).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);

    // 再写入 provider 补丁 — 其他键必须保留
    writeConfigFile(
      { openaiCompatibleApiKey: "sk-secret123456", openaiCompatibleBaseUrl: "https://api.deepseek.com" },
      { path: configPath },
    );

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(raw["provider"]).toBe("openai-compatible");
    expect(raw["contextWindow"]).toBe(200000);
    expect(raw["openaiCompatibleApiKey"]).toBe("sk-secret123456");
    expect(raw["openaiCompatibleBaseUrl"]).toBe("https://api.deepseek.com");
  });

  test("写入后可被 readConfigFileSync 读回", () => {
    const dir = makeTempDir();
    const configPath = join(dir, "cfg.json");
    writeConfigFile({ provider: "anthropic", anthropicApiKey: "sk-ant-xyz" }, { path: configPath });
    const read = readConfigFileSync(configPath);
    expect(read["provider"]).toBe("anthropic");
    expect(read["anthropicApiKey"]).toBe("sk-ant-xyz");
  });

  test("不存在的文件读取返回空对象", () => {
    expect(readConfigFileSync(join(makeTempDir(), "nope.json"))).toEqual({});
  });
});
