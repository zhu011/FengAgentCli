/**
 * @fengagent/agent — ACP 客户端测试（P1）
 *
 * 用 `fixtures/fake-acp-agent.ts` 当目标运行时（真 spawn、真 NDJSON），验证：
 * 1. initialize 握手：agentInfo + 能力（resume/loadSession/image）；
 * 2. session/new 拿 sessionId；
 * 3. session/prompt 的增量文本按 `session/update` 到达；
 * 4. 权限请求不会被静默挂起：宿主策略拒绝 → 仍然跑完并回报决策；
 * 5. 目标侧回 JSON-RPC error → 抛 AcpProtocolError；
 * 6. close() 回收子进程（EOF 后进程退出）。
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AcpClient, AcpProtocolError } from "../acp-client.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

function makeClient(): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: [FIXTURE],
    cwd: import.meta.dir,
    requestTimeoutMs: 5000,
    promptTimeoutMs: 10_000,
    onLog: () => undefined,
  });
}

describe("AcpClient — 握手 / 建会话 / 跑一轮", () => {
  test("initialize 带回 agentInfo 与能力（resume 来自 sessionCapabilities）", async () => {
    const client = makeClient();
    try {
      const handshake = await client.initialize();
      expect(handshake.protocolVersion).toBe(1);
      expect(handshake.agentInfo).toEqual({ name: "fake-acp", version: "0.0.1" });
      expect(handshake.capabilities.resume).toBe(true);
      expect(handshake.capabilities.loadSession).toBe(true);
      expect(handshake.capabilities.image).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("session/new 返回目标侧 sessionId", async () => {
    const client = makeClient();
    try {
      await client.initialize();
      expect(await client.newSession(import.meta.dir)).toBe("fake-session-1");
    } finally {
      await client.close();
    }
  });

  test("session/resume 带全参（sessionId + cwd + mcpServers）复用同一会话", async () => {
    const client = makeClient();
    try {
      const handshake = await client.initialize();
      expect(handshake.capabilities.resume).toBe(true);
      // 目标侧强制校验 cwd：缺了就 -32602（与 kimi / 原版 dsh 同款行为）
      expect(await client.resumeSession("fake-session-1", import.meta.dir)).toBe(
        "fake-session-1",
      );
      // resume 之后同一 sessionId 仍能正常跑一轮
      const result = await client.prompt("fake-session-1", "继续", {
        onPermission: () => "deny",
      });
      expect(result.text).toContain("好");
    } finally {
      await client.close();
    }
  });

  test("prompt 的增量按 session/update 逐块到达，权限决策回传并被采纳", async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.newSession(import.meta.dir);
      const seen: string[] = [];
      let permissionAsked = 0;
      const result = await client.prompt(sessionId, "打个招呼", {
        onUpdate: (update) => {
          const text = update.content?.text;
          if (typeof text === "string") seen.push(text);
        },
        onPermission: () => {
          permissionAsked++;
          return "deny";
        },
      });
      expect(permissionAsked).toBe(1);
      // 两块文本 + 权限决策回执
      expect(result.text).toContain("你");
      expect(result.text).toContain("好");
      expect(result.text).toContain("[perm:reject-once]");
      expect(result.stopReason).toBe("end_turn");
      expect(seen.length).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  test("目标侧回 JSON-RPC error → 抛 AcpProtocolError（不静默成功）", async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.newSession(import.meta.dir);
      let caught: unknown = null;
      try {
        await client.prompt(sessionId, "FAIL 这条应当失败");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AcpProtocolError);
      expect((caught as Error).message).toContain("目标拒绝执行");
    } finally {
      await client.close();
    }
  });

  test("cancel 让在飞的 prompt 结算为 cancelled", async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.newSession(import.meta.dir);
      const pending = client.prompt(sessionId, "SLOW 慢慢来");
      // 等第一块增量到达后再取消，确保 prompt 真的在飞
      await new Promise((resolve) => setTimeout(resolve, 80));
      client.cancel(sessionId);
      const result = await pending;
      expect(result.stopReason).toBe("cancelled");
    } finally {
      await client.close();
    }
  });

  test("close() 之后客户端不可用（进程已回收）", async () => {
    const client = makeClient();
    await client.initialize();
    await client.close();
    expect(client.unavailable).toBe(true);
    let caught: unknown = null;
    try {
      await client.newSession(import.meta.dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});
