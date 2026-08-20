/**
 * @fengagent/cli — 参数解析测试
 */

import { describe, test, expect } from "bun:test";
import { parseArgs, getHelpText, VERSION } from "../args.ts";

describe("parseArgs", () => {
  test("空参数返回默认值", () => {
    const result = parseArgs([]);
    expect(result.serve).toBe(false);
    expect(result.help).toBe(false);
    expect(result.version).toBe(false);
    expect(result.positional).toEqual([]);
  });

  test("解析 --model 参数", () => {
    const result = parseArgs(["--model", "gpt-4o"]);
    expect(result.model).toBe("gpt-4o");
  });

  test("解析 -m 短参数", () => {
    const result = parseArgs(["-m", "claude-sonnet-4"]);
    expect(result.model).toBe("claude-sonnet-4");
  });

  test("解析 --model=value 语法", () => {
    const result = parseArgs(["--model=gpt-4o"]);
    expect(result.model).toBe("gpt-4o");
  });

  test("解析 --port 参数", () => {
    const result = parseArgs(["--port", "8080"]);
    expect(result.port).toBe(8080);
  });

  test("解析 -p 短参数", () => {
    const result = parseArgs(["-p", "3001"]);
    expect(result.port).toBe(3001);
  });

  test("解析 --port=value 语法", () => {
    const result = parseArgs(["--port=9999"]);
    expect(result.port).toBe(9999);
  });

  test("无效端口抛出错误", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow();
  });

  test("端口超出范围抛出错误", () => {
    expect(() => parseArgs(["--port", "99999"])).toThrow();
  });

  test("解析 --session 参数", () => {
    const result = parseArgs(["--session", "abc-123-def"]);
    expect(result.session).toBe("abc-123-def");
  });

  test("解析 -s 短参数", () => {
    const result = parseArgs(["-s", "session-id"]);
    expect(result.session).toBe("session-id");
  });

  test("解析 serve 子命令", () => {
    const result = parseArgs(["serve"]);
    expect(result.serve).toBe(true);
  });

  test("解析 --help / -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("解析 --version / -v", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  test("位置参数收集", () => {
    const result = parseArgs(["hello", "world"]);
    expect(result.positional).toEqual(["hello", "world"]);
  });

  test("-- 之后的位置参数不解析", () => {
    const result = parseArgs(["--", "--model", "not-a-flag"]);
    expect(result.model).toBeUndefined();
    expect(result.positional).toEqual(["--model", "not-a-flag"]);
  });

  test("未知选项抛出错误", () => {
    expect(() => parseArgs(["--unknown"])).toThrow();
  });

  test("组合参数：serve + model + positional", () => {
    const result = parseArgs(["serve", "--model", "gpt-4o", "prompt-text"]);
    expect(result.serve).toBe(true);
    expect(result.model).toBe("gpt-4o");
    expect(result.positional).toEqual(["prompt-text"]);
  });

  test("--model 缺少值时抛出错误", () => {
    expect(() => parseArgs(["--model"])).toThrow();
  });

  test("--port 缺少值时抛出错误", () => {
    expect(() => parseArgs(["--port"])).toThrow();
  });

  test("--session 缺少值时抛出错误", () => {
    expect(() => parseArgs(["--session"])).toThrow();
  });
});

describe("getHelpText", () => {
  test("返回非空帮助文本", () => {
    const text = getHelpText();
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("FengAgentCli");
    expect(text).toContain("--model");
    expect(text).toContain("--port");
    expect(text).toContain("--session");
    expect(text).toContain("serve");
    expect(text).toContain("/help");
  });
});

describe("VERSION", () => {
  test("版本号格式正确", () => {
    expect(VERSION).toBe("0.2.0");
  });
});
