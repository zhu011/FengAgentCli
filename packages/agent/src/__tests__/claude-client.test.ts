/**
 * @fengagent/agent — claude `stream-json` 驱动（经 RuntimeDriver 门面）测试（P4）
 *
 * 用 `fixtures/fake-claude-stream-json.ts` 复刻真机事件形状（init / assistant /
 * result），验证**协议门面**这条链路（而不是某个客户端的内部实现）：
 *
 * 1. `createRuntimeDriver({protocol:"claude-stream-json"})` 能握手（`--version`）；
 * 2. 一轮 prompt 的文本增量到达 `onChunk`，结果取 `result.result`；
 * 3. 权限策略走统一 `onPermission` 通道 → 落成 `--dangerously-skip-permissions`；
 * 4. resume 走 `--resume <session_id>`；
 * 5. `is_error:true` 的 result → 抛 AcpProtocolError（不静默成功）；
 * 6. 身份隔离：目标进程拿不到 `MULTICA_*`，cwd 由调用方给。
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AcpProtocolError } from "../acp-client.ts";
import { createRuntimeDriver } from "../runtime-driver.ts";
import type { RuntimeDriver } from "../runtime-driver.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-claude-stream-json.ts");

/**
 * 造一个指向夹具的 claude 驱动。
 *
 * 夹具是 TS 脚本，所以 command 用 bun 可执行文件、`extraArgs` 里先给它脚本路径，
 * 再拼上 claude 的基础参数（`args` 在 claude 客户端里是**基础参数**，会原样带上）。
 */
function makeDriver(cwd = import.meta.dir): RuntimeDriver {
  return createRuntimeDriver(
    { name: "claude-fake", command: process.execPath, protocol: "claude-stream-json" },
    {
      cwd,
      requestTimeoutMs: 8000,
      promptTimeoutMs: 15_000,
      extraArgs: [FIXTURE, "-p", "--output-format", "stream-json", "--verbose"],
    },
  );
}

describe("Claude stream-json 驱动（RuntimeDriver 门面）", () => {
  test("initialize 走 --version 探测，并声明 resume 能力", async () => {
    const driver = makeDriver();
    try {
      const handshake = await driver.initialize();
      expect(handshake.agentName).toBe("Claude Code");
      expect(handshake.agentVersion).toMatch(/^\d+\.\d+/);
      expect(handshake.capabilities.resume).toBe(true);
    } finally {
      await driver.close();
    }
  });

  test("prompt：增量到达 onChunk，结果取 result.result，并记下会话 id", async () => {
    const driver = makeDriver();
    try {
      await driver.initialize();
      const handle = await driver.openSession();
      expect(handle.mode).toBe("new");

      const chunks: string[] = [];
      const result = await driver.prompt("打个招呼", { onChunk: (text) => chunks.push(text) });
      expect(result.text).toContain("你好");
      expect(result.sessionId).toBe("fake-claude-session-1");
      expect(chunks.join("")).toContain("你");
      expect(driver.lastSessionId).toBe("fake-claude-session-1");
      // 基础参数确实带上了（否则对端不会按事件流说话）
      expect(result.text).toContain("--output-format stream-json");
    } finally {
      await driver.close();
    }
  });

  test("权限走统一通道：allow → --dangerously-skip-permissions；deny → 不加", async () => {
    const allow = makeDriver();
    try {
      await allow.initialize();
      await allow.openSession();
      const allowed = await allow.prompt("写个文件", { onPermission: () => "allow" });
      expect(allowed.text).toContain("--dangerously-skip-permissions");
    } finally {
      await allow.close();
    }

    const deny = makeDriver();
    try {
      await deny.initialize();
      await deny.openSession();
      const denied = await deny.prompt("写个文件", { onPermission: () => "deny" });
      expect(denied.text).not.toContain("--dangerously-skip-permissions");
    } finally {
      await deny.close();
    }
  });

  test("resume：openSession(sessionId) 让本轮带 --resume", async () => {
    const driver = makeDriver();
    try {
      await driver.initialize();
      const handle = await driver.openSession("prev-session-42");
      expect(handle.mode).toBe("resume");
      const result = await driver.prompt("继续", { onPermission: () => "deny" });
      expect(result.text).toContain("--resume prev-session-42");
    } finally {
      await driver.close();
    }
  });

  test("is_error 的 result → 抛 AcpProtocolError（不静默成功）", async () => {
    const driver = makeDriver();
    try {
      await driver.initialize();
      await driver.openSession();
      let caught: unknown = null;
      try {
        await driver.prompt("FAIL 这条应当失败", { onPermission: () => "deny" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AcpProtocolError);
      expect((caught as Error).message).toContain("目标拒绝执行");
    } finally {
      await driver.close();
    }
  });

  test("身份隔离：目标进程拿不到 MULTICA_*，cwd 就是传入的中立目录", async () => {
    const previous = process.env.MULTICA_TOKEN;
    process.env.MULTICA_TOKEN = "leak-me";
    // claude 客户端是「进程-per-prompt」，同一实例不能连续跑两轮 —— 两条探针各用一个驱动
    const envDriver = makeDriver();
    const cwdDriver = makeDriver();
    try {
      await envDriver.initialize();
      await envDriver.openSession();
      const envResult = await envDriver.prompt("ENV_PROBE", { onPermission: () => "deny" });
      expect(envResult.text).toContain("multica_env=none");

      await cwdDriver.initialize();
      await cwdDriver.openSession();
      const cwdResult = await cwdDriver.prompt("CWD_PROBE", { onPermission: () => "deny" });
      expect(cwdResult.text).toContain(`cwd=${import.meta.dir}`);
    } finally {
      await envDriver.close();
      await cwdDriver.close();
      if (previous === undefined) delete process.env.MULTICA_TOKEN;
      else process.env.MULTICA_TOKEN = previous;
    }
  });
});
