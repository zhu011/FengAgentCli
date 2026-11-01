// Plugin configuration: patch-file config first, environment second.
// The FengAgentCli server is local-first and carries no auth on /api/groups,
// so the only knobs are where it listens and how long to wait per request.

/** JSON-schema-shaped description of the patch-file config (documentation + validation). */
export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    serverUrl: {
      type: "string",
      description: "FengAgentCli server base URL, e.g. http://127.0.0.1:3000 (env FENG_SERVER_URL)",
    },
    timeoutMs: {
      type: "number",
      description: "Per-request timeout in milliseconds, default 30000 (env FENG_TIMEOUT_MS)",
    },
  },
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Resolve plugin config from the patch file, then the environment.
 *
 * @param {Partial<{serverUrl: string, timeoutMs: number}>} config - patch-file config
 * @param {Record<string, string | undefined>} env - environment (default `process.env`)
 * @returns {{serverUrl: string, timeoutMs: number}}
 */
export function resolveConfig(config = {}, env = process.env) {
  for (const key of Object.keys(config ?? {})) {
    if (!(key in configSchema.properties)) throw new ConfigError(`unknown config key "${key}"`);
  }
  const serverUrl = String(config.serverUrl ?? env.FENG_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(serverUrl)) {
    throw new ConfigError(`serverUrl must be an http(s) URL, got "${serverUrl}"`);
  }
  const rawTimeout = Number(config.timeoutMs ?? env.FENG_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000;
  return { serverUrl, timeoutMs };
}
