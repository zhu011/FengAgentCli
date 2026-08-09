import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  McpClient,
  mcpToolName,
  sanitize,
  loadMcpConfig,
  adaptMcpTool,
  adaptMcpTools,
  McpServersConfigSchema,
  MCP_SERVERS_CONFIG_PATH,
  DEFAULT_MCP_TIMEOUT,
} from "../index.ts";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_WORKDIR = join(tmpdir(), "fengagent-mcp-test");

function setup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_WORKDIR, { recursive: true });
}

function cleanup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────
// sanitize + mcpToolName
// ──────────────────────────────────────────────

describe("sanitize", () => {
  it("keeps alphanumeric, underscore, and hyphen", () => {
    expect(sanitize("abc-123_def")).toBe("abc-123_def");
  });

  it("replaces special characters with underscore", () => {
    expect(sanitize("my.server/tool")).toBe("my_server_tool");
    expect(sanitize("hello world!")).toBe("hello_world_");
  });
});

describe("mcpToolName", () => {
  it("generates prefixed tool name", () => {
    const name = mcpToolName("my-server", "search");
    expect(name).toBe("mcp__my-server__search");
  });

  it("sanitizes server and tool names", () => {
    const name = mcpToolName("my.server", "tool.name");
    expect(name).toBe("mcp__my_server__tool_name");
  });
});

// ──────────────────────────────────────────────
// loadMcpConfig
// ──────────────────────────────────────────────

describe("loadMcpConfig", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("returns empty config when no config file or env var", () => {
    delete process.env.FENG_MCP_SERVERS;
    const config = loadMcpConfig(TEST_WORKDIR);
    expect(Object.keys(config).length).toBe(0);
  });

  it("loads config from .fengagent/mcp-servers.json", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "mcp-servers.json"),
      JSON.stringify({
        "test-server": {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      }),
    );

    const config = loadMcpConfig(TEST_WORKDIR);
    expect(config["test-server"]).toBeDefined();
    expect(config["test-server"]!.type).toBe("stdio");
    if (config["test-server"]!.type === "stdio") {
      expect(config["test-server"]!.command).toBe("node");
    }
  });

  it("loads config from FENG_MCP_SERVERS env var", () => {
    process.env.FENG_MCP_SERVERS = JSON.stringify({
      "env-server": {
        type: "sse",
        url: "http://localhost:8080",
      },
    });

    try {
      const config = loadMcpConfig(TEST_WORKDIR);
      expect(config["env-server"]).toBeDefined();
      expect(config["env-server"]!.type).toBe("sse");
    } finally {
      delete process.env.FENG_MCP_SERVERS;
    }
  });

  it("env var overrides file config", () => {
    const configDir = join(TEST_WORKDIR, ".fengagent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "mcp-servers.json"),
      JSON.stringify({
        "file-server": {
          type: "stdio",
          command: "node",
        },
        "shared-server": {
          type: "stdio",
          command: "from-file",
        },
      }),
    );

    process.env.FENG_MCP_SERVERS = JSON.stringify({
      "shared-server": {
        type: "sse",
        url: "http://from-env",
      },
    });

    try {
      const config = loadMcpConfig(TEST_WORKDIR);
      // file-server from file
      expect(config["file-server"]).toBeDefined();
      if (config["file-server"]!.type === "stdio") {
        expect(config["file-server"]!.command).toBe("node");
      }
      // shared-server from env (overridden)
      expect(config["shared-server"]!.type).toBe("sse");
    } finally {
      delete process.env.FENG_MCP_SERVERS;
    }
  });
});

// ──────────────────────────────────────────────
// McpServersConfigSchema
// ──────────────────────────────────────────────

describe("McpServersConfigSchema", () => {
  it("validates stdio server config", () => {
    const result = McpServersConfigSchema.parse({
      "my-server": {
        type: "stdio",
        command: "npx",
        args: ["-y", "@some/mcp-server"],
      },
    });

    expect(result["my-server"]!.type).toBe("stdio");
  });

  it("validates sse server config", () => {
    const result = McpServersConfigSchema.parse({
      "sse-server": {
        type: "sse",
        url: "http://localhost:3001/sse",
      },
    });

    expect(result["sse-server"]!.type).toBe("sse");
  });

  it("applies defaults", () => {
    const result = McpServersConfigSchema.parse({
      "server": {
        type: "stdio",
        command: "node",
      },
    });

    expect(result["server"]!.type).toBe("stdio");
    if (result["server"]!.type === "stdio") {
      expect(result["server"]!.args).toEqual([]);
    }
    expect(result["server"]!.enabled).toBe(true);
  });

  it("rejects unknown type", () => {
    expect(() =>
      McpServersConfigSchema.parse({
        "bad-server": {
          type: "websocket",
          command: "node",
        },
      }),
    ).toThrow();
  });
});

// ──────────────────────────────────────────────
// adaptMcpTool
// ──────────────────────────────────────────────

describe("adaptMcpTool", () => {
  it("adapts an MCP tool to ToolDefinition", () => {
    const mcpTool = {
      name: "search",
      description: "Search the web",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
        },
      },
    };

    // Create a mock client (we won't actually call it in this test)
    const mockClient = {} as never;

    const adapted = adaptMcpTool("test-server", mcpTool, mockClient, 30000);

    expect(adapted.name).toBe("mcp__test-server__search");
    expect(adapted.description).toBe("Search the web");
    expect(adapted.isReadOnly!({})).toBe(false);
    expect(adapted.isDestructive!({})).toBe(false);
    expect(adapted.isConcurrencySafe!({})).toBe(false);
  });

  it("uses default description when MCP tool has none", () => {
    const mcpTool = {
      name: "tool-no-desc",
      inputSchema: { type: "object" as const },
    };

    const mockClient = {} as never;
    const adapted = adaptMcpTool("srv", mcpTool, mockClient, 30000);

    expect(adapted.description).toContain("MCP tool: tool-no-desc");
    expect(adapted.description).toContain("srv");
  });

  it("renderUse generates a preview string", () => {
    const mcpTool = {
      name: "do-stuff",
      description: "Does stuff",
      inputSchema: { type: "object" as const },
    };

    const mockClient = {} as never;
    const adapted = adaptMcpTool("srv", mcpTool, mockClient, 30000);

    const rendered = adapted.renderUse!({ action: "test" });
    expect(rendered).toContain("srv");
    expect(rendered).toContain("do-stuff");
  });
});

// ──────────────────────────────────────────────
// adaptMcpTools
// ──────────────────────────────────────────────

describe("adaptMcpTools", () => {
  it("adapts multiple MCP tools", () => {
    const toolsMap = {
      "mcp__srv__tool1": {
        serverName: "srv",
        def: { name: "tool1", description: "Tool 1", inputSchema: { type: "object" as const } },
        client: {} as never,
        timeout: 30000,
      },
      "mcp__srv__tool2": {
        serverName: "srv",
        def: { name: "tool2", description: "Tool 2", inputSchema: { type: "object" as const } },
        client: {} as never,
        timeout: 30000,
      },
    };

    const adapted = adaptMcpTools(toolsMap);
    expect(adapted.length).toBe(2);
    expect(adapted[0]!.name).toBe("mcp__srv__tool1");
    expect(adapted[1]!.name).toBe("mcp__srv__tool2");
  });
});

// ──────────────────────────────────────────────
// McpClient
// ──────────────────────────────────────────────

describe("McpClient", () => {
  it("creates an instance with empty connections", () => {
    const client = new McpClient();
    expect(client.getConnections().length).toBe(0);
    expect(client.getTools()).toEqual({});
  });

  it("disconnects gracefully when no connection exists", async () => {
    const client = new McpClient();
    await client.disconnect("non-existent");
    // Should not throw
  });

  it("disconnectAll works with no connections", async () => {
    const client = new McpClient();
    await client.disconnectAll();
    // Should not throw
  });

  it("connectAll returns empty array for empty config", async () => {
    const client = new McpClient();
    const results = await client.connectAll({});
    expect(results.length).toBe(0);
  });
});

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

describe("MCP constants", () => {
  it("MCP_SERVERS_CONFIG_PATH is correct", () => {
    expect(MCP_SERVERS_CONFIG_PATH).toBe(".fengagent/mcp-servers.json");
  });

  it("DEFAULT_MCP_TIMEOUT is 30 seconds", () => {
    expect(DEFAULT_MCP_TIMEOUT).toBe(30_000);
  });
});
