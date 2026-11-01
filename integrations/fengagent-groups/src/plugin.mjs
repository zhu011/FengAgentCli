// DSH plugin: bridges FengAgentCli group chat into a DSH agent's toolset.
// Glue only — the HTTP contract lives in api-client.mjs, the tool specs in
// tools.mjs (both DSH-independent and unit-tested).
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createFengClient } from "./api-client.mjs";
import { resolveConfig } from "./config.mjs";
import { fengGroupToolSpecs } from "./tools.mjs";

export const name = "fengagent-groups";
export const inject = ["tools"];

export function apply(ctx, config) {
  let cfg;
  try {
    cfg = resolveConfig(config);
  } catch (e) {
    console.warn(`[fengagent-groups] not registering tools: ${e.message}`);
    return;
  }
  const client = createFengClient({ serverUrl: cfg.serverUrl, timeoutMs: cfg.timeoutMs });

  const specs = fengGroupToolSpecs(client);
  for (const spec of specs) {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              ok: { type: "boolean", required: true },
              id: { type: "string", required: true },
            },
          },
          render: (_args, value) => [{ type: "text", text: spec.render(value) }],
        },
        async execute(args) {
          return await spec.handler(args);
        },
      }),
    );
  }
  console.log(`[fengagent-groups] ${specs.length} tools registered → ${cfg.serverUrl}`);
}
