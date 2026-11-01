/**
 * @fengagent/dsh-compat — P2 服务契约映射验收
 *
 * 覆盖：
 * 1. 消息 → dsh 事件投影（类型/seq/内容块映射，system 跳过）；
 * 2. `ctx.sessions`：create/get/list/flush、cwd 校验、unsupported 边界；
 * 3. `ctx.sessions.fork`：按 seq 截断、消息 id 重发、源会话不被改写；
 * 4. `ctx.agents`：live registry、owner/roots、factory 委托与缺失时的显式失败；
 * 5. initiator 归因边界；
 * 6. `ctx.agentDefaultModel`：fallback 与 switchProvider 委托；
 * 7. 插件装配：`dsh-services` 真的把三个服务挂上 ctx，`inject` 能解析。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SessionStore } from "@fengagent/agent/session";
import type { Message, Session as FengSession } from "@fengagent/core";
import { createRuntime, BUILTIN_PLUGINS } from "@fengagent/cordis";
import type { StorageService } from "@fengagent/cordis";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DshContractError,
  DshContractUnsupportedError,
  type DshContextLike,
} from "../contracts.ts";
import { AgentsCompat, CompatAgent, createCompatAgent } from "../agents.ts";
import { AgentDefaultModelCompat } from "../agent-default-model.ts";
import { projectSessionEvents } from "../projection.ts";
import { CompatSession, SessionsCompat } from "../sessions.ts";

const tempDirs: string[] = [];
const openStores: SessionStore[] = [];

function makeStore(): { store: SessionStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-services-"));
  tempDirs.push(dir);
  const store = new SessionStore(join(dir, "sessions.db"));
  openStores.push(store);
  let closed = false;
  return {
    store,
    dir,
    cleanup: () => {
      if (closed) return;
      closed = true;
      store.close();
      const index = openStores.indexOf(store);
      if (index >= 0) openStores.splice(index, 1);
      rmSync(dir, { recursive: true, force: true });
      const dirIndex = tempDirs.indexOf(dir);
      if (dirIndex >= 0) tempDirs.splice(dirIndex, 1);
    },
  };
}

/** 用真 SessionStore 组一个最小 StorageService（只实现 sessions 映射用到的面） */
function makeStorage(store: SessionStore): StorageService {
  return {
    saveSession: (session: FengSession) => store.saveSession(session),
    loadSession: (id: string) => store.loadSession(id),
    listSessions: () => store.listSessions(),
    deleteSession: (id: string) => store.deleteSession(id),
    saveMessages: (sessionId: string, messages: Message[]) => store.saveMessages(sessionId, messages),
    graph: {
      flush: async () => {},
    },
    flush: async () => {},
  } as unknown as StorageService;
}

/** 最小 Cordis 4 上下文：服务注册走 reflect.provide（测试里只记录，不真装配） */
function makeContext(overrides: Partial<DshContextLike> = {}): DshContextLike {
  return {
    reflect: {
      provide: () => () => {},
      get: (name: string) => (name === "model" ? overrides.model : undefined),
    },
    ...overrides,
  };
}

function userMessage(id: string, text: string, createdAt = 1): Message {
  return { id, role: "user", content: [{ type: "text", text }], createdAt };
}

function assistantMessage(id: string, text: string, createdAt = 2): Message {
  return { id, role: "assistant", content: [{ type: "text", text }], createdAt };
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // 已由用例 cleanup 关闭
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("projectSessionEvents", () => {
  test("user/assistant/tool-result 的类型、seq、内容块映射", () => {
    const messages: Message[] = [
      userMessage("u1", "hi", 10),
      {
        id: "a1",
        role: "assistant",
        createdAt: 11,
        content: [
          { type: "text", text: "calling" },
          { type: "tool-use", id: "call-1", name: "demo", input: { a: 1 } },
        ],
      },
      {
        id: "u2",
        role: "user",
        createdAt: 12,
        content: [
          { type: "tool-result", toolUseId: "call-1", content: "ok", isError: false },
          { type: "text", text: "next" },
        ],
      },
      { id: "s1", role: "system", content: [{ type: "text", text: "sys" }], createdAt: 13 },
    ];

    const events = projectSessionEvents(messages);
    expect(events.map((event) => event.type)).toEqual([
      "user/message",
      "assistant/message",
      "tool/result",
      "user/message",
    ]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);

    const assistant = events[1]!;
    const blocks = (assistant.data.message as { content: unknown[] }).content as Array<
      Record<string, unknown>
    >;
    expect(blocks[0]).toEqual({ type: "text", text: "calling" });
    expect(blocks[1]).toEqual({
      type: "tool-call",
      id: "call-1",
      name: "demo",
      arguments: JSON.stringify({ a: 1 }),
    });

    const toolResult = events[2]!;
    const resultMessage = toolResult.data.message as {
      content: Array<{ toolCallId: string; content: Array<{ text: string }>; isError?: boolean }>;
    };
    expect(resultMessage.content[0]!.toolCallId).toBe("call-1");
    expect(resultMessage.content[0]!.isError).toBe(false);

    // 来源消息下标：tool/result 与随后的 user/message 都来自第 3 条消息（index 2）
    expect(events[2]!.messageIndex).toBe(2);
    expect(events[3]!.messageIndex).toBe(2);
  });
});

describe("ctx.sessions 映射", () => {
  test("create → get → list 持久化往返，events 可读", () => {
    const { store, cleanup } = makeStore();
    try {
      const sessions = new SessionsCompat(makeStorage(store), () => "demo-model");
      const created = sessions.create("session-1", { meta: { cwd: process.cwd() } });
      expect(created.id).toBe("session-1");
      expect(created.header.cwd).toBe(process.cwd());
      expect(created.requestHeader()).toBeUndefined();

      store.saveMessages("session-1", [userMessage("u1", "hello"), assistantMessage("a1", "world")]);

      const loaded = sessions.get("session-1");
      expect(loaded).toBeDefined();
      expect(loaded!.events.map((event) => event.type)).toEqual([
        "user/message",
        "assistant/message",
      ]);
      expect(sessions.list().map((session) => session.id)).toEqual(["session-1"]);
      expect(sessions.get("missing")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("create: 相对 cwd / 重复 id / 非空 seed 都拒绝", () => {
    const { store, cleanup } = makeStore();
    try {
      const sessions = new SessionsCompat(makeStorage(store), () => "m");
      expect(() => sessions.create(undefined, { meta: { cwd: "relative/x" } })).toThrow(
        DshContractError,
      );
      sessions.create("dup");
      expect(() => sessions.create("dup")).toThrow(DshContractError);
      expect(() =>
        sessions.create(undefined, {
          seed: [{ seq: 0, type: "user/message", time: 1, data: {} }],
        }),
      ).toThrow(DshContractUnsupportedError);
    } finally {
      cleanup();
    }
  });

  test("session.append / surface / prepare 都是显式 unsupported，带契约路径", () => {
    const { store, cleanup } = makeStore();
    try {
      const sessions = new SessionsCompat(makeStorage(store), () => "m");
      const session = sessions.create("s1");
      try {
        session.append("session/title", {});
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(DshContractUnsupportedError);
        expect((error as DshContractUnsupportedError).contract).toBe("session.append");
        expect((error as DshContractUnsupportedError).code).toBe("dsh_contract_unsupported");
      }
      expect(() => session.surface).toThrow(DshContractUnsupportedError);
      expect(() => sessions.prepare()).toThrow(DshContractUnsupportedError);
      expect(() => sessions.enter(session)).toThrow(DshContractUnsupportedError);
      expect(() => sessions.announce(session)).toThrow(DshContractUnsupportedError);
    } finally {
      cleanup();
    }
  });

  test("fork：按 inclusive seq 截断、消息 id 重发、源会话不变", () => {
    const { store, cleanup } = makeStore();
    try {
      const sessions = new SessionsCompat(makeStorage(store), () => "m");
      sessions.create("src");
      store.saveMessages("src", [
        userMessage("u1", "one", 1),
        assistantMessage("a1", "two", 2),
        userMessage("u2", "three", 3),
      ]);

      // seq 1 = assistant/message → 保留前两条消息
      const child = sessions.fork("src", 1, "child");
      expect(child.id).toBe("child");
      expect(child.messages.map((message) => message.content)).toEqual([
        [{ type: "text", text: "one" }],
        [{ type: "text", text: "two" }],
      ]);
      expect(child.messages[0]!.id).not.toBe("u1");
      expect(child.header.parentSession).toBe("src");

      const reloadedSource = store.loadSession("src")!;
      expect(reloadedSource.messages.map((message) => message.content)).toEqual([
        [{ type: "text", text: "one" }],
        [{ type: "text", text: "two" }],
        [{ type: "text", text: "three" }],
      ]);
      expect(store.loadSession("src")!.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);

      expect(() => sessions.fork("src", 99)).toThrow(RangeError);
      expect(() => sessions.fork("nope")).toThrow(DshContractError);
    } finally {
      cleanup();
    }
  });

  test("flush 委托 storage.flush", async () => {
    const { store, cleanup } = makeStore();
    try {
      let flushes = 0;
      const storage = makeStorage(store);
      storage.flush = async () => {
        flushes += 1;
      };
      const sessions = new SessionsCompat(storage, () => "m");
      const session = sessions.create("s1");
      await expect(sessions.flush(session)).resolves.toBe(true);
      expect(flushes).toBe(1);
      await expect(sessions.flush({ id: "ghost" } as unknown as CompatSession)).rejects.toThrow(
        DshContractError,
      );
    } finally {
      cleanup();
    }
  });
});

describe("ctx.agents 映射", () => {
  function setup() {
    const { store, cleanup } = makeStore();
    const sessions = new SessionsCompat(makeStorage(store), () => "m");
    const agents = new AgentsCompat(makeContext(), sessions);
    return { store, sessions, agents, cleanup };
  }

  test("register/get/list/roots/isOwnedBy/enter/announce", () => {
    const { sessions, agents, cleanup } = setup();
    try {
      sessions.create("root");
      sessions.create("child");
      const root = createCompatAgent(sessions, "root")!;
      const child = new CompatAgent(sessions.get("child")!);

      expect(root).toBeInstanceOf(CompatAgent);
      const disposeRoot = agents.register(root);
      const disposeChild = agents.enter(child, root);
      expect(agents.get("root")).toBe(root);
      expect(agents.list().map((agent) => agent.id)).toEqual(["root", "child"]);
      expect(agents.roots().map((agent) => agent.id)).toEqual(["root"]);
      expect(agents.isOwnedBy("child", root)).toBe(true);
      expect(agents.isOwnedBy("root", root)).toBe(false);

      agents.announce(child);
      expect(() => agents.announce(child)).toThrow(DshContractError);
      expect(() => agents.register(root)).toThrow(DshContractError);

      disposeChild();
      disposeRoot();
      expect(agents.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("未注册 factory：create/resume 抛 unsupported；resume 先校验会话存在", async () => {
    const { sessions, agents, cleanup } = setup();
    try {
      sessions.create("exists");
      await expect(agents.create({ sessionId: "x" })).rejects.toBeInstanceOf(
        DshContractUnsupportedError,
      );
      await expect(agents.resume({ resumeSessionId: "exists" })).rejects.toBeInstanceOf(
        DshContractUnsupportedError,
      );
      await expect(agents.resume({ resumeSessionId: "missing" })).rejects.toBeInstanceOf(
        DshContractError,
      );
    } finally {
      cleanup();
    }
  });

  test("factory 注册后 create/resume 原样委托，disposer 清槽", async () => {
    const { sessions, agents, cleanup } = setup();
    try {
      sessions.create("exists");
      const calls: string[] = [];
      const handle = {
        agent: createCompatAgent(sessions, "exists")!,
        dispose: async () => {},
      };
      const dispose = agents.setFactory({
        createAgent: async (_ownerCtx, options) => {
          calls.push(`create:${options.sessionId}`);
          return handle;
        },
        resume: async (_ownerCtx, options) => {
          calls.push(`resume:${options.resumeSessionId}`);
          return handle;
        },
      });
      expect(() =>
        agents.setFactory({
          createAgent: async () => handle,
          resume: async () => handle,
        }),
      ).toThrow(DshContractError);

      await expect(agents.create({ sessionId: "new" })).resolves.toBe(handle);
      await expect(agents.resume({ resumeSessionId: "exists" })).resolves.toBe(handle);
      expect(calls).toEqual(["create:new", "resume:exists"]);

      dispose();
      await expect(agents.create({ sessionId: "new" })).rejects.toBeInstanceOf(
        DshContractUnsupportedError,
      );
    } finally {
      cleanup();
    }
  });

  test("initiator：with/without/current/require", () => {
    const { sessions, agents, cleanup } = setup();
    try {
      sessions.create("a1");
      const agent = createCompatAgent(sessions, "a1")!;
      expect(agents.currentInitiator()).toBeUndefined();
      expect(() => agents.requireInitiator()).toThrow(DshContractError);

      const seen = agents.withInitiator(agent, () => agents.currentInitiator());
      expect(seen).toBe(agent);
      expect(agents.currentInitiator()).toBeUndefined();

      const cleared = agents.withInitiator(agent, () =>
        agents.withoutInitiator(() => agents.currentInitiator()),
      );
      expect(cleared).toBeUndefined();

      expect(() => agents.withInitiator({ id: "", session: {} } as never, () => 1)).toThrow(
        DshContractError,
      );
    } finally {
      cleanup();
    }
  });
});

describe("ctx.agentDefaultModel 映射", () => {
  test("无模型服务时用 fallback；有模型服务时读写走 switchProvider", async () => {
    const ctx = makeContext();
    const service = new AgentDefaultModelCompat(ctx, { provider: "p0", model: "m0" });
    expect(service.currentSelection()).toEqual({ provider: "p0", model: "m0" });

    await service.saveSelection({ provider: "p1", model: "m1" });
    expect(service.currentSelection()).toEqual({ provider: "p1", model: "m1" });
    await expect(service.saveSelection({ provider: "", model: "m" })).rejects.toThrow(
      DshContractError,
    );

    const switched: Array<[string, string | undefined]> = [];
    const liveCtx = makeContext({
      model: {
        provider: "live",
        model: "live-model",
        switchProvider: async (provider: string, options?: { model?: string }) => {
          switched.push([provider, options?.model]);
        },
      },
    });
    const live = new AgentDefaultModelCompat(liveCtx, { provider: "p0", model: "m0" });
    expect(live.currentSelection()).toEqual({ provider: "live", model: "live-model" });
    await live.saveSelection({ provider: "next", model: "next-model", reasoningEffort: "high" });
    expect(switched).toEqual([["next", "next-model"]]);
  });
});

describe("dsh-services 插件装配", () => {
  test("挂上 sessions/agents/agentDefaultModel，且 inject 可解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-services-runtime-"));
    try {
      const runtime = createRuntime({
        workdir: ".",
        plugins: [
          { id: BUILTIN_PLUGINS.STORAGE, config: { dbPath: join(dir, "sessions.db") } },
          { id: "../../dsh-compat/src/services-plugin.ts" },
          { id: "../../dsh-compat/src/__tests__/fixtures/dsh-session-consumer/plugin.mjs" },
        ],
      });
      await runtime.start();
      try {
        const ctx = runtime.ctx as unknown as {
          sessions: SessionsCompat;
          agents: AgentsCompat;
          agentDefaultModel: AgentDefaultModelCompat;
        };
        expect(ctx.sessions).toBeInstanceOf(SessionsCompat);
        expect(ctx.agents).toBeInstanceOf(AgentsCompat);
        expect(ctx.agentDefaultModel).toBeInstanceOf(AgentDefaultModelCompat);

        const session = ctx.sessions.create("plugin-created");
        expect(ctx.sessions.get(session.id)?.events).toEqual([]);
      } finally {
        await runtime.stop();
      }
    } finally {
      // runtime.stop() 不会关闭 feng.storage 的 SQLite 句柄（与生产一致），
      // 清理失败不算用例失败——临时目录留给 OS。
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // EBUSY on Windows: 句柄仍被打开
      }
    }
  });
});
