/**
 * @fengagent/llm — 工具入参 schema → JSON Schema（共享转换层）
 *
 * 背景（已修缺陷）：zod v3 的 schema 实例**没有** `toJSONSchema()` 方法——那是 zod v4
 * 的 API。早先三个 provider 各自复制了一份 `convertZodToJsonSchema`，只调
 * `schema.toJSONSchema?.()`，对仓库实际使用的 zod v3 永远拿不到结果，于是
 * **LLM 可见的工具参数一直是空 schema**（`{ type: "object", properties: {} }`），
 * 模型只能靠工具 description 猜参数。
 *
 * 现在的解析顺序：
 * 1. 原生 `toJSONSchema()`（zod v4，或 dsh 适配器那种直通 schema）；
 * 2. zod v3（实例带 `_def`）→ `zod-to-json-schema`（`$refStrategy: "none"` 全内联）；
 * 3. 已经是 JSON Schema 形状的对象 → 规范化后直通；
 * 4. 都不成立 → 宽松 schema（`additionalProperties: true`），明确"不约束"而不是
 *    伪装成"没有参数"。
 */

import zodToJsonSchema from "zod-to-json-schema";

/**
 * 兜底用的宽松 object schema。
 *
 * 与"空 parameters"不同：`additionalProperties: true` 明确告诉模型可以传任意字段，
 * 而不是断言这个工具没有参数。
 */
export const PERMISSIVE_TOOL_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: true,
});

/** 判断是否为普通对象（排除 null / 数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 规范化 JSON Schema：去掉不同 draft 的元数据，补齐 object 根类型。
 *
 * `$schema` / `$id` 对模型调用没有意义，部分 OpenAI 兼容网关还会因此拒请求，
 * 统一剥掉；根上缺 `type` 但有 `properties` 时补 `object`。
 */
function normalizeJsonSchema(json: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...json };
  delete next["$schema"];
  delete next["$id"];
  if (next["type"] === undefined && isRecord(next["properties"])) {
    next["type"] = "object";
  }
  return next;
}

/**
 * 把工具入参 schema 转成 LLM 可见的 JSON Schema。
 *
 * @param schema `ToolDefinition.inputSchema`（zod v3 / zod v4 / 直通 JSON Schema）
 * @returns 非空 JSON Schema；无法识别时返回 {@link PERMISSIVE_TOOL_SCHEMA} 的副本
 */
export function zodToJsonSchemaCompat(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { ...PERMISSIVE_TOOL_SCHEMA };

  // ① zod v4（或 dsh 适配器的直通 schema）：实例自带 toJSONSchema()
  const native = schema["toJSONSchema"];
  if (typeof native === "function") {
    try {
      const json: unknown = native.call(schema);
      if (isRecord(json)) return normalizeJsonSchema(json);
    } catch {
      // 落到下一档
    }
  }

  // ② zod v3：没有 toJSONSchema()，用 zod-to-json-schema 转换
  if ("_def" in schema) {
    try {
      const json = zodToJsonSchema(schema as unknown as Parameters<typeof zodToJsonSchema>[0], {
        $refStrategy: "none",
      });
      if (isRecord(json)) return normalizeJsonSchema(json);
    } catch {
      // 落到下一档
    }
  }

  // ③ 已经是 JSON Schema（object 根，或至少带 properties）
  if (schema["type"] === "object" || isRecord(schema["properties"])) {
    return normalizeJsonSchema(schema);
  }

  return { ...PERMISSIVE_TOOL_SCHEMA };
}

/**
 * OpenAI / OpenAI-compatible 的 `function.parameters`。
 *
 * OpenAI 要求根是 object；非 object 根（如裸 union）退化成宽松 schema。
 */
export function toOpenAIToolParameters(schema: unknown): Record<string, unknown> {
  const json = zodToJsonSchemaCompat(schema);
  if (json["type"] === "object") return json;
  return { ...PERMISSIVE_TOOL_SCHEMA };
}

/**
 * Anthropic 的 `input_schema`。
 *
 * 与旧实现的关键差异：不再只搬 `properties`——`required`、嵌套对象、`description`
 * 都保留下来（旧实现把 `required` 丢了，模型会把必填参数当可选项）。
 */
export function toAnthropicInputSchema(schema: unknown): Record<string, unknown> {
  const json = zodToJsonSchemaCompat(schema);
  const properties = isRecord(json["properties"]) ? json["properties"] : {};
  return { ...json, type: "object", properties };
}
