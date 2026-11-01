/**
 * @fengagent/server — 群 MCP 服务面（v2 V2-1：外部 agent 直连发言）
 *
 * 给 claude / kimi 这类**外部进程** CLI 的注入通道：per-member token 绑定发言身份，
 * 工具直达同一个 `AgentGroupService`（与 dsh 桥 / REST / 群插件同源）。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | POST | `/api/groups/mcp/tokens` | 铸/换某成员的 token（本机管理面，与既有 REST 同信任级） |
 * | GET | `/api/groups/mcp/me` | （Bearer）token → 成员身份 |
 * | POST | `/api/groups/mcp/send` | （Bearer）以 token 成员身份发言（`replyToSeq` 回复指定消息） |
 * | GET | `/api/groups/mcp/history` | （Bearer）增量读群消息（`groupId`/`after`/`limit`） |
 * | GET | `/api/groups/mcp/groups` | （Bearer）群列表（供选择 groupId） |
 *
 * 身份边界：`send` 内部走 `postAgentMessage`（`fromName` 绑死为 token 成员，
 * 非群成员 403、关群 409——复用既有语义，不可伪造）。stdio MCP 桥见
 * `mcp-groups-bridge.ts`（claude `mcp add` 指向它）。
 */

import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentGroupService } from "@fengagent/groups";

/** token → 成员 的映射（持久化到 `<dataRoot>/mcp-tokens.json`） */
class McpTokenStore {
  private readonly file: string;
  private memberByToken = new Map<string, string>();

  constructor(dataRoot: string) {
    this.file = join(dataRoot, "mcp-tokens.json");
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
        for (const [token, member] of Object.entries(parsed)) this.memberByToken.set(token, member);
      } catch {
        // 损坏则视为空（重新铸即可）
      }
    }
  }

  /** 铸/换某成员的 token（旧 token 失效） */
  mint(member: string): string {
    for (const [token, m] of this.memberByToken) {
      if (m === member) this.memberByToken.delete(token);
    }
    const token = `fgm_${randomBytes(24).toString("base64url")}`;
    this.memberByToken.set(token, member);
    this.persist();
    return token;
  }

  memberOf(token: string | undefined | null): string | null {
    if (!token) return null;
    return this.memberByToken.get(token) ?? null;
  }

  private persist(): void {
    const record: Record<string, string> = {};
    for (const [token, member] of this.memberByToken) record[token] = member;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(record));
  }
}

/** 从 Authorization 头解析 Bearer token */
function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

/**
 * 群 MCP 服务面路由。
 *
 * @param service - 群服务（与 REST 同一实例）
 * @param dataRoot - 数据根（token 持久化）
 */
export function createGroupMcpRoutes(service: AgentGroupService, dataRoot: string): Hono {
  const tokens = new McpTokenStore(dataRoot);
  const app = new Hono();

  /** 鉴权：Bearer token → 成员名（失败 401） */
  const authMember = (c: { req: { header(name: string): string | undefined } }): string | null => {
    const member = tokens.memberOf(bearerToken(c.req.header("Authorization")));
    return member;
  };

  // POST /tokens — 铸/换某成员的 token（本机管理面）
  app.post("/tokens", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const member = typeof body.member === "string" ? body.member.trim() : "";
    if (member === "") return c.json({ error: { message: "member 必填", code: "bad_request" } }, 400);
    const token = tokens.mint(member);
    return c.json({ member, token }, 201);
  });

  // GET /me — token → 成员身份（桥自检用）
  app.get("/me", (c) => {
    const member = authMember(c);
    if (!member) return c.json({ error: { message: "token 无效", code: "unauthorized" } }, 401);
    return c.json({ member });
  });

  // POST /send — 以 token 成员身份发言（replyToSeq 可选：回复指定消息）
  app.post("/send", async (c) => {
    const member = authMember(c);
    if (!member) return c.json({ error: { message: "token 无效", code: "unauthorized" } }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (groupId === "" || content.trim() === "") {
      return c.json({ error: { message: "groupId 与 content 必填", code: "bad_request" } }, 400);
    }
    const replyToSeq = typeof body.replyToSeq === "number" ? body.replyToSeq : undefined;
    const finalContent = replyToSeq !== undefined && replyToSeq > 0 ? `↩ #${replyToSeq} ${content}` : content;
    try {
      const message = service.postAgentMessage(groupId, { content: finalContent, fromName: member });
      return c.json(message, 201);
    } catch (err) {
      const payload = err as { message?: string; code?: string };
      const code = payload.code === "forbidden" ? 403 : payload.code === "conflict" ? 409 : 400;
      return c.json({ error: { message: payload.message ?? String(err), code: payload.code ?? "bad_request" } }, code as 400 | 403 | 409);
    }
  });

  // GET /history — 增量读群消息
  app.get("/history", (c) => {
    const member = authMember(c);
    if (!member) return c.json({ error: { message: "token 无效", code: "unauthorized" } }, 401);
    const groupId = c.req.query("groupId") ?? "";
    if (groupId === "") return c.json({ error: { message: "groupId 必填", code: "bad_request" } }, 400);
    if (!service.getGroup(groupId)) {
      return c.json({ error: { message: `群不存在: ${groupId}`, code: "not_found" } }, 404);
    }
    const rawAfter = Number.parseInt(c.req.query("after") ?? "", 10);
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const messages = service.listMessagesAfter(groupId, {
      ...(Number.isFinite(rawAfter) && rawAfter > 0 ? { after: rawAfter } : {}),
      ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}),
    });
    const nextSeq = messages.length > 0 ? messages[messages.length - 1]!.seq : service.store.lastSeq(groupId);
    return c.json({ messages, nextSeq });
  });

  // GET /groups — 群列表（供选择 groupId）
  app.get("/groups", (c) => {
    const member = authMember(c);
    if (!member) return c.json({ error: { message: "token 无效", code: "unauthorized" } }, 401);
    return c.json({ groups: service.listGroups({}) });
  });

  return app;
}
