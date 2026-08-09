import { describe, it, expect } from "bun:test";
import {
  createHookRegistry,
} from "../hooks.ts";
import type { HookContext } from "../hooks.ts";
import type { ToolResult } from "@fengagent/core/tool";

const TEST_CTX: HookContext = {
  workdir: "/test",
  sessionId: "test-session",
  messageId: "test-msg",
};

describe("HookRegistry", () => {
  it("registers and triggers pre-tool-use hooks", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.register("pre-tool-use", (toolName) => {
      calls.push(`hook1:${toolName}`);
      return { allowed: true };
    });

    registry.register("pre-tool-use", (toolName) => {
      calls.push(`hook2:${toolName}`);
      return { allowed: true };
    });

    const result = await registry.triggerPreToolUse("bash", {}, TEST_CTX);

    expect(result.allowed).toBe(true);
    expect(calls).toEqual(["hook1:bash", "hook2:bash"]);
  });

  it("short-circuits when a pre-tool-use hook returns allowed=false", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.register("pre-tool-use", () => {
      calls.push("hook1");
      return { allowed: false, reason: "blocked by hook1" };
    });

    registry.register("pre-tool-use", () => {
      calls.push("hook2");
      return { allowed: true };
    });

    const result = await registry.triggerPreToolUse("bash", {}, TEST_CTX);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("blocked by hook1");
    // hook2 should not have been called
    expect(calls).toEqual(["hook1"]);
  });

  it("supports sync and async hooks", async () => {
    const registry = createHookRegistry();

    // Sync hook
    registry.register("pre-tool-use", () => ({ allowed: true }));

    // Async hook
    registry.register("pre-tool-use", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { allowed: true };
    });

    const result = await registry.triggerPreToolUse("test", {}, TEST_CTX);
    expect(result.allowed).toBe(true);
  });

  it("triggers post-tool-use hooks and allows result modification", async () => {
    const registry = createHookRegistry();

    const originalResult: ToolResult = { content: "original" };

    registry.register("post-tool-use", (_toolName, _input, result) => {
      return { ...result, content: result.content + " +hook1" };
    });

    registry.register("post-tool-use", (_toolName, _input, result) => {
      return { ...result, content: result.content + " +hook2" };
    });

    const result = await registry.triggerPostToolUse(
      "test",
      {},
      originalResult,
      TEST_CTX,
    );

    expect(result.content).toBe("original +hook1 +hook2");
  });

  it("triggers pre-compact and post-compact hooks", async () => {
    const registry = createHookRegistry();
    const events: string[] = [];

    registry.register("pre-compact", (msgCount, tokenCount) => {
      events.push(`pre-compact:${msgCount}:${tokenCount}`);
    });

    registry.register("post-compact", (summary, keptCount) => {
      events.push(`post-compact:${summary}:${keptCount}`);
    });

    await registry.triggerPreCompact(50, 10000, TEST_CTX);
    await registry.triggerPostCompact("summary text", 10, TEST_CTX);

    expect(events).toEqual([
      "pre-compact:50:10000",
      "post-compact:summary text:10",
    ]);
  });

  it("unregisters hooks", () => {
    const registry = createHookRegistry();
    const handler = () => ({ allowed: true });

    registry.register("pre-tool-use", handler);
    expect(registry.getHandlers("pre-tool-use").length).toBe(1);

    const removed = registry.unregister("pre-tool-use", handler);
    expect(removed).toBe(true);
    expect(registry.getHandlers("pre-tool-use").length).toBe(0);

    // Unregistering a non-registered handler returns false
    const removed2 = registry.unregister("pre-tool-use", handler);
    expect(removed2).toBe(false);
  });

  it("clears all hooks", () => {
    const registry = createHookRegistry();

    registry.register("pre-tool-use", () => ({ allowed: true }));
    registry.register("post-tool-use", (_n, _i, r) => r);
    registry.register("pre-compact", () => {});
    registry.register("post-compact", () => {});

    registry.clear();

    expect(registry.getHandlers("pre-tool-use").length).toBe(0);
    expect(registry.getHandlers("post-tool-use").length).toBe(0);
    expect(registry.getHandlers("pre-compact").length).toBe(0);
    expect(registry.getHandlers("post-compact").length).toBe(0);
  });

  it("returns a default allow result when no hooks are registered", async () => {
    const registry = createHookRegistry();
    const result = await registry.triggerPreToolUse("test", {}, TEST_CTX);
    expect(result.allowed).toBe(true);
  });

  it("passes through result unchanged when no post-tool-use hooks", async () => {
    const registry = createHookRegistry();
    const original: ToolResult = { content: "unchanged" };
    const result = await registry.triggerPostToolUse("test", {}, original, TEST_CTX);
    expect(result.content).toBe("unchanged");
  });
});
