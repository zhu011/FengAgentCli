/**
 * @fengagent/agent — Agent 定义系统
 *
 * 从 `.fengagent/agents/*.md` 加载 Agent 定义。
 * frontmatter 配置：name、description、model、tools、max_turns、small_model。
 * body 作为系统提示。
 * 参考 ARCHITECTURE.md 第 4.4 节。
 */

import type { AgentInfo, Config } from "@fengagent/core";
import { AGENTS_DIR, MAX_TURNS } from "@fengagent/shared";
import { expandTilde } from "@fengagent/shared/utils";
import { join } from "node:path";

// ──────────────────────────────────────────────
// 内置 Agent 定义
// ──────────────────────────────────────────────

/** 内置 default Agent — 通用 Agent，继承当前配置 */
const BUILTIN_DEFAULT: AgentInfo = {
  name: "default",
  description: "通用 Agent，继承当前配置。",
  model: "", // 空字符串表示继承父 Agent 模型
  tools: [], // 空数组表示继承全部工具（排除 task）
  maxTurns: MAX_TURNS,
  systemPrompt: "", // 空字符串表示使用默认系统提示
};

/** 内置 coder Agent — 代码编写 Agent */
const BUILTIN_CODER: AgentInfo = {
  name: "coder",
  description: "代码编写 Agent，擅长读取、编写、编辑代码和执行命令。",
  model: "",
  tools: ["file-read", "file-write", "file-edit", "bash", "glob", "grep"],
  maxTurns: MAX_TURNS,
  systemPrompt: [
    "你是一个代码编写 Agent。你的职责是根据任务描述，读取相关代码、进行修改并验证。",
    "",
    "工作原则：",
    "1. 先阅读相关文件了解上下文",
    "2. 做最小化的修改，不要重构无关代码",
    "3. 修改后验证（运行测试或检查类型）",
    "4. 返回修改摘要，包括修改的文件和关键变更",
  ].join("\n"),
};

/** 内置 researcher Agent — 研究 Agent */
const BUILTIN_RESEARCHER: AgentInfo = {
  name: "researcher",
  description: "研究 Agent，擅长搜索代码、阅读文档和分析架构。",
  model: "",
  tools: ["file-read", "glob", "grep"],
  maxTurns: MAX_TURNS,
  systemPrompt: [
    "你是一个研究 Agent。你的职责是搜索和分析代码库，回答关于架构、实现和依赖的问题。",
    "",
    "工作原则：",
    "1. 使用 glob 和 grep 定位相关文件",
    "2. 阅读关键文件理解实现",
    "3. 提供结构化的分析结果",
    "4. 引用具体文件路径和行号",
  ].join("\n"),
};

/** 全部内置 Agent 定义 */
export const BUILTIN_AGENTS: Record<string, AgentInfo> = {
  default: BUILTIN_DEFAULT,
  coder: BUILTIN_CODER,
  researcher: BUILTIN_RESEARCHER,
};

// ──────────────────────────────────────────────
// Frontmatter 解析
// ──────────────────────────────────────────────

/**
 * 解析 Markdown 文件的 YAML frontmatter 和 body。
 *
 * 支持格式：
 * ```
 * ---
 * name: my-agent
 * model: claude-sonnet-4
 * tools:
 *   - file-read
 *   - grep
 * max_turns: 20
 * ---
 * 系统提示内容...
 * ```
 *
 * 不使用外部 YAML 库 — 实现一个支持子集的简易解析器
 * （key: value、列表、字符串）。
 */
export function parseAgentMarkdown(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: content.trim() };
  }

  const fmText = fmMatch[1]!;
  const body = (fmMatch[2] ?? "").trim();
  const frontmatter = parseSimpleYaml(fmText);

  return { frontmatter, body };
}

/**
 * 简易 YAML 解析器 — 支持 key: value 和列表项。
 * 不支持嵌套对象、引用、多行字符串等复杂特性。
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;

  for (const line of lines) {
    // 跳过空行和注释
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // 列表项（以 - 开头）
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey && currentList) {
      currentList.push(parseScalar(listMatch[1]!));
      continue;
    }

    // key: value
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      // 保存上一个列表
      if (currentKey && currentList) {
        result[currentKey] = currentList;
      }

      const key = kvMatch[1]!;
      const value = kvMatch[2]!;

      if (value.trim() === "") {
        // 值为空 — 可能是列表的开始
        currentKey = key;
        currentList = [];
      } else {
        result[key] = parseScalar(value);
        currentKey = null;
        currentList = null;
      }
      continue;
    }
  }

  // 保存最后一个列表
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

/** 解析标量值：去除引号、转换布尔/数字 */
function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();

  // 去除引号
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // 布尔值
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // 数字
  const num = Number(trimmed);
  if (trimmed !== "" && !Number.isNaN(num)) {
    return num;
  }

  return trimmed;
}

// ──────────────────────────────────────────────
// AgentDefinitionLoader
// ──────────────────────────────────────────────

/** Agent 定义加载器选项 */
export interface AgentDefinitionLoaderOptions {
  /** 工作目录（用于查找 .fengagent/agents/） */
  workdir?: string;
  /** Agent 定义目录路径（覆盖默认 workdir/.fengagent/agents） */
  agentsDir?: string;
  /** 基础配置（用于填充默认值） */
  config?: Pick<Config, "model" | "smallModel" | "maxTurns">;
}

/**
 * Agent 定义加载器。
 *
 * 职责：
 * - 从 `.fengagent/agents/*.md` 加载自定义 Agent 定义
 * - 合并内置 Agent 定义（default、coder、researcher）
 * - 提供 get(name) 和 list() 查询接口
 *
 * 用法：
 * ```typescript
 * const loader = createAgentDefinitionLoader({ workdir: process.cwd(), config });
 * await loader.load();
 * const def = loader.get("coder");
 * ```
 */
export function createAgentDefinitionLoader(
  options: AgentDefinitionLoaderOptions = {},
) {
  /** 已加载的 Agent 定义（name → AgentInfo） */
  const definitions = new Map<string, AgentInfo>();

  /** 是否已加载 */
  let loaded = false;

  /** 获取 Agent 定义目录路径 */
  function getAgentsDir(): string {
    if (options.agentsDir) {
      return expandTilde(options.agentsDir);
    }
    return join(options.workdir ?? ".", AGENTS_DIR);
  }

  /** 将 frontmatter + body 转换为 AgentInfo */
  function toAgentInfo(
    frontmatter: Record<string, unknown>,
    body: string,
    fallbackConfig?: AgentDefinitionLoaderOptions["config"],
  ): AgentInfo {
    const name = String(frontmatter["name"] ?? "").trim();
    if (!name) {
      throw new Error("Agent definition missing 'name' in frontmatter");
    }

    const tools = Array.isArray(frontmatter["tools"])
      ? (frontmatter["tools"] as unknown[]).map(String)
      : [];
    const maxTurns =
      typeof frontmatter["max_turns"] === "number"
        ? (frontmatter["max_turns"] as number)
        : fallbackConfig?.maxTurns ?? MAX_TURNS;

    return {
      name,
      description: String(frontmatter["description"] ?? ""),
      model: String(frontmatter["model"] ?? ""),
      tools,
      maxTurns,
      systemPrompt: body,
      smallModel: frontmatter["small_model"]
        ? String(frontmatter["small_model"])
        : undefined,
    };
  }

  /** 加载所有 Agent 定义 */
  async function load(): Promise<void> {
    if (loaded) return;

    // 先注册内置定义
    for (const [name, info] of Object.entries(BUILTIN_AGENTS)) {
      definitions.set(name, { ...info });
    }

    // 加载自定义定义
    const dir = getAgentsDir();
    try {
      const glob = new Bun.Glob("*.md");
      const files = [...glob.scanSync({ cwd: dir, absolute: true })];

      for (const filePath of files) {
        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) continue;
          const content = await file.text();
          const { frontmatter, body } = parseAgentMarkdown(content);
          const info = toAgentInfo(frontmatter, body, options.config);
          definitions.set(info.name, info);
        } catch {
          // 跳过解析失败的文件
        }
      }
    } catch {
      // 目录不存在或不可读 — 仅使用内置定义
    }

    loaded = true;
  }

  /** 获取指定 Agent 定义 */
  function get(name: string): AgentInfo | undefined {
    return definitions.get(name);
  }

  /** 列出所有 Agent 定义 */
  function list(): AgentInfo[] {
    return [...definitions.values()];
  }

  /** 列出所有 Agent 名称 */
  function names(): string[] {
    return [...definitions.keys()];
  }

  /** 重置（清除缓存，下次 load 重新加载） */
  function reset(): void {
    definitions.clear();
    loaded = false;
  }

  return {
    load,
    get,
    list,
    names,
    reset,
    /** 是否已加载 */
    get isLoaded(): boolean {
      return loaded;
    },
  };
}

/** AgentDefinitionLoader 实例类型 */
export type AgentDefinitionLoader = ReturnType<
  typeof createAgentDefinitionLoader
>;
