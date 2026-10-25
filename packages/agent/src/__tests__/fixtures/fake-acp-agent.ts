/**
 * 测试夹具：一个最小的 ACP agent（NDJSON over stdio）
 *
 * 只实现 `AcpClient` 用到的协议面：initialize / session/new / session/prompt /
 * session/cancel / session/request_permission。行为由 prompt 文本里的标记控制：
 *
 * - 含 `SLOW`：每块之间停顿 40ms（用于测取消、测增量）；
 * - 含 `FAIL`：回一条 JSON-RPC error（测失败路径）；
 * - 默认：两块文本 + 一次权限请求（宿主决策后再补一块）。
 *
 * 用法（测试里）：`spawn(process.execPath, [thisFile])`
 */

interface Frame {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const SESSION_ID = "fake-session-1";

function send(message: Frame): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 在飞的 prompt（收到 session/cancel 时用它结算） */
let inflight: { cancelled: boolean; finish(stopReason: string): void } | null = null;

/** 是否收到过 session/cancel（可能早于 inflight 注册，必须记住） */
let cancelRequested = false;

/** 等待宿主对某个出站请求的响应 */
const pendingOutbound = new Map<number, (frame: Frame) => void>();
let nextOutboundId = 100;

function request(method: string, params: Record<string, unknown>): Promise<Frame> {
  const id = ++nextOutboundId;
  return new Promise<Frame>((resolve) => {
    pendingOutbound.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(sessionId: string, update: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function chunk(text: string): void {
  notify(SESSION_ID, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runPrompt(text: string, respond: (result: unknown) => void): Promise<void> {
  if (text.includes("FAIL")) {
    respond({ jsonrpcError: { code: -32000, message: "目标拒绝执行" } });
    return;
  }

  const slow = text.includes("SLOW");
  chunk("你");
  if (slow) await sleep(40);
  chunk("好");
  if (slow) await sleep(40);

  // 一次权限请求：宿主拒绝/放行都要能跑完（不能静默挂起）
  const permission = await request("session/request_permission", {
    sessionId: SESSION_ID,
    toolCallId: "call-1",
    title: "bash",
    rawInput: { command: "echo hi" },
    options: [
      { optionId: "allow-once", kind: "allow_once", label: "允许一次" },
      { optionId: "reject-once", kind: "reject_once", label: "拒绝" },
    ],
  });
  const outcome = (permission.result as { outcome?: { optionId?: string } } | undefined)?.outcome;
  chunk(`[perm:${outcome?.optionId ?? "none"}]`);

  // 取消可能早于/晚于 inflight 注册，两个时机都要能结算
  if (cancelRequested) {
    respond({ stopReason: "cancelled" });
    return;
  }

  let stopReason = "end_turn";
  const finished = new Promise<void>((resolve) => {
    inflight = {
      cancelled: false,
      finish: (reason) => {
        stopReason = reason;
        resolve();
      },
    };
  });
  await Promise.race([finished, sleep(slow ? 3000 : 50)]);
  inflight = null;
  respond({ stopReason: cancelRequested ? "cancelled" : stopReason });
}

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (data: string) => {
  buffer += data;
  while (true) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line !== "") handle(line);
  }
});

function handle(line: string): void {
  let frame: Frame;
  try {
    frame = JSON.parse(line) as Frame;
  } catch {
    return;
  }

  // 宿主对我们出站请求的响应
  if (frame.id !== undefined && frame.method === undefined) {
    const resolver = pendingOutbound.get(Number(frame.id));
    if (resolver) {
      pendingOutbound.delete(Number(frame.id));
      resolver(frame);
    }
    return;
  }

  switch (frame.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: frame.id!,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp", version: "0.0.1" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false },
            sessionCapabilities: { resume: {} },
          },
        },
      });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: frame.id!, result: { sessionId: SESSION_ID } });
      return;
    case "session/resume": {
      // 与真实现一致：必须带 cwd（缺了按 invalid params 拒），并把 sessionId 回给宿主
      const params = (frame.params ?? {}) as { sessionId?: string; cwd?: string };
      if (typeof params.cwd !== "string" || params.cwd === "") {
        send({
          jsonrpc: "2.0",
          id: frame.id!,
          error: { code: -32602, message: "session/resume 缺少 cwd" },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: frame.id!,
        result: { sessionId: params.sessionId ?? SESSION_ID },
      });
      return;
    }
    case "session/prompt": {
      const prompt = (frame.params?.prompt ?? []) as Array<{ text?: string }>;
      const text = prompt.map((part) => part.text ?? "").join("");
      const id = frame.id!;
      void runPrompt(text, (result) => {
        const payload = result as { jsonrpcError?: { code: number; message: string } };
        if (payload.jsonrpcError) {
          send({ jsonrpc: "2.0", id, error: payload.jsonrpcError });
        } else {
          send({ jsonrpc: "2.0", id, result });
        }
      });
      return;
    }
    case "session/cancel":
      cancelRequested = true;
      inflight?.finish("cancelled");
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    default:
      if (frame.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32601, message: `Method not found: ${frame.method ?? ""}` },
        });
      }
  }
}

// 保持进程存活直到 stdin 关闭（父进程 close() 会 EOF 它）
process.stdin.on("end", () => process.exit(0));
