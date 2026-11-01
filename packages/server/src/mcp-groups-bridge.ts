/**
 * @fengagent/server — 群 MCP stdio 桥（v2 V2-1）
 *
 * claude / kimi 等 CLI 经 `mcp add` 指向本桥，工具直达 FengAgentCli server
 * 的群 MCP 服务面（per-member token 绑定发言身份）。
 *
 * 用法（claude）：
 * ```bash
 * claude mcp add fengagent-groups -- bun packages/server/src/mcp-groups-bridge.ts \
 *   --url http://127.0.0.1:3000 --token <fgm_...>
 * ```
 *
 * 工具面：group_send / group_reply / group_history / group_list
 * （group_reply = send 的回复形态，replyToSeq 必填）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface BridgeArgs {
  url: string;
  token: string;
}

function parseArgs(argv: string[]): BridgeArgs {
  const args: BridgeArgs = { url: "http://127.0.0.1:3000", token: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") args.url = argv[i + 1] ?? args.url;
    if (argv[i] === "--token") args.token = argv[i + 1] ?? "";
  }
  if (args.token === "") {
    console.error("mcp-groups-bridge: --token 必填（POST /api/groups/mcp/tokens 铸取）");
    process.exit(1);
  }
  return args;
}

async function main(): Promise<void> {
  const { url, token } = parseArgs(process.argv.slice(2));
  const base = url.replace(/\/+$/, "");
  const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let payload: unknown = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const message =
        (payload as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${res.status}`;
      throw new Error(message);
    }
    return payload as T;
  }

  const server = new McpServer({ name: "fengagent-groups", version: "0.1.0" });

  server.registerTool(
    "group_send",
    {
      description:
        "Send a message to a FengAgentCli agent group as yourself (the member this MCP server is bound to). " +
        "Use this to speak in the group, ask other members for help, or report progress — without going through the coordinator.",
      inputSchema: {
        groupId: z.string().describe("Group id (use group_list to find)"),
        content: z.string().describe("Message text"),
      },
    },
    async ({ groupId, content }) => {
      const message = await api<{ seq: number; fromName: string }>("POST", "/api/groups/mcp/send", {
        groupId,
        content,
      });
      return { content: [{ type: "text" as const, text: `#${message.seq} [${message.fromName}] sent` }] };
    },
  );

  server.registerTool(
    "group_reply",
    {
      description:
        "Reply to a specific message (by seq) in a FengAgentCli agent group. The reply is prefixed with the reference so threading is visible.",
      inputSchema: {
        groupId: z.string().describe("Group id"),
        replyToSeq: z.number().int().positive().describe("seq of the message to reply to"),
        content: z.string().describe("Reply text"),
      },
    },
    async ({ groupId, replyToSeq, content }) => {
      const message = await api<{ seq: number; fromName: string }>("POST", "/api/groups/mcp/send", {
        groupId,
        content,
        replyToSeq,
      });
      return { content: [{ type: "text" as const, text: `#${message.seq} [${message.fromName}] replied to #${replyToSeq}` }] };
    },
  );

  server.registerTool(
    "group_history",
    {
      description:
        "Read messages from a FengAgentCli agent group (ascending by seq). Pass after=nextSeq from a previous call to poll incrementally.",
      inputSchema: {
        groupId: z.string().describe("Group id"),
        after: z.number().int().optional().describe("Only return messages with seq > after"),
        limit: z.number().int().optional().describe("Max messages (default 50)"),
      },
    },
    async ({ groupId, after, limit }) => {
      const params = new URLSearchParams({ groupId });
      if (after !== undefined) params.set("after", String(after));
      if (limit !== undefined) params.set("limit", String(limit));
      const result = await api<{ messages: Array<{ seq: number; fromName: string; content: string; kind: string }>; nextSeq: number }>(
        "GET",
        `/api/groups/mcp/history?${params.toString()}`,
      );
      const lines = result.messages.map((m) => `#${m.seq} [${m.fromName}]${m.kind !== "chat" ? ` <${m.kind}>` : ""} ${m.content}`);
      return {
        content: [
          { type: "text" as const, text: lines.length > 0 ? lines.join("\n") : `(no messages; nextSeq=${result.nextSeq})` },
        ],
      };
    },
  );

  server.registerTool(
    "group_list",
    {
      description: "List FengAgentCli agent groups (to find groupId before sending).",
      inputSchema: {},
    },
    async () => {
      const result = await api<{ groups: Array<{ id: string; name: string; status: string; members: string[] }> }>(
        "GET",
        "/api/groups/mcp/groups",
      );
      const lines = result.groups.map(
        (g) => `${g.name} [${g.status}] id=${g.id} members=${g.members.join(", ")}`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") || "no groups" }] };
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`[mcp-groups-bridge] connected → ${base}`);
}

void main().catch((err) => {
  console.error(`[mcp-groups-bridge] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
