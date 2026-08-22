/**
 * @fengagent/server — 评测模块路由（评测 WebUI 数据源）
 *
 * 为 WebUI 评测页面提供：
 *   GET /api/eval/overview              — 评测报告 / 自优化建议 / 测试集 三合一清单
 *   GET /api/eval/reports/:date         — 指定日期的评测报告（Markdown）
 *   GET /api/eval/optimizations/:date   — 指定日期的自优化建议报告（Markdown）
 *
 * 数据源约定（见 docs/EVALUATION.md 二、三）：
 *   - 评测报告：<数据根>/logs/eval-report-{date}.md（bun run eval 落盘）
 *   - 自优化建议：<数据根>/optimizations/optimization-{date}.md（bun run eval --optimize 落盘）
 *   - 测试集：<数据根>/testsets/*.json（AgentBench / DeepEval 风格，由评测引擎接入；
 *     本路由仅做宽容解析与清单展示，供「测试集管理」界面消费）
 */

import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@fengagent/shared";
import { resolveBranchDataRoot } from "./observability.ts";

const log = createLogger("server");

/** 评测报告元信息 */
export interface EvalReportMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

/** 自优化建议报告元信息 */
export interface OptimizationMeta {
  date: string;
  path: string;
  size: number;
  modifiedAt: string;
}

/** 测试集元信息 */
export interface TestSetMeta {
  name: string;
  path: string;
  size: number;
  /** 测试用例数（宽容解析：数组 items / {cases|tests|examples} 字段） */
  records: number;
  /** 是否为有效 JSON */
  valid: boolean;
  /** 顶层结构概览（供 UI 展示 schema 风格） */
  shape: string;
}

/** 评测路由构造选项 */
export interface EvalRoutesOptions {
  /** 日志目录（默认 <数据根>/logs） */
  logDir?: string;
  /** 优化建议目录（默认 <数据根>/optimizations） */
  optimizationsDir?: string;
  /** 测试集目录（默认 <数据根>/testsets） */
  testsetsDir?: string;
}

/** 列出 `prefix-date.ext` 形态的文件并解析日期 */
function listDatedFiles(dir: string, prefix: string, ext: string): Array<{ date: string; path: string; size: number; modifiedAt: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const stat = statSync(path);
      const date = f.slice(prefix.length, -ext.length);
      return { date, path, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
}

/** 宽容解析测试集文件，统计用例数并给出结构概览 */
function summarizeTestSet(path: string): Pick<TestSetMeta, "records" | "valid" | "shape"> {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    let records = 0;
    if (Array.isArray(data)) records = data.length;
    else if (data && Array.isArray(data.items)) records = data.items.length;
    else if (data && Array.isArray(data.cases)) records = data.cases.length;
    else if (data && Array.isArray(data.tests)) records = data.tests.length;
    else if (data && Array.isArray(data.examples)) records = data.examples.length;
    else if (data && typeof data === "object") records = Object.keys(data).length;
    const shape = Array.isArray(data)
      ? `array[${data.length}]`
      : data && typeof data === "object"
        ? `object{${Object.keys(data).slice(0, 8).join(",")}}`
        : typeof data;
    return { records, valid: true, shape };
  } catch {
    return { records: 0, valid: false, shape: "invalid-json" };
  }
}

/** 创建评测模块路由 */
export function createEvalRoutes(options: EvalRoutesOptions = {}): Hono {
  const app = new Hono();
  const dataRoot = resolveBranchDataRoot();
  const logDir = options.logDir ?? join(dataRoot, "logs");
  const optimizationsDir = options.optimizationsDir ?? join(dataRoot, "optimizations");
  const testsetsDir = options.testsetsDir ?? join(dataRoot, "testsets");

  // GET /overview — 三合一清单
  app.get("/overview", (c) => {
    const reports = listDatedFiles(logDir, "eval-report-", ".md").map((f) => f as EvalReportMeta);
    const optimizations = listDatedFiles(optimizationsDir, "optimization-", ".md").map((f) => f as OptimizationMeta);
    const testsets: TestSetMeta[] = existsSync(testsetsDir)
      ? readdirSync(testsetsDir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => {
            const path = join(testsetsDir, f);
            const stat = statSync(path);
            const summary = summarizeTestSet(path);
            return {
              name: f.slice(0, -".json".length),
              path,
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              ...summary,
            };
          })
      : [];
    log.info("eval", `overview reports=${reports.length} optimizations=${optimizations.length} testsets=${testsets.length}`);
    return c.json({ reports, optimizations, testsets });
  });

  // GET /reports/:date — 评测报告内容（Markdown）
  app.get("/reports/:date", (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: { message: "date must be YYYY-MM-DD" } }, 400);
    }
    const path = join(logDir, `eval-report-${date}.md`);
    if (!existsSync(path)) {
      return c.json({ error: { message: `Eval report for ${date} not found` } }, 404);
    }
    const content = readFileSync(path, "utf-8");
    return c.json({ date, path, content });
  });

  // GET /optimizations/:date — 自优化建议报告内容（Markdown）
  app.get("/optimizations/:date", (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: { message: "date must be YYYY-MM-DD" } }, 400);
    }
    const path = join(optimizationsDir, `optimization-${date}.md`);
    if (!existsSync(path)) {
      return c.json({ error: { message: `Optimization report for ${date} not found` } }, 404);
    }
    const content = readFileSync(path, "utf-8");
    return c.json({ date, path, content });
  });

  // GET /testsets/:name — 单个测试集原始 JSON（供「测试集管理」界面查看/导出）
  app.get("/testsets/:name", (c) => {
    const name = c.req.param("name");
    // 仅允许文件名，拒绝路径穿越
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return c.json({ error: { message: "invalid test set name" } }, 400);
    }
    const path = join(testsetsDir, `${name}.json`);
    if (!existsSync(path)) {
      return c.json({ error: { message: `Test set "${name}" not found` } }, 404);
    }
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return c.json(data);
    } catch {
      return c.json({ error: { message: `Test set "${name}" is not valid JSON` } }, 422);
    }
  });

  return app;
}
