/**
 * @fengagent/core — 跨工作目录凭据解析测试
 *
 * 覆盖：
 * - FENG_CONFIG_FILE / configFilePath 显式配置层（cwd 之外的最后兜底）
 * - 可移植凭据提取与 Provider 凭据完备性判断
 * - 项目凭据「补齐」到全局配置（只补缺失键，不覆盖已有值）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PORTABLE_CREDENTIAL_KEYS,
  extractPortableCredentials,
  hasProviderCredentials,
  loadConfig,
  promoteCredentialsToGlobal,
  readConfigFileSync,
} from "../config.ts";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-portable-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** 所有路径都显式指定，避免读到真实用户主目录 */
function isolatedPaths(dir: string) {
  return {
    globalConfigPath: join(dir, "global", "config.json"),
    projectConfigPath: join(dir, "project", "config.json"),
    cordisConfigPath: join(dir, "cordis", "config.json"),
  };
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

// ──────────────────────────────────────────────
// extractPortableCredentials
// ──────────────────────────────────────────────

describe("extractPortableCredentials", () => {
  test("只保留凭据/模型类键，丢掉工作目录相关键", () => {
    const patch = extractPortableCredentials({
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-secret",
      openaiCompatibleBaseUrl: "https://example.com/v1",
      model: "deepseek-v4-pro",
      dataDir: ".fengagent-cordis",
      serverPort: 4321,
      autoApproveTools: true,
    });

    expect(patch.provider).toBe("openai-compatible");
    expect(patch.openaiCompatibleApiKey).toBe("sk-secret");
    expect(patch.openaiCompatibleBaseUrl).toBe("https://example.com/v1");
    expect(patch.model).toBe("deepseek-v4-pro");
    // 工作目录相关键不参与「提升」
    expect("dataDir" in patch).toBe(false);
    expect("serverPort" in patch).toBe(false);
    expect("autoApproveTools" in patch).toBe(false);
  });

  test("忽略 undefined / null / 空串", () => {
    const patch = extractPortableCredentials({
      provider: "anthropic",
      anthropicApiKey: "",
      openaiApiKey: undefined,
    });
    expect(patch.provider).toBe("anthropic");
    expect("anthropicApiKey" in patch).toBe(false);
    expect("openaiApiKey" in patch).toBe(false);
  });

  test("PORTABLE_CREDENTIAL_KEYS 不含 dataDir / 端口 / 权限键", () => {
    const keys = PORTABLE_CREDENTIAL_KEYS as readonly string[];
    expect(keys).not.toContain("dataDir");
    expect(keys).not.toContain("serverPort");
    expect(keys).not.toContain("allowedTools");
  });
});

// ──────────────────────────────────────────────
// hasProviderCredentials
// ──────────────────────────────────────────────

describe("hasProviderCredentials", () => {
  test("openai-compatible 需要 key + baseUrl", () => {
    expect(
      hasProviderCredentials({ provider: "openai-compatible", openaiCompatibleApiKey: "k" }),
    ).toBe(false);
    expect(
      hasProviderCredentials({
        provider: "openai-compatible",
        openaiCompatibleApiKey: "k",
        openaiCompatibleBaseUrl: "https://example.com/v1",
      }),
    ).toBe(true);
  });

  test("anthropic / openai / google 按各自 key 判断", () => {
    expect(hasProviderCredentials({ provider: "anthropic" })).toBe(false);
    expect(hasProviderCredentials({ provider: "anthropic", anthropicApiKey: "k" })).toBe(true);
    expect(hasProviderCredentials({ provider: "openai", openaiApiKey: "k" })).toBe(true);
    expect(hasProviderCredentials({ provider: "google", googleApiKey: "k" })).toBe(true);
  });

  test("bedrock 凭据由 AWS 环境变量提供，视为完备", () => {
    expect(hasProviderCredentials({ provider: "bedrock" })).toBe(true);
  });

  test("未知 provider 视为不完备", () => {
    expect(hasProviderCredentials({ provider: "whatever" })).toBe(false);
  });
});

// ──────────────────────────────────────────────
// promoteCredentialsToGlobal
// ──────────────────────────────────────────────

describe("promoteCredentialsToGlobal", () => {
  test("全局配置不存在时写入项目凭据", () => {
    const dir = makeTempDir();
    const globalPath = join(dir, "global", "config.json");

    const result = promoteCredentialsToGlobal(
      {
        provider: "openai-compatible",
        openaiCompatibleApiKey: "sk-secret",
        openaiCompatibleBaseUrl: "https://example.com/v1",
        dataDir: ".fengagent-cordis",
      },
      { globalPath },
    );

    expect(result).not.toBeNull();
    expect(result!.path).toBe(globalPath);
    expect(result!.keys).toContain("openaiCompatibleApiKey");

    const written = readConfigFileSync(globalPath);
    expect(written.provider).toBe("openai-compatible");
    expect(written.openaiCompatibleApiKey).toBe("sk-secret");
    // 工作目录相关键不落全局
    expect("dataDir" in written).toBe(false);
  });

  test("只补齐缺失键，不覆盖全局配置中已有的值", () => {
    const dir = makeTempDir();
    const globalPath = join(dir, "global", "config.json");
    writeJson(globalPath, {
      provider: "anthropic",
      anthropicApiKey: "sk-existing",
    });

    promoteCredentialsToGlobal(
      {
        provider: "openai-compatible",
        anthropicApiKey: "sk-from-project",
        openaiCompatibleApiKey: "sk-project-compat",
      },
      { globalPath },
    );

    const written = readConfigFileSync(globalPath);
    // 已有键保持不动
    expect(written.provider).toBe("anthropic");
    expect(written.anthropicApiKey).toBe("sk-existing");
    // 缺失键被补齐
    expect(written.openaiCompatibleApiKey).toBe("sk-project-compat");
  });

  test("无新键可写时返回 null（不触碰文件）", () => {
    const dir = makeTempDir();
    const globalPath = join(dir, "global", "config.json");
    writeJson(globalPath, { openaiCompatibleApiKey: "sk-existing" });

    const result = promoteCredentialsToGlobal(
      { openaiCompatibleApiKey: "sk-project" },
      { globalPath },
    );
    expect(result).toBeNull();
    expect(readConfigFileSync(globalPath).openaiCompatibleApiKey).toBe("sk-existing");
  });

  test("来源为空时返回 null", () => {
    const dir = makeTempDir();
    expect(
      promoteCredentialsToGlobal({ dataDir: ".fengagent-cordis" }, {
        globalPath: join(dir, "global", "config.json"),
      }),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────
// loadConfig — 显式配置层（FENG_CONFIG_FILE）
// ──────────────────────────────────────────────

describe("loadConfig 显式配置层", () => {
  test("FENG_CONFIG_FILE 指向的配置在空工作目录下也能解析出凭据", async () => {
    const dir = makeTempDir();
    const explicitPath = join(dir, "shared", "config.json");
    writeJson(explicitPath, {
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-explicit",
      openaiCompatibleBaseUrl: "https://example.com/v1",
      model: "deepseek-v4-pro",
    });

    const config = await loadConfig(undefined, {
      ...isolatedPaths(dir),
      env: { FENG_CONFIG_FILE: explicitPath },
    });

    expect(config.provider).toBe("openai-compatible");
    expect(config.openaiCompatibleApiKey).toBe("sk-explicit");
    expect(config.openaiCompatibleBaseUrl).toBe("https://example.com/v1");
    expect(hasProviderCredentials(config)).toBe(true);
  });

  test("configFilePath 选项与 FENG_CONFIG_FILE 等价", async () => {
    const dir = makeTempDir();
    const explicitPath = join(dir, "shared", "config.json");
    writeJson(explicitPath, { anthropicApiKey: "sk-opt", provider: "anthropic" });

    const config = await loadConfig(undefined, {
      ...isolatedPaths(dir),
      configFilePath: explicitPath,
      env: {},
    });

    expect(config.anthropicApiKey).toBe("sk-opt");
  });

  test("显式配置层优先于项目/分支配置，但低于 FENG_* 环境变量", async () => {
    const dir = makeTempDir();
    const paths = isolatedPaths(dir);
    const explicitPath = join(dir, "shared", "config.json");

    writeJson(paths.projectConfigPath, { model: "from-project", temperature: 0.5 });
    writeJson(paths.cordisConfigPath, { model: "from-cordis" });
    writeJson(explicitPath, { model: "from-explicit", provider: "openai" });

    const config = await loadConfig(undefined, {
      ...paths,
      configFilePath: explicitPath,
      env: { FENG_MODEL: "from-env" },
    });

    // 环境变量最高
    expect(config.model).toBe("from-env");
    // 显式层覆盖项目/分支层
    expect(config.provider).toBe("openai");
    // 低层未被覆盖的键保留
    expect(config.temperature).toBe(0.5);
  });

  test("文件不存在时显式层静默跳过", async () => {
    const dir = makeTempDir();
    const config = await loadConfig(undefined, {
      ...isolatedPaths(dir),
      configFilePath: join(dir, "missing", "config.json"),
      env: {},
    });
    expect(config.provider).toBe("anthropic");
  });

  test("全局配置层仍然生效（cwd 无关的凭据来源）", async () => {
    const dir = makeTempDir();
    const paths = isolatedPaths(dir);
    writeJson(paths.globalConfigPath, {
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-global",
      openaiCompatibleBaseUrl: "https://example.com/v1",
    });

    const config = await loadConfig(undefined, { ...paths, env: {} });

    expect(config.openaiCompatibleApiKey).toBe("sk-global");
    expect(hasProviderCredentials(config)).toBe(true);
  });
});
