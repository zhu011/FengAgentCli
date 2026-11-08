/**
 * config → env 权限桥接回归（AGE-35 第一批 ①）
 *
 * 背景：`createPermissionChecker` 只读 `process.env`，不认 config 对象。
 * 桥接原先只写在 `packages/server/src/entry.ts`，导致 TUI / `fengagent serve` /
 * `fengagent acp` 三个入口里写进 config.json 的 `autoApproveTools` /
 * `allowedTools` / `deniedTools` 被静默忽略（用户配了全授权却不生效）。
 *
 * 这里覆盖两层：
 * 1. `applyToolPermissionEnvFromConfig` 的注入/不覆盖语义（纯函数）；
 * 2. `createRuntimeAgent` 真装配一次 → 权限检查器按 config 放行破坏性工具。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@fengagent/core";
import { createPermissionChecker } from "@fengagent/tools";
import {
  applyToolPermissionEnvFromConfig,
  createRuntimeAgent,
} from "../create-runtime-agent.ts";

const PERMISSION_ENV_KEYS = [
  "FENG_AUTO_APPROVE_TOOLS",
  "FENG_ALLOWED_TOOLS",
  "FENG_DENIED_TOOLS",
] as const;

/** 保存/恢复 process.env，避免桥接的全局副作用污染其他用例 */
const savedEnv = new Map<string, string | undefined>();
for (const key of PERMISSION_ENV_KEYS) savedEnv.set(key, process.env[key]);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "feng-perm-bridge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of PERMISSION_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

/** 破坏性工具：无 requestPermission 回调时默认会被拒（denyUnrecoverable） */
function makeDestructiveTool(): ToolDefinition {
  return {
    name: "bash",
    description: "执行 shell 命令",
    inputSchema: z.object({ command: z.string() }),
    async execute() {
      return { content: "ok" };
    },
    isReadOnly: () => false,
    isDestructive: () => true,
  } as ToolDefinition;
}

/** 最小 ToolContext（checkPermissions 只看 requestPermission 是否存在） */
function makeToolContext(): ToolContext {
  return {
    workdir: process.cwd(),
    sessionId: "perm-bridge-test",
    messageId: "perm-bridge-test-msg",
  };
}

/** process.env 读取（TS 在 delete 之后会把同名属性窄化成 undefined，统一走 helper） */
function readEnv(key: string): string | undefined {
  return process.env[key] as string | undefined;
}

describe("applyToolPermissionEnvFromConfig — 注入语义", () => {
  test("autoApproveTools / allowedTools / deniedTools 全部注入", () => {
    const env: Record<string, string | undefined> = {};
    const injected = applyToolPermissionEnvFromConfig(
      { autoApproveTools: true, allowedTools: "read,glob", deniedTools: "bash" },
      env,
    );

    expect(env.FENG_AUTO_APPROVE_TOOLS).toBe("true");
    expect(env.FENG_ALLOWED_TOOLS).toBe("read,glob");
    expect(env.FENG_DENIED_TOOLS).toBe("bash");
    expect(injected.sort()).toEqual([
      "FENG_ALLOWED_TOOLS",
      "FENG_AUTO_APPROVE_TOOLS",
      "FENG_DENIED_TOOLS",
    ]);
  });

  test("显式 env 优先：已存在的变量不被覆盖", () => {
    const env: Record<string, string | undefined> = {
      FENG_AUTO_APPROVE_TOOLS: "false",
      FENG_ALLOWED_TOOLS: "read",
    };
    const injected = applyToolPermissionEnvFromConfig(
      { autoApproveTools: true, allowedTools: "*", deniedTools: undefined },
      env,
    );

    expect(env.FENG_AUTO_APPROVE_TOOLS).toBe("false");
    expect(env.FENG_ALLOWED_TOOLS).toBe("read");
    expect(env.FENG_DENIED_TOOLS).toBeUndefined();
    expect(injected).toEqual([]);
  });

  test("autoApproveTools=false 不写 FENG_AUTO_APPROVE_TOOLS（默认询问语义）", () => {
    const env: Record<string, string | undefined> = {};
    applyToolPermissionEnvFromConfig(
      { autoApproveTools: false, allowedTools: "*", deniedTools: undefined },
      env,
    );

    expect(env.FENG_AUTO_APPROVE_TOOLS).toBeUndefined();
  });
});

describe("createRuntimeAgent — config 的授权字段对权限检查器生效", () => {
  const baseEnv = {
    FENG_PROVIDER: "openai-compatible",
    FENG_MODEL: "bridge-test-model",
    OPENAI_COMPATIBLE_API_KEY: "sk-bridge-test",
    OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com",
    OPENAI_COMPATIBLE_MODEL: "bridge-test-model",
  };

  test("config.autoApproveTools=true → 破坏性工具直接放行（TUI/serve/acp 共用装配点）", async () => {
    // 前置：模拟「只在 config.json 里配了全授权，env 没写」
    delete process.env.FENG_AUTO_APPROVE_TOOLS;
    const workdir = makeTempDir();

    const result = await createRuntimeAgent({
      env: baseEnv,
      workdir,
      enableSessionStore: false,
      cliArgs: { autoApproveTools: true },
    });
    await result.runtime.start();

    // 1) 桥接落地：权限检查器读到的 env 已是 config 的值
    expect(readEnv("FENG_AUTO_APPROVE_TOOLS")).toBe("true");

    // 2) 行为面：无 requestPermission 回调时，破坏性工具原本 denyUnrecoverable → 现在 allow
    const checker = createPermissionChecker(workdir);
    const decision = checker.checkPermissions(
      makeDestructiveTool(),
      { command: "rm -rf /tmp/x" },
      makeToolContext(),
    );
    expect(decision.decision).toBe("allow");

    await result.runtime.stop();
  });

  test("不配 autoApproveTools → 破坏性工具仍按默认询问/拒绝（不误开全授权）", async () => {
    delete process.env.FENG_AUTO_APPROVE_TOOLS;
    const workdir = makeTempDir();

    const result = await createRuntimeAgent({
      env: baseEnv,
      workdir,
      enableSessionStore: false,
    });
    await result.runtime.start();

    expect(readEnv("FENG_AUTO_APPROVE_TOOLS")).toBeUndefined();

    const checker = createPermissionChecker(workdir);
    const decision = checker.checkPermissions(
      makeDestructiveTool(),
      { command: "rm -rf /tmp/x" },
      makeToolContext(),
    );
    expect(decision.decision).not.toBe("allow");

    await result.runtime.stop();
  });
});
