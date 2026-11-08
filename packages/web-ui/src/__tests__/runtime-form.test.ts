/**
 * runtime 管理表单 — 输入解析与校验测试（纯函数）。
 */

import { describe, expect, test } from "bun:test";
import {
  EMPTY_RUNTIME_FORM,
  formToEntry,
  parseArgsInput,
  parseEnvInput,
  validateRuntimeForm,
  type RuntimeFormValue,
} from "../pages/runtime-form.ts";

describe("parseArgsInput", () => {
  test("空白分隔", () => {
    expect(parseArgsInput("acp")).toEqual(["acp"]);
    expect(parseArgsInput(" run --json ")).toEqual(["run", "--json"]);
  });

  test("引号内空格不拆", () => {
    expect(parseArgsInput('run --prompt "两个 词"')).toEqual(["run", "--prompt", "两个 词"]);
  });

  test("空串 → 空数组", () => {
    expect(parseArgsInput("")).toEqual([]);
    expect(parseArgsInput("   ")).toEqual([]);
  });
});

describe("parseEnvInput", () => {
  test("逐行 KEY=VALUE", () => {
    const { env, errors } = parseEnvInput("API_KEY=sk-1\nHTTP_PROXY=http://p\n");
    expect(env).toEqual({ API_KEY: "sk-1", HTTP_PROXY: "http://p" });
    expect(errors).toEqual([]);
  });

  test("空行跳过；非法行报错", () => {
    const { env, errors } = parseEnvInput("\nA=1\nBADLINE\n=NOKEY\n");
    expect(env).toEqual({ A: "1" });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("BADLINE");
  });
});

describe("validateRuntimeForm", () => {
  const base: RuntimeFormValue = { ...EMPTY_RUNTIME_FORM, name: "opencode", command: "opencode" };

  test("合法表单通过", () => {
    expect(validateRuntimeForm(base, false)).toEqual([]);
  });

  test("名称规则：空 / 非法字符 / 连字符开头", () => {
    expect(validateRuntimeForm({ ...base, name: "" }, false)[0]).toContain("名称");
    expect(validateRuntimeForm({ ...base, name: "bad name" }, false).join()).toContain("名称");
    expect(validateRuntimeForm({ ...base, name: "-x" }, false).join()).toContain("名称");
  });

  test("编辑模式不校验名称（以路径名为准）", () => {
    expect(validateRuntimeForm({ ...base, name: "" }, true)).toEqual([]);
  });

  test("command 必填", () => {
    expect(validateRuntimeForm({ ...base, command: "" }, false).join()).toContain("command");
  });

  test("env 非法行并入错误", () => {
    const errors = validateRuntimeForm({ ...base, env: "BAD" }, false);
    expect(errors.some((e) => e.includes("BAD"))).toBe(true);
  });
});

describe("formToEntry", () => {
  test("完整归一：args/env 解析、空段缺省", () => {
    const entry = formToEntry({
      name: " opencode ",
      command: " opencode ",
      args: "run --json",
      protocol: "claude-stream-json",
      env: "KEY=v",
    });
    expect(entry).toEqual({
      name: "opencode",
      command: "opencode",
      args: ["run", "--json"],
      protocol: "claude-stream-json",
      env: { KEY: "v" },
    });
  });

  test("空 args/env 不带字段", () => {
    const entry = formToEntry({ ...EMPTY_RUNTIME_FORM, name: "x", command: "y" });
    expect(entry.args).toBeUndefined();
    expect(entry.env).toBeUndefined();
  });
});
