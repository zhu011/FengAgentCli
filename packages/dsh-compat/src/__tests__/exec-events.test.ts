/**
 * @fengagent/dsh-compat — P2 工具执行上下文 + dsh 事件桥验收
 *
 * 覆盖市场插件实测暴露的两个适配点：
 * 1. **exec 上下文**：dsh 工具体必须拿到 `exec.agent` / `exec.token` /
 *    `exec.arguments` / `deferContext` / `concludeTurn`（P1 只给了 `{ signal }`）；
 * 2. **事件桥**：`tools/pre-execute` / `tools/post-execute` ↔ FengAgentCli
 *    `HookRegistry`，并且三段（pre / 工具体 / post）共享同一份 `exec`。
 *
 * 事件用**真实 Cordis 运行时**（`createRuntime` → `ctx.waterfall`/`ctx.on`），
 * 钩子用**真实** `createHookRegistry()`：这里验证的是接线，不是 mock 的形状。
 */

import { describe, expect, test } from "bun:test";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolContext } from "@fengagent/core";
import { createRuntime } from "@fengagent/cordis";
import { createHookRegistry } from "@fengagent/tools";
import { adaptDshTool } from "../adapter.ts";
import {
  createDshExecContext,
  resolveAgentFromServices,
  type DshToolExec,
} from "../exec-context.ts";
import {
  DshToolEventBridge,
  type DshEventContextLike,
  type DshEventExec,
  type DshHookContextLike,
  type DshHookRegistryLike,
  type DshPostDecision,
  type DshPreDecision,
} from "../events.ts";

function fakeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workdir: ".", sessionId: "session-1", messageId: "msg-1", ...overrides };
}

function fakeHookContext(overrides: Partial<DshHookContextLike> = {}): DshHookContextLike {
  return { workdir: ".", sessionId: "session-1", messageId: "msg-1", ...overrides };
}

/** 事件面（真实 cordis ctx 的测试视图） */
type TestEvents = Omit<DshEventContextLike, "on"> & {
  on(name: string, listener: (...args: unknown[]) => unknown): () => boolean;
};

/** 起一个空的 FengAgentCli 运行时，只借它的 Cordis 事件总线 */
async function withEvents<T>(fn: (ctx: TestEvents) => Promise<T>): Promise<T> {
  const runtime = createRuntime({ workdir: ".", plugins: [] });
  await runtime.start();
  try {
    return await fn(runtime.ctx as unknown as TestEvents);
  } finally {
    await runtime.stop();
  }
}

/** 一个最小 dsh 工具；`onExec` 可在工具体里断言 `exec` */
function makeProbeTool(onExec: (exec: DshToolExec) => unknown) {
  return defineTool({
    name: "demo_probe",
    description: "Records the exec it was handed",
    parameters: {
      note: { type: "string", required: true, description: "anything" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { ok: { type: "boolean", required: true } },
      },
      render: () => [{ type: "text", text: "probed" }],
    },
    async execute(_args, exec) {
      onExec(exec as unknown as DshToolExec);
      return { ok: true };
    },
  });
}

/* ------------------------------ exec 上下文 ------------------------------ */

describe("exec 上下文（exec.agent / exec.token / deferContext）", () => {
  test("dsh 工具体拿到完整 exec：agent、token、冻结入参", async () => {
    const seen: DshToolExec[] = [];
    const tool = adaptDshTool(makeProbeTool((exec) => seen.push(exec)), {
      execContext: createDshExecContext({ resolveAgent: () => ({ id: "agent-1" }) }),
    });

    const result = await tool.execute({ note: "hi" }, fakeToolContext());

    const exec = seen[0];
    expect(exec).toBeDefined();
    expect(exec!.name).toBe("demo_probe");
    expect(exec!.agent).toEqual({ id: "agent-1" });
    expect(typeof exec!.token).toBe("symbol");
    expect(exec!.callId).toContain("demo_probe");
    expect(exec!.rootCallId).toBe(exec!.callId);
    expect(Object.isFrozen(exec!.arguments)).toBe(true);
    expect(exec!.signal).toBeInstanceOf(AbortSignal);
    expect(result.content).toBe("probed");
  });

  test("callId 每次调用唯一；没有 agent 时不伪造", async () => {
    const seen: DshToolExec[] = [];
    const tool = adaptDshTool(makeProbeTool((exec) => seen.push(exec)), {
      execContext: createDshExecContext(),
    });

    await tool.execute({ note: "a" }, fakeToolContext());
    await tool.execute({ note: "b" }, fakeToolContext());

    expect(seen).toHaveLength(2);
    expect(seen[0]!.callId).not.toBe(seen[1]!.callId);
    expect(seen[0]!.token).not.toBe(seen[1]!.token);
    expect(seen[0]!.agent).toBeUndefined();
  });

  test("deferContext / concludeTurn 不抛错，并记录在 exec 上", async () => {
    const deferred: unknown[] = [];
    const concluded: string[] = [];
    let seen: DshToolExec | undefined;
    const tool = adaptDshTool(
      makeProbeTool((exec) => {
        seen = exec;
        exec.deferContext({ type: "user", text: "hint" });
        exec.concludeTurn();
      }),
      {
        execContext: createDshExecContext({
          onDeferredContext: (context) => deferred.push(context),
          onConcludeTurn: (exec) => concluded.push(exec.callId),
        }),
      },
    );

    await tool.execute({ note: "x" }, fakeToolContext());

    expect(seen!.deferredContexts).toHaveLength(1);
    expect(seen!.concludedTurn).toBe(true);
    expect(deferred).toHaveLength(1);
    expect(concluded[0]).toBe(seen!.callId);
  });

  test("resolveAgentFromServices：live registry 优先，回落会话投影，缺失为 undefined", () => {
    const live = { id: "session-1", session: { id: "session-1" }, live: true };
    const session = { id: "session-1" };

    const fromRegistry = resolveAgentFromServices((name) =>
      name === "agents" ? { get: () => live } : { get: () => session },
    );
    expect(fromRegistry({ toolName: "t", input: {}, context: fakeToolContext() })).toBe(live);

    const fromSessions = resolveAgentFromServices((name) =>
      name === "sessions" ? { get: () => session } : undefined,
    );
    expect(fromSessions({ toolName: "t", input: {}, context: fakeToolContext() })).toEqual({
      id: "session-1",
      session,
    });

    const missing = resolveAgentFromServices(() => undefined);
    expect(missing({ toolName: "t", input: {}, context: fakeToolContext() })).toBeUndefined();
  });
});

/* ------------------------------ 事件桥：dsh → feng ------------------------------ */

describe("事件桥 preExecute / postExecute（发 dsh 事件）", () => {
  test("pre-execute：监听器收到 exec，allow 透传", async () => {
    await withEvents(async (ctx) => {
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      let seen: DshEventExec | undefined;
      ctx.on("tools/pre-execute", (exec) => {
        seen = exec as DshEventExec;
        return { kind: "allow" };
      });

      const decision = await bridge.preExecute({
        callId: "c1",
        rootCallId: "c1",
        name: "demo",
        arguments: { a: 1 },
        token: Symbol("t"),
      });

      expect(decision).toEqual<DshPreDecision>({ kind: "allow" });
      expect(seen!.name).toBe("demo");
      expect(seen!.arguments).toEqual({ a: 1 });
    });
  });

  test("pre-execute：deny 带原因；不调 next 的否决收敛为 deny", async () => {
    await withEvents(async (ctx) => {
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      const exec: DshEventExec = { callId: "c1", rootCallId: "c1", name: "demo", arguments: {} };

      ctx.on("tools/pre-execute", () => ({ kind: "deny", reason: "policy says no" }));
      expect(await bridge.preExecute(exec)).toEqual<DshPreDecision>({
        kind: "deny",
        reason: "policy says no",
      });
    });

    await withEvents(async (ctx) => {
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      // 不调用 next、也不返回决策 = 否决（dsh waterfall 语义）
      ctx.on("tools/pre-execute", () => undefined);
      const decision = await bridge.preExecute({
        callId: "c2",
        rootCallId: "c2",
        name: "demo",
        arguments: {},
      });
      expect(decision.kind).toBe("deny");
    });
  });

  test("pre-execute：监听器抛错被包含（放行），不把工具执行带崩", async () => {
    await withEvents(async (ctx) => {
      const warnings: string[] = [];
      const bridge = new DshToolEventBridge(ctx, { onWarning: (m) => warnings.push(m) });
      ctx.on("tools/pre-execute", () => {
        throw new Error("audit exploded");
      });
      const decision = await bridge.preExecute({
        callId: "c3",
        rootCallId: "c3",
        name: "demo",
        arguments: {},
      });
      expect(decision).toEqual<DshPreDecision>({ kind: "allow" });
      expect(warnings).toHaveLength(1);
    });
  });

  test("post-execute：block 转 feedback 文本，accept 可替换展示文本", async () => {
    await withEvents(async (ctx) => {
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      const exec: DshEventExec = { callId: "c1", rootCallId: "c1", name: "demo", arguments: {} };

      ctx.on("tools/post-execute", () => ({
        kind: "block",
        feedback: [{ type: "text", text: "结果不合规" }],
      }));
      expect(await bridge.postExecute(exec, { isError: false, content: "ok" })).toEqual<DshPostDecision>({
        kind: "block",
        feedback: "结果不合规",
      });
    });
  });
});

/* ------------------------------ 事件桥：feng → dsh ------------------------------ */

describe("事件桥 attach(HookRegistry)（原生工具也发 dsh 事件）", () => {
  test("原生工具：pre/post 都发事件，deny 真的拦住", async () => {
    await withEvents(async (ctx) => {
      const hooks = createHookRegistry();
      const bridge = new DshToolEventBridge(ctx, {
        resolveAgent: () => ({ id: "agent-hook" }),
        onWarning: () => {},
      });
      const dispose = bridge.attach(hooks as unknown as DshHookRegistryLike);

      const seen: Array<{ exec: DshEventExec; phase: string }> = [];
      ctx.on("tools/pre-execute", (exec) => {
        seen.push({ exec: exec as DshEventExec, phase: "pre" });
        return { kind: "allow" };
      });
      ctx.on("tools/post-execute", (exec) => {
        seen.push({ exec: exec as DshEventExec, phase: "post" });
        return { kind: "accept" };
      });

      // 执行器对同一次调用复用同一个 hookCtx（pre/post 因此共享 exec）
      const hookCtx = fakeHookContext();
      const pre = await hooks.triggerPreToolUse("bash", { cmd: "ls" }, hookCtx);
      expect(pre.allowed).toBe(true);

      const post = await hooks.triggerPostToolUse(
        "bash",
        { cmd: "ls" },
        { content: "file.txt" },
        hookCtx,
      );
      expect(post.content).toBe("file.txt");

      expect(seen.map((s) => s.phase)).toEqual(["pre", "post"]);
      // pre/post 共享同一份 exec（dsh 的身份语义）
      expect(seen[0]!.exec.token).toBe(seen[1]!.exec.token);
      expect(seen[0]!.exec.agent).toEqual({ id: "agent-hook" });

      dispose();
      const afterDispose = await hooks.triggerPreToolUse("bash", {}, fakeHookContext());
      expect(afterDispose.allowed).toBe(true);
      expect(seen).toHaveLength(2);
    });
  });

  test("原生工具：dsh 侧 deny → HookRegistry 拒绝；block → 结果变错误", async () => {
    await withEvents(async (ctx) => {
      const hooks = createHookRegistry();
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      bridge.attach(hooks as unknown as DshHookRegistryLike);

      ctx.on("tools/pre-execute", () => ({ kind: "deny", reason: "writing-guard 拦截" }));
      const blocked = await hooks.triggerPreToolUse("write_file", {}, fakeHookContext());
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("writing-guard");

      ctx.on("tools/post-execute", () => ({ kind: "block", feedback: "禁用句式" }));
      const result = await hooks.triggerPostToolUse(
        "write_file",
        {},
        { content: "因此，综上所述……" },
        fakeHookContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toBe("禁用句式");
    });
  });

  test("ask 在 hook 阶段 fail-closed 转拒绝（没有审批服务）", async () => {
    await withEvents(async (ctx) => {
      const hooks = createHookRegistry();
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      bridge.attach(hooks as unknown as DshHookRegistryLike);

      ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "需要人工批准" }));
      const result = await hooks.triggerPreToolUse("rm_rf", {}, fakeHookContext());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("fail-closed");
    });
  });

  test("已被适配器接管的 dsh 工具：钩子路径跳过，避免同一次调用发两份事件", async () => {
    await withEvents(async (ctx) => {
      const hooks = createHookRegistry();
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      bridge.attach(hooks as unknown as DshHookRegistryLike);
      bridge.markDshTool("demo_probe");

      let calls = 0;
      ctx.on("tools/pre-execute", () => {
        calls += 1;
        return { kind: "deny", reason: "should not be reached" };
      });

      const result = await hooks.triggerPreToolUse("demo_probe", {}, fakeHookContext());
      expect(result.allowed).toBe(true);
      expect(calls).toBe(0);

      bridge.unmarkDshTool("demo_probe");
      const afterUnmark = await hooks.triggerPreToolUse("demo_probe", {}, fakeHookContext());
      expect(afterUnmark.allowed).toBe(false);
      expect(calls).toBe(1);
    });
  });
});

/* ------------------------------ 适配器 + 事件桥（同一 exec） ------------------------------ */

describe("adaptDshTool + 事件桥：一次调用三段共享同一 exec", () => {
  test("pre → 工具体 → post 的 token 一致；pre deny 不执行工具体", async () => {
    await withEvents(async (ctx) => {
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      const events: Array<{ phase: string; exec: DshEventExec }> = [];
      let bodyExec: DshToolExec | undefined;

      const tool = adaptDshTool(
        makeProbeTool((exec) => {
          bodyExec = exec;
        }),
        {
          execContext: createDshExecContext({ resolveAgent: () => ({ id: "agent-1" }) }),
          events: bridge,
        },
      );

      const accept = ctx.on("tools/pre-execute", (exec) => {
        events.push({ phase: "pre", exec: exec as DshEventExec });
        return { kind: "allow" };
      });
      ctx.on("tools/post-execute", (exec) => {
        events.push({ phase: "post", exec: exec as DshEventExec });
        return { kind: "accept" };
      });

      const result = await tool.execute({ note: "x" }, fakeToolContext());
      expect(result.isError).toBeUndefined();
      expect(events.map((e) => e.phase)).toEqual(["pre", "post"]);
      expect(events[0]!.exec.token).toBe(bodyExec!.token);
      expect(events[1]!.exec.token).toBe(bodyExec!.token);
      expect(events[0]!.exec.agent).toEqual({ id: "agent-1" });
      accept();

      // pre deny：工具体不应执行
      let bodyCalls = 0;
      const deniedTool = adaptDshTool(makeProbeTool(() => (bodyCalls += 1)), {
        execContext: createDshExecContext(),
        events: bridge,
      });
      ctx.on("tools/pre-execute", () => ({ kind: "deny", reason: "policy" }));
      const denied = await deniedTool.execute({ note: "y" }, fakeToolContext());
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain("policy");
      expect(bodyCalls).toBe(0);
    });
  });

  test("post-execute block → 工具结果转错误；accept+content → 替换展示文本", async () => {
    await withEvents(async (ctx) => {
      const bridge = new DshToolEventBridge(ctx, { onWarning: () => {} });
      let handler: DshPostDecision = { kind: "block", feedback: "不合规输出" };
      ctx.on("tools/post-execute", () => handler);

      const tool = adaptDshTool(makeProbeTool(() => {}), {
        execContext: createDshExecContext(),
        events: bridge,
      });

      const blocked = await tool.execute({ note: "x" }, fakeToolContext());
      expect(blocked.isError).toBe(true);
      expect(blocked.content).toBe("不合规输出");
      expect((blocked.metadata as { blockedByDshPostExecute?: boolean }).blockedByDshPostExecute).toBe(
        true,
      );

      handler = { kind: "accept", content: "改写后的展示文本" };
      const rewritten = await tool.execute({ note: "x" }, fakeToolContext());
      expect(rewritten.isError).toBeUndefined();
      expect(rewritten.content).toBe("改写后的展示文本");
      expect((rewritten.metadata as { ok?: boolean }).ok).toBe(true);
    });
  });
});
