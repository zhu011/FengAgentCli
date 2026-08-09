/**
 * @fengagent/agent -- Plugin Loader
 *
 * Loads plugins from .fengagent/plugins/ directory.
 * Each plugin is <dir>/index.ts exporting default class implements FengPlugin.
 * Dynamic import + init + error isolation.
 */

import type { FengPlugin, PluginContext, PluginLoadResult, PluginRegistrations } from "@fengagent/core/plugin";
import { PLUGINS_DIR } from "@fengagent/shared";
import { expandTilde } from "@fengagent/shared/utils";
import { join } from "node:path";

export interface PluginLoaderOptions {
  workdir: string;
  pluginsDir?: string;
  config?: Record<string, unknown>;
}

export function createPluginLoader(options: PluginLoaderOptions) {
  const loadedPlugins: PluginLoadResult[] = [];

  function getPluginsDir(): string {
    if (options.pluginsDir) {
      return expandTilde(options.pluginsDir);
    }
    return join(options.workdir, PLUGINS_DIR);
  }

  async function loadAll(): Promise<PluginLoadResult[]> {
    loadedPlugins.length = 0;

    const dir = getPluginsDir();
    let entries: string[] = [];

    try {
      const { readdirSync } = await import("node:fs");
      const result = readdirSync(dir, { withFileTypes: true });
      entries = result.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    const context: PluginContext = {
      workdir: options.workdir,
      config: options.config ?? {},
      log: (message: string) => {
        process.stderr.write("[plugin] " + message + "\n");
      },
    };

    for (const pluginName of entries) {
      const pluginPath = join(dir, pluginName, "index.ts");
      try {
        const mod = await import(pluginPath);
        const PluginClass = mod.default;

        if (!PluginClass || typeof PluginClass !== "function") {
          throw new Error("Plugin must export a default class");
        }

        const instance: FengPlugin = new PluginClass();

        if (!instance.name || !instance.version) {
          throw new Error("Plugin must have name and version");
        }

        if (instance.init) {
          await instance.init(context);
        }

        const registrations: PluginRegistrations = await instance.register(context);

        loadedPlugins.push({
          name: instance.name,
          version: instance.version,
          status: "loaded",
          registrations,
        });

        context.log("Loaded plugin: " + instance.name + "@" + instance.version);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        loadedPlugins.push({
          name: pluginName,
          version: "unknown",
          status: "error",
          error: message,
        });
        context.log("Failed to load plugin " + pluginName + ": " + message);
      }
    }

    return loadedPlugins;
  }

  function getResults(): PluginLoadResult[] {
    return [...loadedPlugins];
  }

  function getLoadedCount(): number {
    return loadedPlugins.filter((p) => p.status === "loaded").length;
  }

  function getFailedCount(): number {
    return loadedPlugins.filter((p) => p.status === "error").length;
  }

  function getAllTools() {
    return loadedPlugins
      .filter((p) => p.status === "loaded" && p.registrations)
      .flatMap((p) => p.registrations!.tools);
  }

  async function disposeAll(): Promise<void> {
    // Plugins are disposed individually if needed
  }

  return {
    loadAll,
    getResults,
    getLoadedCount,
    getFailedCount,
    getAllTools,
    disposeAll,
  };
}

export type PluginLoader = ReturnType<typeof createPluginLoader>;
