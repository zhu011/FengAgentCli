/**
 * @fengagent/server — ACP 续聊的落盘契约测试
 *
 * 第四根因（Multica 里「首次对话正常、第二次对话必失败」）有两层：
 *
 * 1. `session/resume` 未实现 → 回 `-32601 "Method not found"`；
 * 2. 修完第 1 层后如果 Agent **没拿到 `sessionStore`**，新会话只会留下一个空壳
 *    会话行、消息一条都不落盘 —— 此时 resume「成功但失忆」，宿主侧看不出报错，
 *    用户侧却是上下文丢失。
 *
 * 本测试用真实 `SessionStore` + 假 Agent 把「新会话落盘 → 下个进程按 id 读回 →
 * 续聊 prompt 命中同一会话」整条契约钉死；`acp-mode.ts` 负责把同一个 store 同时
 * 交给 `createSessionEntry` / `resumeAgent` / `Agent`，任何一环断掉这里都会红。
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@fengagent/agent";
import { createSession, createUserMessage, type AgentEvent, type Message, type Session } from "@fengagent/core";
import type { Agent } from "@fengagent/agent";
import { startAcpStdioServer } from "../acp-stdio.ts";

/** 内存输出端：按行收集协议帧 */
class FrameCollector {
  lines: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.lines.push(chunk);
    callback?.();
    return true;
  }

  frames(): Array<Record<string, unknown>> {
    return this.lines
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const hit = this.frames().find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`等待协议帧超时；已收到:\n${this.lines.join("")}`);
  }
}

/** 一轮对话的事件脚本 */
function turn(text: string): AgentEvent[] {
  return [
    { type: "message-start", messageId: "m1", role: "assistant" },
    { type: "text-delta", messageId: "m1", text: `echo:${text}` },
    { type: "message-end", messageId: "m1" },
    { type: "turn-end", reason: "end_turn" },
    { type: "session-end" },
  ];
}

/** 造一条助手消息（与真实 Agent 一样把助手回合写进会话） */
function assistantMessage(text: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: [{ type: "text", text: `echo:${text}` }],
    createdAt: Date.now(),
  };
}

/**
 * 造一个与真实 Agent 同持久化语义的假 Agent：
 * 拿到 sessionStore 就在 prompt 前后写库（与 `Agent.prompt` 的落盘点一致）。
 */
function makePersistentAgentFactory(store: SessionStore) {
  const seen: Array<{ sessionId: string; messages: number }> = [];
  const factory = (): Agent => {
    let bound: Session | undefined;
    const agent = {
      createSession: () => createSession("fake-model"),
      async *prompt(text: string, session?: Session): AsyncGenerator<AgentEvent> {
        const sess = session!;
        bound = sess;
        const userMsg = createUserMessage(text);
        sess.messages.push(userMsg);
        store.saveSession(sess);
        store.saveMessage(sess.id, userMsg);
        seen.push({ sessionId: sess.id, messages: sess.messages.length });

        for (const event of turn(text)) yield event;

        // 真实 Agent 在 loop 结束后把助手消息补进会话并整表回写
        sess.messages.push(assistantMessage(text));
        sess.status = "idle";
        store.saveSession(sess);
        store.saveMessages(sess.id, sess.messages);
      },
    } as unknown as Agent;
    void bound;
    return agent;
  };
  return { factory, seen };
}

/** 建一个「新进程」视角的连接：同一个库，全新装配 */
function connect(
  store: SessionStore,
  options: { withStore?: boolean } = {},
) {
  const input = new EventEmitter();
  const output = new FrameCollector();
  const { factory, seen } = makePersistentAgentFactory(store);
  const withStore = options.withStore ?? true;
  const connection = startAcpStdioServer({
    createAgent: () => factory(),
    createSessionEntry: () => ({ agent: factory(), session: createSession("fake-model") }),
    resumeAgent: (_workdir, sessionId) => {
      // 与 acp-mode.ts 同语义：命中落盘记录则恢复，否则同 id 空会话
      const restored = withStore ? store.loadSession(sessionId) : null;
      if (restored) return { agent: factory(), session: restored };
      const session = createSession("fake-model");
      session.id = sessionId;
      return { agent: factory(), session };
    },
    config: { contextWindow: 100000 },
    input,
    output,
    exitOnClose: false,
    log: () => {},
  });

  let nextId = 0;
  return {
    seen,
    connection,
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = ++nextId;
      input.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return output.waitFor((frame) => frame["id"] === id);
    },
  };
}

function newStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "fengacp-store-"));
  return new SessionStore(join(dir, "sessions.db"));
}

describe("ACP 续聊落盘契约", () => {
  it("新会话的消息真的落盘后，下一个「进程」按 id 恢复出完整上下文", async () => {
    const store = newStore();

    // 进程 1：session/new → prompt（消息落盘）
    const p1 = connect(store);
    const created = await p1.request("session/new", { cwd: process.cwd() });
    const sessionId = (created["result"] as { sessionId: string }).sessionId;
    await p1.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "暗号是紫色鲸鱼" }],
    });
    p1.connection.dispose();

    // 落盘事实：会话行 + 两条消息（用户 + 助手）
    const persisted = store.loadSession(sessionId);
    expect(persisted).not.toBeNull();
    expect(persisted!.messages.length).toBe(2);

    // 进程 2：全新装配，只带 sessionId → resume 必须读出这两条消息
    const p2 = connect(store);
    const resumed = await p2.request("session/resume", { sessionId, cwd: process.cwd() });
    expect(resumed["error"]).toBeUndefined();
    expect((resumed["result"] as { sessionId: string }).sessionId).toBe(sessionId);

    await p2.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "续聊" }],
    });
    // resume 时已有 2 条历史，prompt 追加用户消息后进入 loop = 3 条起
    expect(p2.seen[0]).toEqual({ sessionId, messages: 3 });
    p2.connection.dispose();

    // 第二轮结束后历史继续累积（同一会话，不是新建）
    expect(store.loadSession(sessionId)!.messages.length).toBe(4);
  });

  it("会话库没被接上时，resume 只能退化为「同 id 空会话」（失忆）——本测试钉住该差异", async () => {
    const store = newStore();

    const p1 = connect(store);
    const created = await p1.request("session/new", { cwd: process.cwd() });
    const sessionId = (created["result"] as { sessionId: string }).sessionId;
    await p1.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "暗号是紫色鲸鱼" }],
    });
    p1.connection.dispose();
    expect(store.loadSession(sessionId)!.messages.length).toBe(2);

    // 不接库的「进程 2」：resume 仍成功、仍是同一个 id，但历史为空
    const p2 = connect(store, { withStore: false });
    const resumed = await p2.request("session/resume", { sessionId, cwd: process.cwd() });
    expect(resumed["error"]).toBeUndefined();
    await p2.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "续聊" }],
    });
    // 只有本轮用户消息 → 说明「返回成功」并不等于「上下文延续」
    expect(p2.seen[0]).toEqual({ sessionId, messages: 1 });
    p2.connection.dispose();
  });
});
