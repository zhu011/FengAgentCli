// FengAgentCli server client: JSON-over-HTTP wrapper for the group API
// (G1 contract, packages/server/src/routes/groups.ts) plus the agent-task
// dispatch entry (G2, POST /api/agent-tasks). No auth — the server is
// local-first.
//
// Note on send semantics: group messages go through the human entry
// (POST /api/groups/:id/messages). The DSH agent acts as the group
// *operator* — the coordinator runtimes and members react to what it says.
// The agent-message entry is reserved for registered group members
// (fromName must be a member or the coordinator, otherwise 403).

export class FengError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "FengError";
    this.status = info.status;
    this.code = info.code;
  }
}

/**
 * @param {{serverUrl: string, timeoutMs?: number, fetch?: typeof fetch}} opts
 */
export function createFengClient(opts) {
  const base = String(opts.serverUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("fengagent-groups: serverUrl must be an http(s) URL");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  /**
   * One JSON request; throws FengError with the server's message on !ok.
   * The groups API errors as `{error:{message,code}}`, the agent-tasks API
   * as a plain `{error:"..."}` — both are unwrapped here.
   *
   * @template T
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<T>}
   */
  async function request(method, path, body) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let payload = null;
    if (raw !== "") {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const err = payload?.error;
      const message =
        (typeof err === "object" && err !== null && typeof err.message === "string" && err.message) ||
        (typeof err === "string" && err) ||
        `HTTP ${res.status}`;
      throw new FengError(message, {
        status: res.status,
        code: typeof err === "object" && err !== null ? err.code : undefined,
      });
    }
    return payload;
  }

  return {
    serverUrl: base,

    /** GET /api/groups — `{groups, runtimes}`（runtime 卡片供成员选择） */
    listGroups() {
      return request("GET", "/api/groups");
    },

    /**
     * POST /api/groups — 建群（成员未注册/未启用 → 400）。
     * @param {{name: string, members: string[], description?: string,
     *          maxRounds?: number, idleTimeoutMs?: number, createdBy?: string}} input
     */
    createGroup(input) {
      return request("POST", "/api/groups", input);
    },

    /** GET /api/groups/:id — `{group, messages}`（全量） */
    getGroup(id) {
      return request("GET", `/api/groups/${encodeURIComponent(id)}`);
    },

    /**
     * POST /api/groups/:id/messages — 人发言（`kind:"decision"` 即拍板收口）。
     * @param {{content: string, kind?: "chat" | "decision"}} input
     */
    sendGroupMessage(id, input) {
      return request("POST", `/api/groups/${encodeURIComponent(id)}/messages`, input);
    },

    /**
     * GET /api/groups/:id/messages — 增量读取 `{messages, nextSeq}`。
     * @param {{after?: number, limit?: number}} [query]
     */
    groupHistory(id, query = {}) {
      const params = new URLSearchParams();
      if (query.after !== undefined) params.set("after", String(query.after));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request("GET", `/api/groups/${encodeURIComponent(id)}/messages${qs === "" ? "" : `?${qs}`}`);
    },

    /**
     * POST /api/agent-tasks — 建任务并派发（G2：带 `groupId` 则结果自动回群）。
     * @param {{runtime: string, content: string, groupId?: string,
     *          fromSession?: string, idempotencyKey?: string}} input
     */
    dispatchTask(input) {
      return request("POST", "/api/agent-tasks", input);
    },
  };
}
