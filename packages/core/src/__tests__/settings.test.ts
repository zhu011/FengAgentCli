/**
 * WebUI 设置面（S3）：`settings.json` 读写 + 合并优先级。
 *
 * 只测纯函数与文件语义（真临时目录），不碰进程环境：
 * 所有 `loadConfig` 调用都显式传路径与 `env`，避免读到本机 `~/.fengagent`。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import {
  envLockedKeys,
  applySettingsLayer,
  isLockedByEnv,
  maskSettings,
  readSettings,
  resolveSettingsPath,
  sanitizeSettings,
  writeSettings,
} from "../settings.ts";
import { ConfigSchema } from "../config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-settings-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上偶发占用 — 交给系统清理
  }
});

describe("resolveSettingsPath", () => {
  test("缺省是 ~/.fengagent/settings.json", () => {
    expect(resolveSettingsPath({})).toBe("~/.fengagent/settings.json");
  });

  test("FENG_SETTINGS_FILE 覆盖（空白值不算）", () => {
    expect(resolveSettingsPath({ FENG_SETTINGS_FILE: "C:/tmp/s.json" })).toBe("C:/tmp/s.json");
    expect(resolveSettingsPath({ FENG_SETTINGS_FILE: "   " })).toBe("~/.fengagent/settings.json");
  });
});

describe("readSettings", () => {
  test("文件不存在 → 空设置，无错误", () => {
    const res = readSettings(join(dir, "missing.json"), {});
    expect(res.settings).toEqual({});
    expect(res.error).toBeUndefined();
    expect(res.dropped).toEqual([]);
  });

  test("坏 JSON → 记 error 并降级为空设置（不让整个运行时起不来）", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json", "utf-8");
    const res = readSettings(path, {});
    expect(res.settings).toEqual({});
    expect(res.error).toBeTruthy();
  });

  test("未知键与类型非法的键只丢自己，不连坐整份文件", () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        model: "claude-sonnet-4-20250514",
        temperature: 9, // 超出 0–2
        nonsense: true,
        maxTokens: 4096,
      }),
      "utf-8",
    );
    const res = readSettings(path, {});
    expect(res.settings).toEqual({ model: "claude-sonnet-4-20250514", maxTokens: 4096 });
    expect(res.dropped.sort()).toEqual(["nonsense", "temperature"]);
  });

  test("数组 / null 顶层 → 报错而非崩溃", () => {
    const path = join(dir, "arr.json");
    writeFileSync(path, "[1,2,3]", "utf-8");
    expect(readSettings(path, {}).error).toBeTruthy();
    writeFileSync(path, "null", "utf-8");
    expect(readSettings(path, {}).error).toBeTruthy();
  });
});

describe("writeSettings", () => {
  test("首次写入：带 version、只落给定键、文件是合法 JSON", () => {
    const path = join(dir, "nested", "settings.json");
    const res = writeSettings({ model: "m1", temperature: 0.3 }, { path, env: {} });
    expect(res.written.sort()).toEqual(["model", "temperature"]);
    expect(res.settings).toEqual({ model: "m1", temperature: 0.3 });

    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      version: number;
      settings: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(raw.settings).toEqual({ model: "m1", temperature: 0.3 });
  });

  test("再次写入是合并而非覆盖（保留既有键）", () => {
    const path = join(dir, "settings.json");
    writeSettings({ model: "m1", anthropicApiKey: "sk-ant-123456" }, { path, env: {} });
    const res = writeSettings({ temperature: 0.5 }, { path, env: {} });
    expect(res.settings).toEqual({
      model: "m1",
      anthropicApiKey: "sk-ant-123456",
      temperature: 0.5,
    });
  });

  test("原子写：不留下 .tmp 文件", () => {
    const path = join(dir, "settings.json");
    writeSettings({ model: "m1" }, { path, env: {} });
    expect(existsSync(path)).toBe(true);
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("applySettingsLayer / sanitizeSettings", () => {
  test("设置层覆盖低优先级值，空串视为未设置", () => {
    const base = ConfigSchema.parse({ model: "from-config", temperature: 0.1 });
    const merged = applySettingsLayer(base, {
      model: "from-settings",
      anthropicApiKey: "",
      temperature: 0.7,
    });
    expect(merged.model).toBe("from-settings");
    expect(merged.temperature).toBe(0.7);
    expect(merged.anthropicApiKey).toBeUndefined();
  });

  test("sanitizeSettings 保留合法键、丢弃未知键", () => {
    const { settings, dropped } = sanitizeSettings({ model: "m", bogus: 1 });
    expect(settings).toEqual({ model: "m" });
    expect(dropped).toEqual(["bogus"]);
  });
});

describe("环境变量锁定", () => {
  test("非空环境变量即锁定；空串不锁定", () => {
    expect(isLockedByEnv("model", { FENG_MODEL: "x" })).toBe(true);
    expect(isLockedByEnv("model", { FENG_MODEL: "" })).toBe(false);
    expect(isLockedByEnv("anthropicApiKey", { ANTHROPIC_API_KEY: "sk-1" })).toBe(true);
    expect(isLockedByEnv("openaiApiKey", { ANTHROPIC_API_KEY: "sk-1" })).toBe(false);
  });

  test("envLockedKeys 列全被锁的键", () => {
    const locked = envLockedKeys({ FENG_MODEL: "x", ANTHROPIC_API_KEY: "sk-1" });
    expect(locked.sort()).toEqual(["anthropicApiKey", "model"]);
  });
});

describe("maskSettings", () => {
  test("API Key 打码，其余键原样", () => {
    const view = maskSettings({
      anthropicApiKey: "sk-ant-1234567890",
      model: "claude-sonnet-4-20250514",
      openaiApiKey: "",
    });
    expect(view.anthropicApiKey).toBe("sk-a****");
    expect(view.model).toBe("claude-sonnet-4-20250514");
    expect(view.openaiApiKey).toBe("未配置");
  });
});

describe("loadConfig 优先级：env > settings.json > 配置文件 > 默认", () => {
  const paths = () => ({
    globalConfigPath: join(dir, "global.json"),
    projectConfigPath: join(dir, "project.json"),
    cordisConfigPath: join(dir, "cordis.json"),
    configFilePath: join(dir, "explicit.json"),
    settingsPath: join(dir, "settings.json"),
  });

  test("配置文件 < settings.json", async () => {
    writeFileSync(join(dir, "global.json"), JSON.stringify({ model: "from-config", temperature: 0.1 }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ settings: { model: "from-settings" } }));

    const cfg = await loadConfig(undefined, { ...paths(), env: {} });
    expect(cfg.model).toBe("from-settings");
    // settings 没给的键仍由配置文件提供
    expect(cfg.temperature).toBe(0.1);
  });

  test("settings.json < 环境变量", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ settings: { model: "from-settings" } }));

    const cfg = await loadConfig(undefined, { ...paths(), env: { FENG_MODEL: "from-env" } });
    expect(cfg.model).toBe("from-env");
  });

  test("什么都没有 → 默认值", async () => {
    const cfg = await loadConfig(undefined, { ...paths(), env: {} });
    const defaults = ConfigSchema.parse({});
    expect(cfg.model).toBe(defaults.model);
    expect(cfg.provider).toBe(defaults.provider);
  });

  test("缺 settingsPath 时不读本机设置文件也能起（显式 env 隔离）", async () => {
    const cfg = await loadConfig(undefined, {
      ...paths(),
      settingsPath: join(dir, "absent.json"),
      env: {},
    });
    expect(cfg.model).toBe(ConfigSchema.parse({}).model);
  });
});
