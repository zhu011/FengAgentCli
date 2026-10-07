/**
 * 副作用台账闸 — 块 3 在**执行器**层面的验收
 *
 * 协调点名要求的两条硬约束在这里被反证：
 * 1. 台账写入发生在副作用执行**之前**（否则「已执行、未记账」的窗口仍在）；
 * 2. 无法幂等的工具遇到未决记录必须**人工核对**，不许静默重放。
 *
 * 台账用测试内自建的内存实现（不依赖 agent 包的 SQLite 实现），
 * 因此这里验的是 core 契约 + executor 行为，而不是某一版存储实现。
 */

import { describe, expect, test } from "bun:test";
import type {
  BeginOperationInput,
  OperationLedger,
  OperationRecord,
  ToolDefinition,
  ToolResult,
} from "@fengagent/core";
import { z } from "zod";
import { createToolExecutor } from "../executor.ts";

/** 内存台账（可断言写入顺序） */
function createMemoryLedger() {
  const rows: OperationRecord[] = [];
  /** 事件轨迹：用于反证「先记账、再执行」的顺序 */
  const trace: string[] = [];
  const ledger: OperationLedger = {
    begin(entry: BeginOperationInput) {
      trace.push(`begin:${entry.operationKey}`);
      const existing = rows.find((r) => r.operationKey === entry.operationKey);
      if (existing) {
        // 与 SQLite 实现同语义：failed 记录在重新执行时被重新置为 pending
        if (existing.status === "failed") {
          existing.status = "pending";
          existing.error = undefined;
          existing.startedAt = entry.startedAt;
        }
        return existing;
      }
      const record: OperationRecord = {
        operationId: entry.operationId,
        operationKey: entry.operationKey,
        toolName: entry.toolName,
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        stepId: entry.stepId,
        input: entry.input,
        status: "pending",
        startedAt: entry.startedAt,
      };
      rows.push(record);
      return record;
    },
    complete(operationId, result) {
      trace.push(`complete:${operationId}`);
      const row = rows.find((r) => r.operationId === operationId);
      if (row) {
        row.status = "succeeded";
        row.resultDigest = result.digest;
        row.resultJson = result.json;
        row.finishedAt = result.finishedAt;
      }
    },
    fail(operationId, error, finishedAt) {
      trace.push(`fail:${operationId}`);
      const row = rows.find((r) => r.operationId === operationId);
      if (row) {
        row.status = "failed";
        row.error = error;
        row.finishedAt = finishedAt;
      }
    },
    markUnknown(operationId) {
      trace.push(`unknown:${operationId}`);
      const row = rows.find((r) => r.operationId === operationId);
      if (row && row.status === "pending") row.status = "unknown";
    },
    lookup(operationKey) {
      return rows.find((r) => r.operationKey === operationKey) ?? null;
    },
    get(operationId) {
      return rows.find((r) => r.operationId === operationId) ?? null;
    },
    listPending() {
      return rows.filter((r) => r.status === "pending" || r.status === "unknown");
    },
  };
  return { ledger, rows, trace };
}

/** 造一个可观测「执行了几次」的工具 */
function makeTool(opts: {
  name?: string;
  kind?: "none" | "idempotent" | "non-idempotent";
  execute: (input: unknown) => Promise<ToolResult>;
  onExecute?: () => void;
}): ToolDefinition {
  const name = opts.name ?? "notify_external";
  return {
    name,
    description: "test tool",
    inputSchema: z.object({ channel: z.string() }) as unknown as z.ZodType<unknown>,
    ...(opts.kind && opts.kind !== "none" ? { sideEffect: () => opts.kind! } : {}),
    operationKey: (input: unknown) =>
      `${name}::${(input as { channel: string }).channel}`,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(input: unknown) {
      opts.onExecute?.();
      return opts.execute(input);
    },
  };
}

const CTX = {
  workdir: ".",
  sessionId: "s1",
  messageId: "m1",
  stepId: "step-1",
  taskId: "task-1",
};

describe("台账闸：不声明副作用 = 不进台账", () => {
  test("未声明 sideEffect 的工具行为与历史完全一致", async () => {
    const { ledger, rows } = createMemoryLedger();
    let calls = 0;
    const tool = makeTool({
      execute: async () => ({ content: "ok" }),
      onExecute: () => calls++,
    });
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { channel: "ops" }, {
      ...CTX,
      operationLedger: ledger,
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

describe("台账闸：先记账、再执行", () => {
  test("台账在工具 execute 之前就已落 pending", async () => {
    const { ledger, rows, trace } = createMemoryLedger();
    let statusAtExecution: string | undefined;
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => ({ content: "sent" }),
      onExecute: () => {
        statusAtExecution = rows[0]?.status;
      },
    });
    const executor = createToolExecutor();
    const result = await executor.execute(tool, { channel: "ops" }, {
      ...CTX,
      operationLedger: ledger,
    });

    // 执行的那一刻，台账里已经有 pending 行 —— 这是窗口被关上的证据
    expect(statusAtExecution).toBe("pending");
    expect(trace[0]).toContain("begin:");
    // 完成后结算为 succeeded 并留摘要
    const rec = rows[0]!;
    expect(rec.status).toBe("succeeded");
    expect(rec.resultDigest).toContain("OK:");
    expect(rec.taskId).toBe("task-1");
    expect(rec.stepId).toBe("step-1");
    expect((result.metadata as Record<string, unknown>).operationId).toBe(
      rec.operationId,
    );
  });
});

describe("台账闸：已成功 → 跳过执行", () => {
  test("同一幂等键二次进入不执行副作用，复用已记录结果", async () => {
    const { ledger, trace } = createMemoryLedger();
    let calls = 0;
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => ({ content: "notified ops" }),
      onExecute: () => calls++,
    });
    const executor = createToolExecutor();

    const first = await executor.execute(tool, { channel: "ops" }, {
      ...CTX,
      operationLedger: ledger,
    });
    expect(calls).toBe(1);

    const second = await executor.execute(tool, { channel: "ops" }, {
      ...CTX,
      messageId: "m2",
      stepId: "step-2",
      operationLedger: ledger,
    });

    // 副作用只发生一次
    expect(calls).toBe(1);
    expect(second.content).toBe(first.content);
    const meta = second.metadata as Record<string, unknown>;
    expect(meta.ledgerHit).toBe("succeeded");
    expect(meta.ledgerStatus).toBe("succeeded");
    // 第二次没有新的 begin（没有重新执行）
    expect(trace.filter((t) => t.startsWith("begin:"))).toHaveLength(1);
  });
});

describe("台账闸：未决 + 非幂等 → 人工核对", () => {
  test("pending 记录挡住执行，标记 operationReviewRequired", async () => {
    const { ledger, rows } = createMemoryLedger();
    ledger.begin({
      operationId: "op-x",
      operationKey: "notify_external::ops",
      toolName: "notify_external",
      sessionId: "s1",
      input: { channel: "ops" },
      startedAt: 1,
    });

    let calls = 0;
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => ({ content: "should not run" }),
      onExecute: () => calls++,
    });
    const result = await createToolExecutor().execute(
      tool,
      { channel: "ops" },
      { ...CTX, operationLedger: ledger },
    );

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.operationReviewRequired).toBe(true);
    expect(meta.ledgerStatus).toBe("pending");
    // 闸门标记为不可恢复：循环层据此立即结算，不再空转
    expect(meta.unrecoverable).toBe(true);
    expect(rows[0]!.status).toBe("pending");
  });

  test("unknown 记录同样挡住执行", async () => {
    const { ledger, rows } = createMemoryLedger();
    ledger.begin({
      operationId: "op-x",
      operationKey: "notify_external::ops",
      toolName: "notify_external",
      sessionId: "s1",
      input: { channel: "ops" },
      startedAt: 1,
    });
    ledger.markUnknown("op-x");

    let calls = 0;
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => ({ content: "nope" }),
      onExecute: () => calls++,
    });
    const result = await createToolExecutor().execute(
      tool,
      { channel: "ops" },
      { ...CTX, operationLedger: ledger },
    );
    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(
      (result.metadata as Record<string, unknown>).ledgerStatus,
    ).toBe("unknown");
    expect(rows[0]!.status).toBe("unknown");
  });
});

describe("台账闸：未决 + 幂等 → 允许重放（沿用同一 operationId）", () => {
  test("重放后台账收敛为 succeeded", async () => {
    const { ledger, rows } = createMemoryLedger();
    const begun = ledger.begin({
      operationId: "op-idem",
      operationKey: "put_config::ops",
      toolName: "put_config",
      sessionId: "s1",
      input: { channel: "ops" },
      startedAt: 1,
    });
    expect(begun.operationId).toBe("op-idem");

    let calls = 0;
    const tool: ToolDefinition = {
      name: "put_config",
      description: "idempotent write",
      inputSchema: z.object({ channel: z.string() }) as unknown as z.ZodType<unknown>,
      sideEffect: () => "idempotent",
      operationKey: (input: unknown) =>
        `put_config::${(input as { channel: string }).channel}`,
      async execute() {
        calls++;
        return { content: "put ok" };
      },
    };

    const result = await createToolExecutor().execute(
      tool,
      { channel: "ops" },
      { ...CTX, operationLedger: ledger },
    );
    expect(calls).toBe(1); // 幂等 → 允许重放
    expect(result.isError).toBeFalsy();
    expect(rows).toHaveLength(1); // 没有新增第二行
    expect(rows[0]!.operationId).toBe("op-idem"); // 沿用同一 operationId
    expect(rows[0]!.status).toBe("succeeded");
  });
});

describe("台账闸：失败结算的保守取舍", () => {
  test("非幂等工具执行报错 → 记 unknown（失败不等于没生效）", async () => {
    const { ledger, rows } = createMemoryLedger();
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => ({ content: "boom", isError: true }),
    });
    const result = await createToolExecutor().execute(
      tool,
      { channel: "ops" },
      { ...CTX, operationLedger: ledger },
    );
    expect(result.isError).toBe(true);
    expect(rows[0]!.status).toBe("unknown");
    // 再进来一次 → 人工核对，不会重放
    const again = await createToolExecutor().execute(
      tool,
      { channel: "ops" },
      { ...CTX, operationLedger: ledger },
    );
    expect(
      (again.metadata as Record<string, unknown>).operationReviewRequired,
    ).toBe(true);
  });

  test("幂等工具执行报错 → 记 failed，允许下次重试", async () => {
    const { ledger, rows } = createMemoryLedger();
    let calls = 0;
    const tool: ToolDefinition = {
      name: "put_config",
      description: "idempotent write",
      inputSchema: z.object({ channel: z.string() }) as unknown as z.ZodType<unknown>,
      sideEffect: () => "idempotent",
      operationKey: () => "put_config::ops",
      async execute() {
        calls++;
        return calls === 1
          ? { content: "transient", isError: true }
          : { content: "put ok" };
      },
    };
    await createToolExecutor().execute(tool, { channel: "ops" }, {
      ...CTX,
      operationLedger: ledger,
    });
    expect(rows[0]!.status).toBe("failed");

    const second = await createToolExecutor().execute(tool, { channel: "ops" }, {
      ...CTX,
      operationLedger: ledger,
    });
    expect(calls).toBe(2);
    expect(second.isError).toBeFalsy();
    expect(rows[0]!.status).toBe("succeeded");
  });

  test("执行抛异常同样按副作用类别结算", async () => {
    const { ledger, rows } = createMemoryLedger();
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => {
        throw new Error("network reset");
      },
    });
    const result = await createToolExecutor().execute(
      tool,
      { channel: "ops" },
      { ...CTX, operationLedger: ledger },
    );
    expect(result.isError).toBe(true);
    expect(rows[0]!.status).toBe("unknown");
  });
});

describe("台账闸：无台账注入时保持历史行为", () => {
  test("未注入 ledger 的工具直接执行，不报错", async () => {
    let calls = 0;
    const tool = makeTool({
      kind: "non-idempotent",
      execute: async () => ({ content: "ok" }),
      onExecute: () => calls++,
    });
    const result = await createToolExecutor().execute(tool, { channel: "ops" }, CTX);
    expect(result.isError).toBeFalsy();
    expect(calls).toBe(1);
  });
});
