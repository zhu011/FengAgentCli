/**
 * Plugin system tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPluginRegistry } from "../plugin-registry.ts";
import { createPluginLoader } from "../plugin-loader.ts";
import { createToolRegistry } from "@fengagent/tools";
import { createHookRegistry } from "@fengagent/tools";
import type { FengPlugin, PluginContext, PluginRegistrations } from "@fengagent/core/plugin";
import { ALLOW, deny } from "@fengagent/core";

const TEST_WORKDIR = join(tmpdir(), "fengagent-plugin-test");

function setup(): void {
  if (!existsSync(TEST_WORKDIR)) {
    mkdirSync(TEST_WORKDIR, { recursive: true });
  }
}

function cleanup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────
// Test plugin implementations
// ──────────────────────────────────────────────

function createTestPlugin(name: string, version: string): FengPlugin & { initCalled: boolean; registerCalled: boolean; disposeCalled: boolean } {
  const state = { initCalled: false, registerCalled: false, disposeCalled: false };

  const plugin: FengPlugin & { initCalled: boolean; registerCalled: boolean; disposeCalled: boolean } = {
    name,
    version,
    initCalled: false,
    registerCalled: false,
    disposeCalled: false,
    init: async (ctx: PluginContext) => {
      state.initCalled = true;
      plugin.initCalled = true;
      ctx.log("Test plugin " + name + " initialized");
    },
    register: async (_ctx: PluginContext): Promise<PluginRegistrations> => {
      state.registerCalled = true;
      plugin.registerCalled = true;
      return {
        tools: [],
        commands: new Map(),
        hooks: {},
      };
    },
    dispose: async () => {
      state.disposeCalled = true;
      plugin.disposeCalled = true;
    },
  };

  return plugin;
}

function createToolPlugin(toolName: string, readOnly = true): FengPlugin {
  return {
    name: "tool-plugin-" + toolName,
    version: "1.0.0",
    register: async (): Promise<PluginRegistrations> => {
      return {
        tools: [
          {
            name: toolName,
            description: "A test tool from plugin",
            inputSchema: z.object({ query: z.string() }),
            async execute(input: any) {
              return { content: "Result: " + input.query };
            },
            isReadOnly: () => readOnly,
            isConcurrencySafe: () => true,
            checkPermissions: () => ALLOW,
          },
        ],
        commands: new Map(),
        hooks: {},
      };
    },
  };
}

function createFailingPlugin(): FengPlugin {
  return {
    name: "failing-plugin",
    version: "1.0.0",
    init: async () => {
      throw new Error("Init failed intentionally");
    },
    register: async (): Promise<PluginRegistrations> => {
      return { tools: [], commands: new Map(), hooks: {} };
    },
  };
}

function createHookPlugin(): FengPlugin {
  return {
    name: "hook-plugin",
    version: "1.0.0",
    register: async (): Promise<PluginRegistrations> => {
      return {
        tools: [],
        commands: new Map(),
        hooks: {
          preToolUse: (toolName: string, _input: unknown) => {
            if (toolName === "forbidden-tool") {
              return deny("This tool is blocked by plugin");
            }
            return ALLOW;
          },
        },
      };
    },
  };
}

// ──────────────────────────────────────────────
// PluginRegistry tests
// ──────────────────────────────────────────────

describe("PluginRegistry", () => {
  beforeAll(() => setup());
  afterAll(() => cleanup());

  it("registers a single plugin successfully", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    const plugin = createTestPlugin("test-plugin", "1.0.0");

    const result = await registry.register(plugin);

    expect(result.status).toBe("loaded");
    expect(result.name).toBe("test-plugin");
    expect(result.version).toBe("1.0.0");
    expect(result.registrations).toBeDefined();
    expect(registry.getLoadedCount()).toBe(1);
    expect(registry.getFailedCount()).toBe(0);
  });

  it("registers multiple plugins", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    const p1 = createTestPlugin("p1", "1.0.0");
    const p2 = createTestPlugin("p2", "2.0.0");

    const results = await registry.registerAll([p1, p2]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "loaded")).toBe(true);
    expect(registry.getLoadedCount()).toBe(2);
  });

  it("isolates plugin errors — one failure does not affect others", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    const good = createTestPlugin("good", "1.0.0");
    const bad = createFailingPlugin();

    const results = await registry.registerAll([good, bad]);

    expect(results[0]!.status).toBe("loaded");
    expect(results[1]!.status).toBe("error");
    expect(results[1]!.error).toContain("Init failed");
    expect(registry.getLoadedCount()).toBe(1);
    expect(registry.getFailedCount()).toBe(1);
  });

  it("registers plugin tools into the tool registry", async () => {
    const toolRegistry = createToolRegistry();
    const registry = createPluginRegistry({
      workdir: TEST_WORKDIR,
      toolRegistry,
    });

    const plugin = createToolPlugin("plugin-tool-hello");
    await registry.register(plugin);

    const tool = toolRegistry.get("plugin-tool-hello");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("plugin-tool-hello");
    expect(tool!.description).toBe("A test tool from plugin");
  });

  it("executes a tool registered by a plugin", async () => {
    const toolRegistry = createToolRegistry();
    const registry = createPluginRegistry({
      workdir: TEST_WORKDIR,
      toolRegistry,
    });

    const plugin = createToolPlugin("search-plugin");
    await registry.register(plugin);

    const tool = toolRegistry.get("search-plugin");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ query: "hello" }, {
      workdir: TEST_WORKDIR,
      sessionId: "test",
      messageId: "test",
    });
    expect(result.content).toBe("Result: hello");
  });

  it("registers plugin hooks into the hook registry", async () => {
    const hookRegistry = createHookRegistry();
    const registry = createPluginRegistry({
      workdir: TEST_WORKDIR,
      hookRegistry,
    });

    await registry.register(createHookPlugin());

    const handlers = hookRegistry.getHandlers("pre-tool-use");
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("pre-tool-use hook from plugin blocks forbidden tools", async () => {
    const hookRegistry = createHookRegistry();
    const registry = createPluginRegistry({
      workdir: TEST_WORKDIR,
      hookRegistry,
    });

    await registry.register(createHookPlugin());

    const result = await hookRegistry.triggerPreToolUse("forbidden-tool", {}, {
      workdir: TEST_WORKDIR,
      sessionId: "test",
      messageId: "test",
    });
    expect(result.allowed).toBe(false);

    const allowedResult = await hookRegistry.triggerPreToolUse("allowed-tool", {}, {
      workdir: TEST_WORKDIR,
      sessionId: "test",
      messageId: "test",
    });
    expect(allowedResult.allowed).toBe(true);
  });

  it("calls plugin lifecycle methods in order", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    const plugin = createTestPlugin("lifecycle", "1.0.0");

    await registry.register(plugin);
    expect(plugin.initCalled).toBe(true);
    expect(plugin.registerCalled).toBe(true);

    await registry.disposeAll();
    expect(plugin.disposeCalled).toBe(true);
  });

  it("handles plugin without init and dispose", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    const plugin: FengPlugin = {
      name: "minimal",
      version: "1.0.0",
      register: async (): Promise<PluginRegistrations> => {
        return { tools: [], commands: new Map(), hooks: {} };
      },
    };

    const result = await registry.register(plugin);
    expect(result.status).toBe("loaded");
  });

  it("rejects plugin without name", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    const plugin: FengPlugin = {
      name: "",
      version: "1.0.0",
      register: async (): Promise<PluginRegistrations> => {
        return { tools: [], commands: new Map(), hooks: {} };
      },
    };

    const result = await registry.register(plugin);
    expect(result.status).toBe("error");
    expect(result.error).toContain("name");
  });

  it("getAllTools returns all plugin tools", async () => {
    const toolRegistry = createToolRegistry();
    const registry = createPluginRegistry({
      workdir: TEST_WORKDIR,
      toolRegistry,
    });

    await registry.register(createToolPlugin("t1"));
    await registry.register(createToolPlugin("t2"));

    const tools = registry.getAllTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["t1", "t2"]);
  });

  it("getResults returns all plugin results", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    await registry.register(createTestPlugin("a", "1.0"));
    await registry.register(createTestPlugin("b", "2.0"));

    const results = registry.getResults();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  it("disposeAll clears plugins", async () => {
    const registry = createPluginRegistry({ workdir: TEST_WORKDIR });
    await registry.register(createTestPlugin("a", "1.0"));
    expect(registry.getLoadedCount()).toBe(1);

    await registry.disposeAll();
    expect(registry.getLoadedCount()).toBe(0);
  });
});

// ──────────────────────────────────────────────
// PluginLoader tests
// ──────────────────────────────────────────────

describe("PluginLoader", () => {
  beforeAll(() => {
    setup();
    const pluginsDir = join(TEST_WORKDIR, ".fengagent", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
  });
  afterAll(() => cleanup());

  it("returns empty when plugins directory does not exist", async () => {
    const loader = createPluginLoader({ workdir: join(TEST_WORKDIR, "nonexistent") });
    const results = await loader.loadAll();
    expect(results).toEqual([]);
  });

  it("returns empty when plugins directory exists but is empty", async () => {
    const loader = createPluginLoader({ workdir: TEST_WORKDIR });
    const results = await loader.loadAll();
    expect(results).toEqual([]);
  });

  it("respects custom pluginsDir option", async () => {
    const customDir = join(TEST_WORKDIR, "custom-plugins", "my-plugin");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, "index.ts"),
      [
        "export default class CustomPlugin {",
        "  name = 'custom';",
        "  version = '1.0';",
        "  async register(ctx) {",
        "    return {",
        "      tools: [{",
        "        name: 'custom-tool',",
        "        description: 'A custom tool',",
        "        inputSchema: { parse: (v: any) => v },",
        "        async execute(input: any) { return { content: 'Custom: ' + input.msg }; },",
        "        isReadOnly: () => true,",
        "        isConcurrencySafe: () => true,",
        "        checkPermissions: () => ({ decision: 'allow' }),",
        "      }],",
        "      commands: new Map(),",
        "      hooks: {},",
        "    };",
        "  }",
        "}",
      ].join("\n"),
    );

    const loader = createPluginLoader({
      workdir: TEST_WORKDIR,
      pluginsDir: join(TEST_WORKDIR, "custom-plugins"),
    });
    const results = await loader.loadAll();

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("loaded");
    expect(results[0]!.name).toBe("custom");
    expect(loader.getLoadedCount()).toBe(1);
  });

  it("loads a valid plugin from .fengagent/plugins/ directory", async () => {
    const pluginsDir = join(TEST_WORKDIR, ".fengagent", "plugins", "hello-plugin");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "index.ts"),
      [
        'import { z } from "zod";',
        'import { ALLOW } from "@fengagent/core";',
        "",
        "export default class HelloPlugin {",
        "  name = 'hello';",
        "  version = '1.0.0';",
        "  async register(ctx) {",
        "    return {",
        "      tools: [],",
        "      commands: new Map(),",
        "      hooks: {},",
        "    };",
        "  }",
        "}",
      ].join("\n"),
    );

    const loader = createPluginLoader({ workdir: TEST_WORKDIR });
    const results = await loader.loadAll();

    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("getAllTools returns tools from all loaded plugins", async () => {
    const pluginsDir = join(TEST_WORKDIR, ".fengagent", "plugins", "tool-plugin-dir");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "index.ts"),
      [
        "export default class ToolPlugin {",
        "  name = 'tool-dir';",
        "  version = '1.0';",
        "  async register(ctx) {",
        "    return {",
        "      tools: [{",
        "        name: 'loader-tool',",
        "        description: 'A loader tool',",
        "        inputSchema: { parse: (v: any) => v },",
        "        async execute(input: any) { return { content: String(input.x * 2) }; },",
        "        isReadOnly: () => true,",
        "        isConcurrencySafe: () => true,",
        "        checkPermissions: () => ({ decision: 'allow' }),",
        "      }],",
        "      commands: new Map(),",
        "      hooks: {},",
        "    };",
        "  }",
        "}",
      ].join("\n"),
    );

    const loader = createPluginLoader({ workdir: TEST_WORKDIR, pluginsDir: join(TEST_WORKDIR, ".fengagent", "plugins") });
    await loader.loadAll();

    const tools = loader.getAllTools();
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("loader-tool");
  });

  it("handles plugin without default export", async () => {
    const pluginsDir = join(TEST_WORKDIR, ".fengagent", "plugins", "no-default");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "index.ts"),
      'export const notDefault = 42;',
    );

    const loader = createPluginLoader({ workdir: TEST_WORKDIR });
    const results = await loader.loadAll();

    const noDefault = results.find((r) => r.name === "no-default");
    expect(noDefault).toBeDefined();
    expect(noDefault!.status).toBe("error");
  });

  it("error isolation: bad plugin does not prevent others from loading", async () => {
    const pluginsDir = join(TEST_WORKDIR, ".fengagent", "plugins");
    const goodDir = join(pluginsDir, "good-isolated");
    const badDir = join(pluginsDir, "bad-syntax");

    mkdirSync(goodDir, { recursive: true });
    writeFileSync(
      join(goodDir, "index.ts"),
      [
        "export default class GoodPlugin {",
        "  name = 'good';",
        "  version = '1.0';",
        "  async register() { return { tools: [], commands: new Map(), hooks: {} }; }",
        "}",
      ].join("\n"),
    );

    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "index.ts"),
      "this is not valid typescript {{{",
    );

    const loader = createPluginLoader({ workdir: TEST_WORKDIR });
    const results = await loader.loadAll();

    const good = results.find((r) => r.name === "good");
    expect(good).toBeDefined();
    expect(good!.status).toBe("loaded");

    const bad = results.find((r) => r.name === "bad-syntax");
    expect(bad).toBeDefined();
    expect(bad!.status).toBe("error");
  });
});
