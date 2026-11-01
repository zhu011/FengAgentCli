// fengagent-compat — FengAgentCli 工具定义 → dsh 工具定义 适配器（方向 B）
//
// feng 侧契约（@fengagent/core 的 ToolDefinition）：
// - `inputSchema`：Zod schema（feng 用 zod v3，无 toJSONSchema 实例方法——
//   经 zod-to-json-schema 转换；鸭子 schema（带 toJSONSchema()/parse）与
//   裸 JSON schema 对象也认）；
// - `execute(input, context: ToolContext)` → `ToolResult { content, isError?, metadata? }`；
// - 可选 timeoutMs / isConcurrencySafe。
//
// dsh 侧契约（ToolRuntime.register 接受的定义，defineTool 产物形状）：
// - `parameters`：编译后的 JSON Schema（register 不重校验，直接喂给 LLM）；
// - `output: { schema, render(args, value) }`（register 会 assertSupportedJsonSchema）；
// - `execute(args, exec)`（exec.signal 取消）。
//
// 与方向 A（packages/dsh-compat）互为镜像：那边把 dsh 定义适配进 feng，
// 这边把 feng 定义适配进 dsh。

import zodToJsonSchema from "zod-to-json-schema";

/** 宽松回退 schema（LLM 从 description 推断参数——与 feng providers 现状同底） */
const PERMISSIVE = { type: "object", properties: {}, additionalProperties: true };

/**
 * 判断是否为 FengAgentCli 形状的工具定义（区别于 dsh defineTool 产物：
 * dsh 定义带 output.render，feng 定义带 inputSchema）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFengToolDefinition(value) {
  if (value === null || typeof value !== "object") return false;
  const def = value;
  if (typeof def.name !== "string" || typeof def.description !== "string") return false;
  if (typeof def.execute !== "function") return false;
  if (def.inputSchema === undefined) return false;
  const output = def.output;
  if (output !== null && typeof output === "object" && typeof output.render === "function") return false;
  return true;
}

/**
 * 规整为 dsh 期望的 object 根 JSON Schema（去 $schema/$id、保证 additionalProperties 显式）。
 * @param {Record<string, unknown>} json
 * @returns {Record<string, unknown>}
 */
function normalizeObjectSchema(json) {
  const next = { ...json };
  delete next["$schema"];
  delete next["$id"];
  if (next["type"] !== "object") return { ...PERMISSIVE };
  if (typeof next["additionalProperties"] !== "boolean") next["additionalProperties"] = false;
  return next;
}

/**
 * inputSchema → dsh 侧 JSON Schema（object 根；转换不了回退宽松 schema）。
 * @param {unknown} inputSchema
 * @returns {Record<string, unknown>}
 */
function toParametersSchema(inputSchema) {
  if (inputSchema !== null && typeof inputSchema === "object") {
    // ① 鸭子：自带 toJSONSchema()（zod v4 / dsh-compat 的直通 schema）
    if (typeof inputSchema.toJSONSchema === "function") {
      try {
        const json = inputSchema.toJSONSchema();
        if (json && typeof json === "object") return normalizeObjectSchema(json);
      } catch {
        // 落到下一档
      }
    }
    // ② zod v3（feng 的实际版本）：zod-to-json-schema 转换
    if ("_def" in inputSchema) {
      try {
        const json = zodToJsonSchema(inputSchema, { $refStrategy: "none" });
        if (json && typeof json === "object") return normalizeObjectSchema(json);
      } catch {
        // 落到下一档
      }
    }
    // ③ 裸 JSON schema 对象（object 根）
    if (inputSchema["type"] === "object") {
      return normalizeObjectSchema(inputSchema);
    }
  }
  // ④ 回退：宽松 schema
  return { ...PERMISSIVE };
}

/**
 * 把 feng 工具定义适配成 dsh 工具定义（手动构造 defineTool 产物形状——
 * register 只校验 output.schema，parameters 直接作为 LLM 可见 JSON Schema）。
 * @param {feng 工具定义} feng
 * @returns {dsh 工具定义}
 */
export function adaptFengTool(feng) {
  const looseSchema =
    feng.inputSchema !== null && typeof feng.inputSchema === "object" ? feng.inputSchema : null;

  return {
    name: feng.name,
    description: feng.description,
    parameters: toParametersSchema(feng.inputSchema),

    output: {
      // 宽松 output schema（dsh register 的 assertSupportedJsonSchema 要求显式 additionalProperties）
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          content: { type: "string" },
          isError: { type: "boolean" },
        },
      },
      render: (_args, value) => {
        const result = value;
        const prefix = result && result.isError ? "⚠ " : "";
        return [{ type: "text", text: `${prefix}${result?.content ?? "(no output)"}` }];
      },
    },

    ...(feng.timeoutMs !== undefined && feng.timeoutMs > 0 ? { timeoutMs: feng.timeoutMs } : {}),

    async execute(args, exec) {
      // 参数校验走 feng 自己的 schema（与 feng executor 同语义；无 parse 则放行）
      if (looseSchema !== null && typeof looseSchema.parse === "function") {
        looseSchema.parse(args);
      }
      const result = await feng.execute(args, {
        workdir: process.cwd(),
        sessionId: "dsh",
        messageId: "dsh",
      });
      return {
        content: result.content,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      };
    },

    ...(feng.isConcurrencySafe === undefined
      ? {}
      : {
          isConcurrencySafe: (args) => feng.isConcurrencySafe(args) === true,
        }),
  };
}
