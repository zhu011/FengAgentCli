/**
 * @fengagent/agent -- Plugin Registry
 *
 * Central registry that manages plugin lifecycle: load → init → register → run → dispose.
 * Integrates loaded plugins with the tool registry and hook registry.
 * Reference ARCHITECTURE.md Section 4.5.
 */

import type { FengPlugin, PluginContext, PluginLoadResult, PluginRegistrations } from "@fengagent/core/plugin";
import type { ToolRegistry, HookRegistry } from "@fengagent/tools";

export interface PluginRegistryOptions {
  workdir: string;
  config?: Record<string, unknown>;
  toolRegistry?: ToolRegistry;
  hookRegistry?: HookRegistry;
}

export interface PluginRegistry {
  /** Load and initialize a single plugin instance */
  register(plugin: FengPlugin): Promise<PluginLoadResult>;

  /** Load and initialize multiple plugins */
  registerAll(plugins: FengPlugin[]): Promise<PluginLoadResult[]>;

  /** Get all loaded plugin results */
  getResults(): PluginLoadResult[];

  /** Get count of successfully loaded plugins */
  getLoadedCount(): number;

  /** Get count of failed plugins */
  getFailedCount(): number;

  /** Get all tools registered by plugins */
  getAllTools(): PluginRegistrations["tools"];

  /** Dispose all plugins */
  disposeAll(): Promise<void>;
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const loadedPlugins: Array<{ plugin: FengPlugin; result: PluginLoadResult }> = [];

  const context: PluginContext = {
    workdir: options.workdir,
    config: options.config ?? {},
    log: (message: string) => {
      process.stderr.write("[plugin] " + message + "\n");
    },
  };

  async function register(plugin: FengPlugin): Promise<PluginLoadResult> {
    try {
      if (!plugin.name || !plugin.version) {
        throw new Error("Plugin must have name and version");
      }

      if (plugin.init) {
        await plugin.init(context);
      }

      const registrations: PluginRegistrations = await plugin.register(context);

      if (options.toolRegistry && registrations.tools.length > 0) {
        for (const tool of registrations.tools) {
          try {
            options.toolRegistry.register(tool);
          } catch {
            context.log("Failed to register tool from plugin " + plugin.name + ": " + tool.name);
          }
        }
      }

      if (options.hookRegistry) {
        if (registrations.hooks.preToolUse) {
          options.hookRegistry.register("pre-tool-use", (toolName, input, _context) => {
            const result = registrations.hooks!.preToolUse!(toolName, input);
            if (result) return { allowed: result.decision === "allow", reason: result.decision === "deny" ? result.reason : undefined };
            return { allowed: true };
          });
        }
        if (registrations.hooks.postToolUse) {
          options.hookRegistry.register("post-tool-use", (toolName, input, result, _context) => {
            registrations.hooks!.postToolUse!(toolName, input, result);
            return result;
          });
        }
      }

      const result: PluginLoadResult = {
        name: plugin.name,
        version: plugin.version,
        status: "loaded",
        registrations,
      };

      loadedPlugins.push({ plugin, result });
      context.log("Registered plugin: " + plugin.name + "@" + plugin.version);

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: PluginLoadResult = {
        name: plugin.name ?? "unknown",
        version: plugin.version ?? "unknown",
        status: "error",
        error: message,
      };

      loadedPlugins.push({ plugin, result });
      context.log("Failed to register plugin: " + message);

      return result;
    }
  }

  async function registerAll(plugins: FengPlugin[]): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = [];
    for (const plugin of plugins) {
      results.push(await register(plugin));
    }
    return results;
  }

  function getResults(): PluginLoadResult[] {
    return loadedPlugins.map((p) => p.result);
  }

  function getLoadedCount(): number {
    return loadedPlugins.filter((p) => p.result.status === "loaded").length;
  }

  function getFailedCount(): number {
    return loadedPlugins.filter((p) => p.result.status === "error").length;
  }

  function getAllTools(): PluginRegistrations["tools"] {
    return loadedPlugins
      .filter((p) => p.result.status === "loaded" && p.result.registrations)
      .flatMap((p) => p.result.registrations!.tools);
  }

  async function disposeAll(): Promise<void> {
    for (const { plugin } of loadedPlugins) {
      try {
        if (plugin.dispose) {
          await plugin.dispose();
        }
      } catch {
        // Error isolation
      }
    }
    loadedPlugins.length = 0;
  }

  return {
    register,
    registerAll,
    getResults,
    getLoadedCount,
    getFailedCount,
    getAllTools,
    disposeAll,
  };
}
