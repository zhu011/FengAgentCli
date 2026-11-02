/**
 * 设置面 HTTP 契约（S3）：`/api/settings/model` + `/api/settings/providers`。
 *
 * 路由只做 HTTP 适配，这里用内存实现托底，只测状态码 / 错误体 / 缓存头 / 装配。
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ConfigSchema, type Config } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";
import { createSettingsRoutes, type SettingsRouteSource } from "../routes/settings.ts";
import { createApp } from "../server.ts";
import {
  ModelSettingsError,
  type ModelSettingsSnapshot,
  type ProvidersSnapshot,
} from "../model-settings.ts";

const SNAPSHOT: ModelSettingsSnapshot = {
  settings: { provider: "anthropic", model: "claude-sonnet-4-20250514", anthropicApiKey: "sk-a****" },
  persisted: {},
  sources: { model: "config", provider: "config" } as ModelSettingsSnapshot["sources"],
  envLocked: [],
  overridden: [],
  active: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    smallModel: "claude-haiku-3",
    maxTokens: 8192,
    temperature: 0.2,
    contextWindow: 200000,
    compactThreshold: 0.8,
  },
  settingsPath: "/tmp/settings.json",
  warnings: [],
};

const PROVIDERS: ProvidersSnapshot = {
  active: "anthropic",
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      description: "Claude 官方 API",
      active: true,
      configured: true,
      models: ["claude-sonnet-4-20250514"],
      fields: [
        {
          key: "anthropicApiKey",
          label: "API Key",
          type: "secret",
          env: "ANTHROPIC_API_KEY",
          required: true,
          locked: false,
          configured: true,
          value: "sk-a****",
        },
      ],
    },
  ],
};

function makeApp(source?: Partial<SettingsRouteSource>): Hono {
  const impl: SettingsRouteSource = {
    get: () => SNAPSHOT,
    patch: async () => ({ snapshot: SNAPSHOT, written: ["model"], overridden: [] }),
    providers: () => PROVIDERS,
    ...source,
  };
  const app = new Hono();
  app.route("/api/settings", createSettingsRoutes(impl));
  return app;
}

async function patchJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/settings/model", () => {
  test("返回生效值 + 来源，带 no-cache", async () => {
    const res = await makeApp().request("/api/settings/model");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const body = (await res.json()) as ModelSettingsSnapshot;
    expect(body.active.model).toBe("claude-sonnet-4-20250514");
    expect(body.sources.model).toBe("config");
    expect(body.settingsPath).toBe("/tmp/settings.json");
  });

  test("服务抛错 → 500 + 统一错误体", async () => {
    const res = await makeApp({
      get: () => {
        throw new Error("boom");
      },
    }).request("/api/settings/model");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toContain("boom");
  });
});

describe("PATCH /api/settings/model", () => {
  test("合法补丁 → 200 + written", async () => {
    const res = await patchJson(makeApp(), "/api/settings/model", { model: "m2" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: string[]; overridden: string[] };
    expect(body.written).toEqual(["model"]);
    expect(body.overridden).toEqual([]);
  });

  test("非 JSON body → 400 bad_request", async () => {
    const res = await makeApp().request("/api/settings/model", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("服务校验失败（未知键 / 越界）→ 400 + 原因", async () => {
    const res = await patchJson(
      makeApp({
        patch: async () => {
          throw new ModelSettingsError("temperature: too big");
        },
      }),
      "/api/settings/model",
      { temperature: 9 },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.message).toContain("temperature");
    expect(body.error.code).toBe("bad_request");
  });

  test("服务内部错误 → 500", async () => {
    const res = await patchJson(
      makeApp({
        patch: async () => {
          throw new Error("disk full");
        },
      }),
      "/api/settings/model",
      { model: "m2" },
    );
    expect(res.status).toBe(500);
  });
});

describe("GET /api/settings/providers", () => {
  test("返回 Provider 目录与状态", async () => {
    const res = await makeApp().request("/api/settings/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvidersSnapshot;
    expect(body.active).toBe("anthropic");
    expect(body.providers[0]?.fields[0]?.value).toBe("sk-a****");
  });
});

describe("装配", () => {
  test("createApp 提供 settings 时挂 /api/settings；缺省时 404", async () => {
    const config: Config = ConfigSchema.parse({ corsOrigin: "*" });
    const createAgent = (() => ({}) as Agent) as () => Agent;
    const withSettings = createApp({ config, createAgent, settings: makeAppSource() });
    const res = await withSettings.app.request("/api/settings/model");
    expect(res.status).toBe(200);

    const without = createApp({ config, createAgent });
    const missing = await without.app.request("/api/settings/model");
    expect(missing.status).toBe(404);
  });
});

/** 供装配用例复用的内存实现 */
function makeAppSource(): SettingsRouteSource {
  return {
    get: () => SNAPSHOT,
    patch: async () => ({ snapshot: SNAPSHOT, written: [], overridden: [] }),
    providers: () => PROVIDERS,
  };
}
