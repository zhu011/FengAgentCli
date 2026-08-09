import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createToolExecutor,
  createHookRegistry,
} from "../index.ts";
import type { ToolDefinition, ToolContext } from "@fengagent/core/tool";
import { z } from "zod";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_WORKDIR = join(tmpdir(), "fengagent-exec-test");
const TEST_CONTEXT: ToolContext = {
  workdir: TEST_WORKDIR,
  sessionId: "test-session",
  messageId: "test-msg",
};

function setup(): void {
  if (!existsSync(TEST_WORKDIR)) {
    mkdirSync(TEST_WORKDIR, { recursive: true });
  }
}

function cleanup(): void {
  if (existsSync(TEST_WORKDIR)) {
    rmSync(TEST_WORKDIR, { recursive: true, force: true });
  }
}

const echoTool: ToolDefinition<{ text: string }> = {
  name: "echo",
  description: "Echoes text back",
  inputSchema: z.object({ text: z.string() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input) {
    return { content: input.text };
  },
};

describe("ToolExecutor + Hooks integration", () => {
  beforeAll(setup);
  afterAll(cleanup);

  it("triggers pre-tool-use hook before execution", async () => {
    const hooks = createHookRegistry();
    const calls: string[] = [];

    hooks.register("pre-tool-use", (toolName) => {
      calls.push(`pre:${toolName}`);
      return { allowed: true };
    });

    const executor = createToolExecutor(undefined, hooks);
    const result = await executor.execute(echoTool, { text: "hello" }, TEST_CONTEXT);

    expect(result.content).toBe("hello");
    expect(calls).toEqual(["pre:echo"]);
  });

  it("blocks execution when pre-tool-use hook returns allowed=false", async () => {
    const hooks = createHookRegistry();

    hooks.register("pre-tool-use", () => ({
      allowed: false,
      reason: "blocked by test hook",
    }));

    const executor = createToolExecutor(undefined, hooks);
    const result = await executor.execute(echoTool, { text: "hello" }, TEST_CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked by test hook");
  });

  it("triggers post-tool-use hook after execution", async () => {
    const hooks = createHookRegistry();
    const calls: string[] = [];

    hooks.register("post-tool-use", (toolName, _input, result) => {
      calls.push(`post:${toolName}:${result.content}`);
      return result;
    });

    const executor = createToolExecutor(undefined, hooks);
    const result = await executor.execute(echoTool, { text: "world" }, TEST_CONTEXT);

    expect(result.content).toBe("world");
    expect(calls).toEqual(["post:echo:world"]);
  });

  it("allows post-tool-use hook to modify result", async () => {
    const hooks = createHookRegistry();

    hooks.register("post-tool-use", (_toolName, _input, result) => {
      return { ...result, content: result.content + " [modified]" };
    });

    const executor = createToolExecutor(undefined, hooks);
    const result = await executor.execute(echoTool, { text: "original" }, TEST_CONTEXT);

    expect(result.content).toContain("[modified]");
  });

  it("triggers post-tool-use hook even on error results", async () => {
    const hooks = createHookRegistry();
    let postCalled = false;

    const failTool: ToolDefinition<{ msg: string }> = {
      name: "failer",
      description: "Always fails",
      inputSchema: z.object({ msg: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute(input) {
        throw new Error(input.msg);
      },
    };

    hooks.register("post-tool-use", () => {
      postCalled = true;
      return { content: "intercepted", isError: false };
    });

    const executor = createToolExecutor(undefined, hooks);
    await executor.execute(failTool, { msg: "boom" }, TEST_CONTEXT);

    // The executor catches errors and returns errorResult,
    // then post-tool-use hook should still fire
    expect(postCalled).toBe(true);
  });

  it("exposes hook registry via getHookRegistry()", () => {
    const hooks = createHookRegistry();
    const executor = createToolExecutor(undefined, hooks);

    const returned = executor.getHookRegistry();
    expect(returned).toBe(hooks);
  });

  it("creates its own hook registry when none is provided", () => {
    const executor = createToolExecutor();
    const hooks = executor.getHookRegistry();

    expect(hooks).toBeDefined();
    expect(hooks.getHandlers("pre-tool-use").length).toBe(0);
  });

  it("hooks work with executeMany", async () => {
    const hooks = createHookRegistry();
    const preCalls: string[] = [];
    const postCalls: string[] = [];

    hooks.register("pre-tool-use", (name) => {
      preCalls.push(name);
      return { allowed: true };
    });

    hooks.register("post-tool-use", (name, _input, result) => {
      postCalls.push(name);
      return result;
    });

    const executor = createToolExecutor(undefined, hooks);
    const results = await executor.executeMany(
      [
        { tool: echoTool, input: { text: "a" } },
        { tool: echoTool, input: { text: "b" } },
      ],
      TEST_CONTEXT,
    );

    expect(results.length).toBe(2);
    expect(preCalls.length).toBe(2);
    expect(postCalls.length).toBe(2);
  });
});
