// In-process fake of the FengAgentCli server surface the bridge touches:
// GET/POST /api/groups, GET /api/groups/:id, POST /api/groups/:id/messages,
// GET /api/groups/:id/messages, POST /api/agent-tasks.
// Mirrors the error contracts: groups answer `{error:{message,code}}`,
// agent-tasks answers a plain `{error:"..."}`.
import { createServer } from "node:http";

/**
 * @param {object} [opts]
 * @param {string[]} [opts.runtimes] - known runtime names (default fengagent + claude)
 * @returns {Promise<{server: import("node:http").Server, url: string,
 *           requests: {method: string, path: string, body: any}[], state: any}>}
 */
export async function startFakeFengServer(opts = {}) {
  const runtimes = opts.runtimes ?? ["fengagent", "claude"];
  const groups = new Map();
  const tasks = [];
  const requests = [];
  let groupSeq = 0;
  let msgSeq = 0;
  let taskSeq = 0;

  const groupCard = (g) => ({
    id: g.id,
    name: g.name,
    description: g.description ?? "",
    members: g.members,
    status: g.status,
    maxRounds: g.maxRounds ?? 20,
    idleTimeoutMs: g.idleTimeoutMs ?? 600_000,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ method: req.method, path: url.pathname + url.search, body });
      const json = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // ── /api/groups ─────────────────────────────────────────────
      if (url.pathname === "/api/groups" && req.method === "GET") {
        return json(200, {
          groups: [...groups.values()].map(groupCard),
          runtimes: runtimes.map((name) => ({
            name,
            command: "fake",
            agentName: name,
            agentVersion: "0",
            capabilities: { resume: true, loadSession: true, image: false },
            probeStatus: "ok",
            enabled: true,
            recentTaskCount: 0,
          })),
        });
      }
      if (url.pathname === "/api/groups" && req.method === "POST") {
        const unknown = (body?.members ?? []).filter((m) => !runtimes.includes(m));
        if (unknown.length > 0) {
          return json(400, { error: { message: `成员未注册/未启用: ${unknown.join(",")}`, code: "bad_request" } });
        }
        const now = new Date().toISOString();
        const g = {
          id: `grp-${++groupSeq}`,
          name: body?.name ?? "",
          description: body?.description,
          members: body?.members ?? [],
          status: "open",
          maxRounds: body?.maxRounds,
          idleTimeoutMs: body?.idleTimeoutMs,
          createdAt: now,
          updatedAt: now,
          messages: [],
          lastSeq: 0,
        };
        groups.set(g.id, g);
        return json(201, groupCard(g));
      }

      // ── /api/groups/:id(/messages)? ─────────────────────────────
      const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
      if (groupMatch && req.method === "GET") {
        const g = groups.get(groupMatch[1]);
        if (!g) return json(404, { error: { message: `群不存在: ${groupMatch[1]}`, code: "not_found" } });
        return json(200, { group: groupCard(g), messages: g.messages });
      }
      const msgMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/messages$/);
      if (msgMatch && req.method === "POST") {
        const g = groups.get(msgMatch[1]);
        if (!g) return json(404, { error: { message: `群不存在: ${msgMatch[1]}`, code: "not_found" } });
        if (g.status === "concluded") {
          return json(409, { error: { message: "群已收口", code: "conflict" } });
        }
        if (typeof body?.content !== "string" || body.content.trim() === "") {
          return json(400, { error: { message: "content 必填", code: "bad_request" } });
        }
        const m = {
          id: `msg-${++msgSeq}`,
          groupId: g.id,
          seq: ++g.lastSeq,
          fromKind: "human",
          fromName: "human",
          content: body.content,
          kind: body.kind ?? "chat",
          createdAt: new Date().toISOString(),
        };
        if (m.kind === "decision") g.status = "concluded";
        g.messages.push(m);
        return json(201, m);
      }
      if (msgMatch && req.method === "GET") {
        const g = groups.get(msgMatch[1]);
        if (!g) return json(404, { error: { message: `群不存在: ${msgMatch[1]}`, code: "not_found" } });
        const after = Number.parseInt(url.searchParams.get("after") ?? "", 10);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        let messages = g.messages.filter((m) => !(Number.isFinite(after) && after > 0) || m.seq > after);
        if (Number.isFinite(limit) && limit > 0) messages = messages.slice(0, limit);
        const nextSeq = messages.length > 0 ? messages[messages.length - 1].seq : (g.lastSeq ?? 0);
        return json(200, { messages, nextSeq });
      }

      // ── /api/agent-tasks ────────────────────────────────────────
      if (url.pathname === "/api/agent-tasks" && req.method === "POST") {
        if (typeof body?.runtime !== "string" || body.runtime.trim() === "") {
          return json(400, { error: "runtime 必填" });
        }
        if (typeof body?.content !== "string" || body.content.trim() === "") {
          return json(400, { error: "content 必填" });
        }
        const t = {
          id: `task-${++taskSeq}`,
          fromSession: body.fromSession ?? "web-ui",
          runtime: body.runtime,
          status: "dispatched",
          content: body.content,
          groupId: body.groupId,
          createdAt: new Date().toISOString(),
        };
        tasks.push(t);
        return json(201, t);
      }

      json(404, { error: { message: `no route: ${req.method} ${url.pathname}`, code: "not_found" } });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    state: { groups, tasks, runtimes },
  };
}
