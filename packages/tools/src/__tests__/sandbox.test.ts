/**
 * @fengagent/tools — 沙箱模块与 sandbox 工具测试
 *
 * 覆盖：
 * 1. 路径围栏（resolvePath 越界防护：`..` 逃逸 / 沙箱外绝对路径）；
 * 2. 环境脱敏（scrubEnv：API Key / Token / FENG_* / MULTICA_* 剥离，基础变量保留）；
 * 3. 沙箱内文件操作（write/read/remove/list）；
 * 4. 沙箱内命令执行（runCommand：输出捕获 / 退出码 / 超时）；
 * 5. 宿主 ↔ 沙箱 显式数据流通（copy-in / copy-out）；
 * 6. 生命周期（dispose 幂等清理）；
 * 7. sandbox 工具集成（注册 / 权限标记 / 各动作 / 越界拒绝 / 会话隔离）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  Sandbox,
  SandboxEscapeError,
  sandboxTool,
  disposeAllSandboxes,
  createToolRegistry,
  registerBuiltinTools,
} from "../index.ts";
import type { ToolContext } from "@fengagent/core/tool";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_BASE = "";

function makeContext(sessionId = "test-session"): ToolContext {
  return {
    workdir: TEST_BASE,
    sessionId,
    messageId: "test-msg",
  };
}

beforeAll(() => {
  TEST_BASE = mkdtempSync(join(tmpdir(), "fengagent-sandbox-test-"));
});

afterAll(() => {
  disposeAllSandboxes();
  if (TEST_BASE) {
    try {
      rmSync(TEST_BASE, { recursive: true, force: true });
    } catch {
      // 被杀子进程可能短暂持有句柄 — 忽略清理失败
    }
  }
});

// ──────────────────────────────────────────────
// 1. 路径围栏
// ──────────────────────────────────────────────

describe("Sandbox path confinement", () => {
  test("resolvePath 把相对路径解析到沙箱根内", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    const abs = sb.resolvePath("a/b.txt");
    expect(abs.startsWith(sb.root)).toBe(true);
    // Windows 分隔符为反斜杠，用 join 构造期望后缀
    expect(abs.endsWith(join("a", "b.txt"))).toBe(true);
    sb.dispose();
  });

  test("resolvePath 拒绝 `..` 越界", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(() => sb.resolvePath("../escape.txt")).toThrow(SandboxEscapeError);
    expect(() => sb.resolvePath("a/../../escape.txt")).toThrow(
      SandboxEscapeError,
    );
    expect(() => sb.resolvePath("../../..")).toThrow(SandboxEscapeError);
    sb.dispose();
  });

  test("resolvePath 拒绝沙箱外的绝对路径", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(() => sb.resolvePath(join(TEST_BASE, "outside.txt"))).toThrow(
      SandboxEscapeError,
    );
    expect(() => sb.resolvePath(TEST_BASE)).toThrow(SandboxEscapeError);
    sb.dispose();
  });

  test("resolvePath 接受沙箱根自身与空字符串以外的合法路径", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(sb.resolvePath(".")).toBe(sb.root);
    expect(() => sb.resolvePath("")).toThrow();
    sb.dispose();
  });
});

// ──────────────────────────────────────────────
// 2. 环境脱敏
// ──────────────────────────────────────────────

describe("Sandbox env scrubbing", () => {
  test("scrubEnv 剥离 API Key / Token / Secret 类变量", () => {
    const scrubbed = Sandbox.scrubEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      OPENAI_API_KEY: "sk-123",
      GITHUB_TOKEN: "ghp_xxx",
      FENG_MODEL: "claude-sonnet-4",
      MULTICA_TOKEN: "mat_xxx",
      DEEPSEEK_API_KEY: "sk-ds",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.LANG).toBe("en_US.UTF-8");
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.FENG_MODEL).toBeUndefined();
    expect(scrubbed.MULTICA_TOKEN).toBeUndefined();
    expect(scrubbed.DEEPSEEK_API_KEY).toBeUndefined();
    // HOME 不属于敏感类，保留（沙箱实例会另行覆盖为沙箱内目录）
    expect(scrubbed.HOME).toBe("/home/user");
  });

  test("scrubEnv 支持追加脱敏规则", () => {
    const scrubbed = Sandbox.scrubEnv(
      { KEEP_ME: "1", MY_CUSTOM_SECRET: "x" },
      { extraPatterns: [/CUSTOM_SECRET/] },
    );
    expect(scrubbed.KEEP_ME).toBe("1");
    expect(scrubbed.MY_CUSTOM_SECRET).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// 3. 沙箱内文件操作
// ──────────────────────────────────────────────

describe("Sandbox file operations", () => {
  test("write/read/list/remove 均限制在沙箱根内", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    sb.writeFile("dir/nested/hello.txt", "hello sandbox");
    expect(sb.readFile("dir/nested/hello.txt")).toBe("hello sandbox");
    expect(existsSync(join(sb.root, "dir/nested/hello.txt"))).toBe(true);

    const entries = sb.list();
    expect(entries).toContain("dir/");
    expect(entries).toContain("dir/nested/");
    expect(entries).toContain("dir/nested/hello.txt");

    expect(sb.remove("dir/nested/hello.txt")).toBe(true);
    expect(sb.remove("dir/nested/hello.txt")).toBe(false);
    expect(existsSync(join(sb.root, "dir/nested/hello.txt"))).toBe(false);
    sb.dispose();
  });

  test("writeFile 拒绝越界路径", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(() => sb.writeFile("../evil.txt", "x")).toThrow(SandboxEscapeError);
    sb.dispose();
  });

  test("remove 拒绝越界路径", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(() => sb.remove("../evil.txt")).toThrow(SandboxEscapeError);
    sb.dispose();
  });
});

// ──────────────────────────────────────────────
// 4. 沙箱内命令执行
// ──────────────────────────────────────────────

describe("Sandbox runCommand", () => {
  test("执行简单命令并捕获输出", async () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    const result = await sb.runCommand("echo hello-from-sandbox", {
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("hello-from-sandbox");
    sb.dispose();
  });

  test("透传退出码与 stderr", async () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    const isWin = process.platform === "win32";
    const result = await sb.runCommand(
      isWin ? "echo boom 1>&2 & exit 3" : "echo boom 1>&2; exit 3",
      { timeout: 10000 },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    sb.dispose();
  });

  test("空命令直接返回错误", async () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    const result = await sb.runCommand("   ", { timeout: 1000 });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("empty command");
    sb.dispose();
  });

  test("超时强杀", async () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    const isWin = process.platform === "win32";
    // 睡眠 5s，超时 500ms → 应被杀
    const result = await sb.runCommand(
      isWin ? "ping -n 6 127.0.0.1 > nul" : "sleep 5",
      { timeout: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    sb.dispose();
  });
});

// ──────────────────────────────────────────────
// 5. copy-in / copy-out
// ──────────────────────────────────────────────

describe("Sandbox copy-in / copy-out", () => {
  test("copy-in 导入宿主文件（源只读），copy-out 导出到宿主", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    const hostSrc = join(TEST_BASE, "host-input.txt");
    writeFileSync(hostSrc, "host content", "utf-8");

    const inPath = sb.copyIn(hostSrc, "work/input.txt");
    expect(inPath.startsWith(sb.root)).toBe(true);
    expect(sb.readFile("work/input.txt")).toBe("host content");
    // 源文件未被修改
    expect(readFileSync(hostSrc, "utf-8")).toBe("host content");

    const hostOut = join(TEST_BASE, "host-output.txt");
    sb.copyOut("work/input.txt", hostOut);
    expect(readFileSync(hostOut, "utf-8")).toBe("host content");
    sb.dispose();
  });

  test("copy-out 拒绝读取沙箱外文件", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(() => sb.copyOut("../outside.txt", join(TEST_BASE, "x.txt"))).toThrow(
      SandboxEscapeError,
    );
    sb.dispose();
  });
});

// ──────────────────────────────────────────────
// 6. 生命周期
// ──────────────────────────────────────────────

describe("Sandbox lifecycle", () => {
  test("dispose 删除沙箱根且幂等", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE });
    expect(existsSync(sb.root)).toBe(true);
    sb.dispose();
    expect(existsSync(sb.root)).toBe(false);
    expect(sb.disposed).toBe(true);
    // 幂等
    sb.dispose();
  });

  test("cleanupOnDispose=false 时保留根目录", () => {
    const sb = new Sandbox({ baseDir: TEST_BASE, cleanupOnDispose: false });
    sb.dispose();
    expect(existsSync(sb.root)).toBe(true);
    rmSync(sb.root, { recursive: true, force: true });
  });
});

// ──────────────────────────────────────────────
// 7. sandbox 工具集成
// ──────────────────────────────────────────────

describe("sandbox tool", () => {
  test("注册到内置工具注册表", () => {
    const reg = createToolRegistry();
    registerBuiltinTools(reg);
    const tool = reg.get("sandbox")!;
    expect(tool).toBeDefined();
    expect(tool.name).toBe("sandbox");
  });

  test("权限标记：读类只读，仅 copy-out 破坏性", () => {
    expect(sandboxTool.isReadOnly!({ action: "read" })).toBe(true);
    expect(sandboxTool.isReadOnly!({ action: "list" })).toBe(true);
    expect(sandboxTool.isReadOnly!({ action: "run" })).toBe(false);
    expect(sandboxTool.isDestructive!({ action: "copy-out" })).toBe(true);
    expect(sandboxTool.isDestructive!({ action: "run" })).toBe(false);
    expect(sandboxTool.isDestructive!({ action: "delete" })).toBe(false);
  });

  test("write → run → read → delete 全链路在沙箱内工作", async () => {
    const ctx = makeContext("tool-session-1");
    const writeRes = await sandboxTool.execute(
      { action: "write", path: "exp/main.ts", content: 'console.log("hi")' },
      ctx,
    );
    expect(writeRes.isError).toBeFalsy();

    const runRes = await sandboxTool.execute(
      { action: "run", command: "echo ran-inside-sandbox", timeout: 10000 },
      ctx,
    );
    expect(runRes.isError).toBeFalsy();
    expect(runRes.content).toContain("ran-inside-sandbox");

    const readRes = await sandboxTool.execute(
      { action: "read", path: "exp/main.ts" },
      ctx,
    );
    expect(readRes.content).toContain("console.log");

    const listRes = await sandboxTool.execute({ action: "list" }, ctx);
    expect(listRes.content).toContain("exp/");
    expect(listRes.content).toContain("exp/main.ts");

    const delRes = await sandboxTool.execute(
      { action: "delete", path: "exp/main.ts" },
      ctx,
    );
    expect(delRes.content).toContain("Removed");
  });

  test("越界路径被拒绝并返回错误结果", async () => {
    const ctx = makeContext("tool-session-2");
    const res = await sandboxTool.execute(
      { action: "write", path: "../escape.txt", content: "x" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Sandbox escape denied");
  });

  test("copy-out 到宿主可用（显式出口）", async () => {
    const ctx = makeContext("tool-session-3");
    await sandboxTool.execute(
      { action: "write", path: "result.txt", content: "final answer" },
      ctx,
    );
    const hostOut = join(TEST_BASE, "exported-result.txt");
    const res = await sandboxTool.execute(
      { action: "copy-out", path: "result.txt", dest: hostOut },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(readFileSync(hostOut, "utf-8")).toBe("final answer");
  });

  test("会话隔离：不同会话使用不同沙箱根", async () => {
    const sandboxRootOf = (res: { metadata?: unknown }): string | undefined => {
      const m = res.metadata as { sandboxRoot?: string } | undefined;
      return m?.sandboxRoot;
    };

    const ctxA = makeContext("session-iso-a");
    const ctxB = makeContext("session-iso-b");
    const a = await sandboxTool.execute({ action: "status" }, ctxA);
    const b = await sandboxTool.execute({ action: "status" }, ctxB);
    expect(sandboxRootOf(a)).toBeTruthy();
    expect(sandboxRootOf(b)).toBeTruthy();
    expect(sandboxRootOf(a)).not.toBe(sandboxRootOf(b));

    // 同一会话复用同一沙箱
    const a2 = await sandboxTool.execute({ action: "status" }, ctxA);
    expect(sandboxRootOf(a2)).toBe(sandboxRootOf(a));
  });
});
