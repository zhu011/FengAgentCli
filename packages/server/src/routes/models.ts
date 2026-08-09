/**
 * @fengagent/server — 模型路由
 *
 * 返回可用模型列表。
 */

import { Hono } from "hono";
import type { Config } from "@fengagent/core";
import { DEFAULT_MODEL, DEFAULT_SMALL_MODEL } from "@fengagent/shared";

/** 创建模型路由 */
export function createModelRoutes(config: Config): Hono {
  const app = new Hono();

  // GET / — 获取可用模型列表
  app.get("/", (c) => {
    const models = [
      {
        id: config.model,
        name: config.model,
        isDefault: true,
      },
      {
        id: config.smallModel,
        name: config.smallModel,
        isDefault: false,
      },
    ];

    // 如果配置了回退模型
    if (config.fallbackModel) {
      models.push({
        id: config.fallbackModel,
        name: config.fallbackModel,
        isDefault: false,
      });
    }

    return c.json({ models });
  });

  return app;
}

/** 默认模型列表（无需 config 时使用） */
export function getDefaultModels() {
  return {
    models: [
      { id: DEFAULT_MODEL, name: DEFAULT_MODEL, isDefault: true },
      { id: DEFAULT_SMALL_MODEL, name: DEFAULT_SMALL_MODEL, isDefault: false },
    ],
  };
}
