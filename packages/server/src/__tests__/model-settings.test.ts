/**
 * 模型设置服务（S3）：读生效值 / 写 settings.json / 热切换。
 *
 * 用真 `loadConfig`（所有路径都指到临时目录）与实际一致的「重载 → 热切换」
 * 顺序，避免只测桩、测不出优先级错误。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, loadConfig, type Config, type PartialConfig } from "@fengagent/core";
import { createModelSettingsService, ModelSettingsError } from "../model-settings.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feng-model-settings-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 占用 — 交给系统清理
  }
});

interface Harness {
  service: ReturnType<typeof createModelSettingsService>;
  applied: PartialConfig[];
  settingsPath: string;
  getConfig: () => Config;
}

/**
 * 造一个与生产同构的服务：配置初值 → reload 走真 loadConfig（临时路径 +
 * 显式 env）→ apply 就地更新配置（等价于 reloadProvider）。
 */
function makeHarness(options?: {
  env?: Record<string, string | undefined>;
  config?: Record<string, unknown>;
}): Harness {
  const env = options?.env ?? {};
  const settingsPath = join(dir, "settings.json");
  let config = ConfigSchema.parse({ anthropicApiKey: "sk-ant-abcdefgh", ...options?.config });
  const applied: PartialConfig[] = [];

  const service = createModelSettingsService({
    getConfig: () => config,
    settingsPath,
    env,
    reload: () =>
      loadConfig(undefined, {
        globalConfigPath: join(dir, "global.json"),
        projectConfigPath: join(dir, "project.json"),
        cordisConfigPath: join(dir, "cordis.json"),
        configFilePath: join(dir, "explicit.json"),
        settingsPath,
        env,
      }),
    apply: (patch) => {
      applied.push(patch);
      config = ConfigSchema.parse({ ...config, ...patch });
    },
  });

  return { service, applied, settingsPath, getConfig: () => config };
}

describe("get()", () => {
  test("空设置文件：全部键来自配置层，敏感键打码", () => {
    const { service } = makeHarness();
    const snap = service.get();

    expect(snap.persisted).toEqual({});
    expect(snap.sources.model).toBe("config");
    expect(snap.sources.provider).toBe("config");
    expect(snap.settings.anthropicApiKey).toBe("sk-a****");
    expect(JSON.stringify(snap)).not.toContain("sk-ant-abcdefgh");
    expect(snap.active.provider).toBe("anthropic");
    expect(snap.overridden).toEqual([]);
    expect(snap.warnings).toEqual([]);
  });

  test("坏设置文件：给 warning 但仍然返回生效配置", () => {
    const { service, settingsPath } = makeHarness();
    writeFileSync(settingsPath, "{oops", "utf-8");

    const snap = service.get();
    expect(snap.warnings.join()).toContain("解析失败");
    expect(snap.active.model).toBe(ConfigSchema.parse({}).model);
  });

  test("环境变量锁定的键单独列出", () => {
    const { service } = makeHarness({ env: { FENG_MODEL: "env-model" } });
    const snap = service.get();
    expect(snap.envLocked).toContain("model");
    expect(snap.sources.model).toBe("env");
  });
});

describe("patch()", () => {
  test("落盘 + 生效 + 热切换一次", async () => {
    const { service, applied, settingsPath } = makeHarness();

    const result = await service.patch({ model: "claude-opus-4-20250514", temperature: 0.4 });

    expect(result.written.sort()).toEqual(["model", "temperature"]);
    expect(result.overridden).toEqual([]);
    expect(result.applyError).toBeUndefined();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.model).toBe("claude-opus-4-20250514");

    expect(result.snapshot.active.model).toBe("claude-opus-4-20250514");
    expect(result.snapshot.active.temperature).toBe(0.4);
    expect(result.snapshot.sources.model).toBe("settings");
    expect(result.snapshot.persisted.model).toBe("claude-opus-4-20250514");

    // 文件真的是持久化来源：再读一次仍然是新值
    const again = service.get();
    expect(again.active.model).toBe("claude-opus-4-20250514");
    expect(again.persisted.model).toBe("claude-opus-4-20250514");
    expect(again.settingsPath).toBe(settingsPath);
  });

  test("被环境变量覆盖：照样落盘，但回告 overridden 且生效值仍是环境变量", async () => {
    const { service } = makeHarness({ env: { FENG_MODEL: "env-model" } });

    const result = await service.patch({ model: "ui-model" });

    expect(result.written).toEqual(["model"]);
    expect(result.overridden).toEqual(["model"]);
    expect(result.snapshot.active.model).toBe("env-model");
    expect(result.snapshot.persisted.model).toBe("ui-model");
  });

  test("Provider 切换落盘并热切换", async () => {
    const { service, applied } = makeHarness();
    const result = await service.patch({ provider: "openai", openaiApiKey: "sk-openai-xyz" });

    expect(result.written.sort()).toEqual(["openaiApiKey", "provider"]);
    expect(applied[0]?.provider).toBe("openai");
    expect(result.snapshot.active.provider).toBe("openai");
    // 新凭据同样打码
    expect(JSON.stringify(result.snapshot)).not.toContain("sk-openai-xyz");
    expect(result.snapshot.settings.openaiApiKey).toBe("sk-o****");
  });

  test("未知键 → bad_request（拼错键名不能装作成功）", async () => {
    const { service } = makeHarness();
    await expect(service.patch({ modal: "typo" })).rejects.toBeInstanceOf(ModelSettingsError);
  });

  test("类型越界 → bad_request", async () => {
    const { service } = makeHarness();
    await expect(service.patch({ temperature: 9 })).rejects.toThrow(/temperature/);
    await expect(service.patch({ maxTokens: -1 })).rejects.toBeInstanceOf(ModelSettingsError);
  });

  test("未知 Provider → bad_request，且不落盘", async () => {
    const { service } = makeHarness();
    await expect(service.patch({ provider: "no-such" })).rejects.toThrow(/未知 Provider/);
    expect(service.get().persisted).toEqual({});
  });

  test("空 body / 非对象 → bad_request", async () => {
    const { service } = makeHarness();
    await expect(service.patch({})).rejects.toBeInstanceOf(ModelSettingsError);
    await expect(service.patch([])).rejects.toBeInstanceOf(ModelSettingsError);
    await expect(service.patch(null)).rejects.toBeInstanceOf(ModelSettingsError);
  });

  test("热切换失败不丢设置：报 applyError，文件仍在", async () => {
    const settingsPath = join(dir, "settings.json");
    let config = ConfigSchema.parse({});
    const service = createModelSettingsService({
      getConfig: () => config,
      settingsPath,
      env: {},
      reload: () =>
        loadConfig(undefined, {
          globalConfigPath: join(dir, "global.json"),
          projectConfigPath: join(dir, "project.json"),
          cordisConfigPath: join(dir, "cordis.json"),
          settingsPath,
          env: {},
        }),
      apply: () => {
        throw new Error("client rebuild failed");
      },
    });

    const result = await service.patch({ model: "m2" });
    expect(result.applyError).toContain("client rebuild failed");
    expect(result.snapshot.persisted.model).toBe("m2");
  });
});

describe("providers()", () => {
  test("目录来自 @fengagent/llm 注册表，状态与打码实时计算", () => {
    const { service } = makeHarness();
    const snap = service.providers();

    expect(snap.active).toBe("anthropic");
    const anthropic = snap.providers.find((p) => p.id === "anthropic");
    expect(anthropic?.active).toBe(true);
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.fields.find((f) => f.key === "anthropicApiKey")?.value).toBe("sk-a****");
    expect(anthropic?.models.length).toBeGreaterThan(0);

    const openai = snap.providers.find((p) => p.id === "openai");
    expect(openai?.configured).toBe(false);
    expect(openai?.fields.find((f) => f.key === "openaiApiKey")?.value).toBeUndefined();

    // bedrock 只有 AWS 环境变量，配置文件给不出凭据
    const bedrock = snap.providers.find((p) => p.id === "bedrock");
    expect(bedrock?.configured).toBe(false);
    expect(bedrock?.requiredEnv).toContain("AWS_ACCESS_KEY_ID");

    expect(JSON.stringify(snap)).not.toContain("sk-ant-abcdefgh");
  });

  test("env 锁定的配置项标记 locked", () => {
    const { service } = makeHarness({ env: { OPENAI_API_KEY: "sk-env" } });
    const openai = service.providers().providers.find((p) => p.id === "openai");
    const field = openai?.fields.find((f) => f.key === "openaiApiKey");
    expect(field?.locked).toBe(true);
  });
});
