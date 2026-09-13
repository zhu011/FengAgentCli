/**
 * @fengagent/server — ACP 端点端口选择测试
 *
 * 回归目标：Multica 守护进程每次对话都会新起一个 `fengagent acp` 进程，
 * 端口写死时只要被占用（残留实例 / 人工调试实例 / dev server），
 * 子进程就会以 Bun 的 “Failed to start server. Is port <n> in use?”
 * 秒退，宿主侧只能看到无从定位的 “hermes initialize failed”。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolvePreferredAcpPort, startAcpServer } from "../acp-server.ts";
import type { Config } from "@fengagent/core";

/** 构造只带 serverPort 的最小配置（startAcpServer 仅读取该字段） */
function makeConfig(serverPort: number): Config {
  return { serverPort } as unknown as Config;
}

/** 不会被执行到的 Agent 工厂（本测试只验证监听与 /health） */
const stubCreateAgent = (() => {
  throw new Error("createAgent should not be called in this test");
}) as unknown as Parameters<typeof startAcpServer>[0]["createAgent"];

const started: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of started.splice(0)) {
    try {
      server.stop(true);
    } catch {
      // 已停止
    }
  }
  delete process.env.FENG_ACP_PORT;
});

describe("resolvePreferredAcpPort", () => {
  it("未设置 FENG_ACP_PORT 时使用 serverPort + 1", () => {
    expect(resolvePreferredAcpPort(makeConfig(3000))).toBe(3001);
    expect(resolvePreferredAcpPort(makeConfig(8080))).toBe(8081);
  });

  it("FENG_ACP_PORT 优先于 serverPort", () => {
    process.env.FENG_ACP_PORT = "43111";
    expect(resolvePreferredAcpPort(makeConfig(3000))).toBe(43111);
  });

  it("FENG_ACP_PORT 非法时回退到 serverPort + 1", () => {
    process.env.FENG_ACP_PORT = "not-a-port";
    expect(resolvePreferredAcpPort(makeConfig(3000))).toBe(3001);
  });
});

describe("startAcpServer", () => {
  it("首选端口空闲时监听该端口", async () => {
    const preferred = 43121;
    const server = startAcpServer({
      config: makeConfig(preferred - 1),
      createAgent: stubCreateAgent,
    });
    started.push(server);

    expect(server.port).toBe(preferred);
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", provider: "fengagent" });
  });

  it("首选端口被占用时回退到临时端口，而不是让进程退出", async () => {
    const preferred = 43131;
    // 先占住首选端口：模拟残留的 ACP 实例
    const occupant = startAcpServer({
      config: makeConfig(preferred - 1),
      createAgent: stubCreateAgent,
    });
    started.push(occupant);
    expect(occupant.port).toBe(preferred);

    // 第二个实例必须仍然起得来（守护进程可以并发/重复拉起）
    const second = startAcpServer({
      config: makeConfig(preferred - 1),
      createAgent: stubCreateAgent,
    });
    started.push(second);

    expect(second.port).not.toBe(preferred);
    expect(second.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${second.port}/health`);
    expect(res.status).toBe(200);
  });
});
