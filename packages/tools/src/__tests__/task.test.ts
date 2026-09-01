/**
 * @fengagent/tools — Task 工具 + 子 Agent 派遣集成测试
 *
 * 测试场景：
 * 1. Task 工具基本参数校验和输出格式
 * 2. 无 spawnSubagent 时的错误处理
 * 3. 子 Agent 派遣完整流程（mock LLM）
 * 4. 深度限制防递归
 * 5. 未知 Agent 类型处理
 * 6. 子 Agent 工具过滤（task 工具被排除）
 * 7. subagent_type 缺参/空值兜底（推断 → default，不再报错）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { ToolContext } from "@fengagent/core";
import {
  createToolRegistry,
  registerBuiltinTools,
} from "../index.ts";
import { taskTool } from "../builtin/task.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

const TEST_WORKDIR = join(tmpdir(), "fengagent-task-test");

/** 合法的 task 工具输入（用于 isReadOnly 等需要 input 参数的方法） */
const validInput = {
  description: "test",
  prompt: "do something",
  subagent_type: "coder",
};

function createMockSpawnSubagent(
  resultOverride?: Partial<{ state: "completed" | "error"; text: string; summary: string }>,
) {
  return async (params: {
    description: string;
    prompt: string;
    subagentType: string;
    taskId?: string;
    parentSessionId: string;
    depth: number;
  }) => {
    return {
      taskId: params.taskId ?? "mock-task-id",
      sessionId: "mock-session-id",
      state: resultOverride?.state ?? ("completed" as const),
      text: resultOverride?.text ?? `Subagent completed: ${params.prompt}`,
      summary: resultOverride?.summary ?? `Task: ${params.description}`,
    };
  };
}

beforeAll(() => {
  if (!existsSync(TEST_WORKDIR)) mkdirSync(TEST_WORKDIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_WORKDIR)) rmSync(TEST_WORKDIR, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// Task 工具基本测试
// ──────────────────────────────────────────────

describe("taskTool — 基本属性", () => {
  test("名称为 task", () => {
    expect(taskTool.name).toBe("task");
  });

  test("不是只读", () => {
    expect(taskTool.isReadOnly!(validInput)).toBe(false);
  });

  test("不是破坏性", () => {
    expect(taskTool.isDestructive!(validInput)).toBe(false);
  });

  test("不可并发安全", () => {
    expect(taskTool.isConcurrencySafe!(validInput)).toBe(false);
  });

  test("权限默认允许", () => {
    const perm = taskTool.checkPermissions!(validInput, {
      workdir: TEST_WORKDIR,
      sessionId: "test",
      messageId: "test",
    });
    expect(perm.decision).toBe("allow");
  });

  test("renderUse 返回描述", () => {
    const rendered = taskTool.renderUse!({
      description: "refactor auth",
      prompt: "do something",
      subagent_type: "coder",
    });
    expect(rendered).toContain("refactor auth");
    expect(rendered).toContain("coder");
  });

  test("输入 schema 校验必填字段", () => {
    const valid = taskTool.inputSchema.parse({
      description: "test task",
      prompt: "do something",
      subagent_type: "coder",
    });
    expect(valid.description).toBe("test task");

    // 缺少必填字段
    expect(() =>
      taskTool.inputSchema.parse({ prompt: "do something", subagent_type: "coder" }),
    ).toThrow();
  });

  test("task_id 可选", () => {
    const withId = taskTool.inputSchema.parse({
      description: "test",
      prompt: "do",
      subagent_type: "coder",
      task_id: "prev-task-123",
    });
    expect(withId.task_id).toBe("prev-task-123");
  });

  test("输入 schema 归一化：接受 camelCase subagentType 别名（AGE-29 死循环根因）", () => {
    // 模型常见误拼：subagentType（camelCase）
    const camel = taskTool.inputSchema.parse({
      description: "research tui",
      prompt: "调研 TUI",
      subagentType: "researcher",
    }) as { description: string; subagent_type?: string; task_id?: string };
    expect(camel.subagent_type).toBe("researcher");

    // 其他别名（agentType / type / agent / subagent / kind / name）同样归一化
    for (const alias of ["agentType", "type", "agent", "subagent", "kind", "name", "agent_type"]) {
      const parsed = taskTool.inputSchema.parse({
        description: "d",
        prompt: "p",
        [alias]: "coder",
      }) as { subagent_type?: string };
      expect(parsed.subagent_type).toBe("coder");
    }

    // 规范键优先于别名
    const both = taskTool.inputSchema.parse({
      description: "d",
      prompt: "p",
      subagent_type: "default",
      subagentType: "coder",
    }) as { subagent_type?: string };
    expect(both.subagent_type).toBe("default");
  });

  test("输入 schema 归一化：别名缺失/空值时兜底为 default（不再 undefined）", () => {
    const missing = taskTool.inputSchema.parse({
      description: "d",
      prompt: "p",
    }) as { subagent_type?: string };
    expect(missing.subagent_type).toBe("default");

    const empty = taskTool.inputSchema.parse({
      description: "d",
      prompt: "p",
      subagent_type: "",
    }) as { subagent_type?: string };
    expect(empty.subagent_type).toBe("default");

    const whitespace = taskTool.inputSchema.parse({
      description: "d",
      prompt: "p",
      subagentType: "   ",
    }) as { subagent_type?: string };
    expect(whitespace.subagent_type).toBe("default");
  });

  test("输入 schema 兜底推断：研究类任务 → researcher，编码类任务 → coder", () => {
    const research = taskTool.inputSchema.parse({
      description: "调研 TUI 框架",
      prompt: "请研究并总结 3 个开源 TUI 框架",
    }) as { subagent_type?: string };
    expect(research.subagent_type).toBe("researcher");

    const code = taskTool.inputSchema.parse({
      description: "实现登录模块",
      prompt: "请写一个 Node.js CLI 工具并修复参数解析 bug",
    }) as { subagent_type?: string };
    expect(code.subagent_type).toBe("coder");

    // 显式值优先于推断
    const explicit = taskTool.inputSchema.parse({
      description: "调研 TUI 框架",
      prompt: "请研究并总结 3 个开源 TUI 框架",
      subagent_type: "coder",
    }) as { subagent_type?: string };
    expect(explicit.subagent_type).toBe("coder");
  });

  test("execute 缺子 Agent 类型时不再报错，兜底为 default 并正常派遣", async () => {
    let receivedType: string | undefined;
    const ctx: ToolContext = {
      workdir: TEST_WORKDIR,
      sessionId: "test-session",
      messageId: "test-msg",
      spawnSubagent: async (params) => {
        receivedType = params.subagentType;
        return {
          taskId: "mock-task-id",
          sessionId: "mock-session-id",
          state: "completed" as const,
          text: "Subagent completed",
        };
      },
    };
    // 真实链路：loop 先经 inputSchema 解析模型输入（缺参 → 兜底 default + 来源标记），再执行
    const parsed = taskTool.inputSchema.parse({ description: "d", prompt: "p" });
    const result = await taskTool.execute(parsed, ctx);
    expect(result.isError).toBe(false);
    expect(receivedType).toBe("default");
    // 兜底备注写入结果，主 Agent 可知晓并自纠正
    expect(result.content).toContain("subagent_type 未显式提供");
    expect((result.metadata as { subagentTypeSource?: string }).subagentTypeSource).toBe("default");
  });

  test("execute 缺参但内容含研究关键词时推断为 researcher", async () => {
    let receivedType: string | undefined;
    const ctx: ToolContext = {
      workdir: TEST_WORKDIR,
      sessionId: "test-session",
      messageId: "test-msg",
      spawnSubagent: async (params) => {
        receivedType = params.subagentType;
        return {
          taskId: "mock-task-id",
          sessionId: "mock-session-id",
          state: "completed" as const,
          text: "调研完成",
        };
      },
    };
    const result = await taskTool.execute(
      { description: "调研 Textual", prompt: "请研究并总结 Textual 框架", subagent_type: "researcher" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(receivedType).toBe("researcher");
  });
});

// ──────────────────────────────────────────────
// Task 工具执行测试
// ──────────────────────────────────────────────

describe("taskTool — 执行", () => {
  const baseContext: ToolContext = {
    workdir: TEST_WORKDIR,
    sessionId: "test-session",
    messageId: "test-msg",
  };

  test("无 spawnSubagent 时返回错误", async () => {
    const result = await taskTool.execute(
      {
        description: "test task",
        prompt: "do something",
        subagent_type: "coder",
      },
      { ...baseContext, spawnSubagent: undefined },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("subagent runner");
  });

  test("成功派遣子 Agent 并返回格式化结果", async () => {
    const ctx: ToolContext = {
      ...baseContext,
      spawnSubagent: createMockSpawnSubagent({
        text: "重构完成，修改了 3 个文件。",
        summary: "Refactor done",
      }),
      agentDepth: 0,
    };

    const result = await taskTool.execute(
      {
        description: "refactor auth",
        prompt: "将 auth 模块重构为...",
        subagent_type: "coder",
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("<task");
    expect(result.content).toContain('state="completed"');
    expect(result.content).toContain("<task_result>");
    expect(result.content).toContain("重构完成");
    expect(result.content).toContain("</task>");

    // 元数据
    expect(result.metadata).toBeDefined();
    expect((result.metadata as { state: string }).state).toBe("completed");
  });

  test("子 Agent 错误时返回 task_error 标签", async () => {
    const ctx: ToolContext = {
      ...baseContext,
      spawnSubagent: createMockSpawnSubagent({
        state: "error",
        text: "找不到文件",
      }),
    };

    const result = await taskTool.execute(
      {
        description: "find bug",
        prompt: "查找 bug",
        subagent_type: "researcher",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('state="error"');
    expect(result.content).toContain("<task_error>");
    expect(result.content).toContain("找不到文件");
  });

  test("spawnSubagent 抛出异常时捕获并返回错误", async () => {
    const ctx: ToolContext = {
      ...baseContext,
      spawnSubagent: async () => {
        throw new Error("Network timeout");
      },
    };

    const result = await taskTool.execute(
      {
        description: "test",
        prompt: "do",
        subagent_type: "coder",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Network timeout");
  });

  test("传递正确的深度值", async () => {
    let receivedDepth = -1;
    const ctx: ToolContext = {
      ...baseContext,
      spawnSubagent: async (params) => {
        receivedDepth = params.depth;
        return {
          taskId: "t1",
          sessionId: "s1",
          state: "completed" as const,
          text: "ok",
        };
      },
      agentDepth: 1,
    };

    await taskTool.execute(
      {
        description: "nested",
        prompt: "do",
        subagent_type: "coder",
      },
      ctx,
    );

    expect(receivedDepth).toBe(1);
  });

  test("传递 task_id 用于恢复", async () => {
    let receivedTaskId: string | undefined;
    const ctx: ToolContext = {
      ...baseContext,
      spawnSubagent: async (params) => {
        receivedTaskId = params.taskId;
        return {
          taskId: params.taskId ?? "new",
          sessionId: "s1",
          state: "completed" as const,
          text: "ok",
        };
      },
    };

    await taskTool.execute(
      {
        description: "resume",
        prompt: "continue",
        subagent_type: "coder",
        task_id: "prev-session-123",
      },
      ctx,
    );

    expect(receivedTaskId).toBe("prev-session-123");
  });
});

// ──────────────────────────────────────────────
// registerBuiltinTools 包含 task
// ──────────────────────────────────────────────

describe("registerBuiltinTools — 包含 task", () => {
  test("注册了 12 个内置工具（含 task + memory + skill + sandbox）", () => {
    const reg = createToolRegistry();
    registerBuiltinTools(reg);
    const names = reg.list().map((t) => t.name).sort();
    expect(names).toEqual([
      "bash",
      "file-edit",
      "file-read",
      "file-write",
      "glob",
      "grep",
      "memory-list",
      "memory-save",
      "memory-search",
      "sandbox",
      "skill",
      "task",
    ]);
  });
});
