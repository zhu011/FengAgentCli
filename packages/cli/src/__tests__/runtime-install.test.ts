/**
 * @fengagent/cli — Multica 运行时注册 / 项目凭据补齐测试
 *
 * 覆盖「Multica 每次对话都在全新空工作目录里拉起运行时」这一场景的修复：
 * 注册时应把项目级凭据补齐到全局配置，使凭据在任何工作目录可见。
 *
 * 注意：测试通过临时 HOME/USERPROFILE 隔离，绝不触碰真实用户目录。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readConfigFileSync } from "@fengagent/core";
import {
  installRuntimeRegistration,
  readProjectCredentials,
  runtimeRegistrationPath,
} from "../runtime-install.ts";

let tempDirs: string[] = [];
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  const home = makeTempDir("feng-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
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
// readProjectCredentials
// ──────────────────────────────────────────────

describe("readProjectCredentials", () => {
  test("合并项目级与分支级配置，分支级优先", () => {
    const projectDir = makeTempDir("feng-proj-");
    writeJson(join(projectDir, ".fengagent", "config.json"), {
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-project",
      dataDir: ".fengagent-cordis",
    });
    writeJson(join(projectDir, ".fengagent-cordis", "config.json"), {
      model: "deepseek-v4-pro",
    });

    const merged = readProjectCredentials(projectDir);

    expect(merged.provider).toBe("openai-compatible");
    expect(merged.openaiCompatibleApiKey).toBe("sk-project");
    expect(merged.model).toBe("deepseek-v4-pro");
  });

  test("分支级同名键覆盖项目级", () => {
    const projectDir = makeTempDir("feng-proj-");
    writeJson(join(projectDir, ".fengagent", "config.json"), { model: "from-project" });
    writeJson(join(projectDir, ".fengagent-cordis", "config.json"), {
      model: "from-cordis",
    });

    expect(readProjectCredentials(projectDir).model).toBe("from-cordis");
  });

  test("配置文件缺失时返回空对象", () => {
    const projectDir = makeTempDir("feng-proj-");
    expect(readProjectCredentials(projectDir)).toEqual({});
  });
});

// ──────────────────────────────────────────────
// installRuntimeRegistration — 凭据补齐
// ──────────────────────────────────────────────

describe("installRuntimeRegistration 凭据补齐", () => {
  test("把项目凭据写入全局配置，使空工作目录的运行时也能解析", () => {
    const projectDir = makeTempDir("feng-proj-");
    const globalPath = join(makeTempDir("feng-global-"), "config.json");
    writeJson(join(projectDir, ".fengagent", "config.json"), {
      provider: "openai-compatible",
      openaiCompatibleApiKey: "sk-project",
      openaiCompatibleBaseUrl: "https://example.com/v1",
      model: "deepseek-v4-pro",
      dataDir: ".fengagent-cordis",
    });

    const result = installRuntimeRegistration({
      projectDir,
      globalConfigPath: globalPath,
    });

    expect(result.file).toBe(runtimeRegistrationPath());
    expect(result.registration.launchHeader).toBe("fengagent acp");
    expect(result.credentials).not.toBeNull();
    expect(result.credentials!.path).toBe(globalPath);
    expect(result.credentials!.keys).toContain("openaiCompatibleApiKey");

    const global = readConfigFileSync(globalPath);
    expect(global.provider).toBe("openai-compatible");
    expect(global.openaiCompatibleApiKey).toBe("sk-project");
    expect(global.openaiCompatibleBaseUrl).toBe("https://example.com/v1");
    // 工作目录相关键不进入全局配置
    expect("dataDir" in global).toBe(false);
  });

  test("seedGlobalConfig=false 时不写全局配置（opt-out）", () => {
    const projectDir = makeTempDir("feng-proj-");
    const globalPath = join(makeTempDir("feng-global-"), "config.json");
    writeJson(join(projectDir, ".fengagent", "config.json"), {
      openaiCompatibleApiKey: "sk-project",
    });

    const result = installRuntimeRegistration({
      projectDir,
      globalConfigPath: globalPath,
      seedGlobalConfig: false,
    });

    expect(result.credentials).toBeNull();
    expect(readConfigFileSync(globalPath)).toEqual({});
  });

  test("全局配置已有凭据时不覆盖（只补缺失键）", () => {
    const projectDir = makeTempDir("feng-proj-");
    const globalPath = join(makeTempDir("feng-global-"), "config.json");
    writeJson(globalPath, { anthropicApiKey: "sk-existing", provider: "anthropic" });
    writeJson(join(projectDir, ".fengagent", "config.json"), {
      provider: "openai-compatible",
      anthropicApiKey: "sk-from-project",
      openaiCompatibleApiKey: "sk-new",
    });

    installRuntimeRegistration({ projectDir, globalConfigPath: globalPath });

    const global = readConfigFileSync(globalPath);
    expect(global.anthropicApiKey).toBe("sk-existing");
    expect(global.provider).toBe("anthropic");
    expect(global.openaiCompatibleApiKey).toBe("sk-new");
  });

  test("项目无凭据时 credentials 为 null", () => {
    const projectDir = makeTempDir("feng-proj-");
    const globalPath = join(makeTempDir("feng-global-"), "config.json");
    writeJson(join(projectDir, ".fengagent", "config.json"), { dataDir: "data" });

    const result = installRuntimeRegistration({ projectDir, globalConfigPath: globalPath });

    expect(result.credentials).toBeNull();
    expect(readConfigFileSync(globalPath)).toEqual({});
  });
});
