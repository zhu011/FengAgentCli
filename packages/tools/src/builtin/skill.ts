/**
 * @fengagent/tools — Skill 系统
 *
 * Skill 定义加载 + skill 工具实现。
 * 从 `.fengagent/skills/*.md` 加载 Skill 定义。
 * frontmatter: name, description, trigger
 * body: 可复用的 Prompt 模板
 *
 * 参考 ARCHITECTURE.md 第 4.5 节 Skills 系统。
 */

import { z } from "zod";
import { SKILLS_DIR } from "@fengagent/shared";
import { expandTilde } from "@fengagent/shared/utils";
import { join } from "node:path";
import type { ToolDefinition, ToolResult, ToolContext } from "@fengagent/core";
import { ALLOW } from "@fengagent/core";

// ──────────────────────────────────────────────
// Frontmatter 解析（内联实现，避免对 @fengagent/agent 的依赖）
// ──────────────────────────────────────────────

/** 解析 Markdown 的 YAML frontmatter 和 body */
function parseMarkdownFrontmatter(
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

/** 简易 YAML 解析器 — 支持 key: value 和列表项 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey && currentList) {
      currentList.push(parseScalar(listMatch[1]!));
      continue;
    }

    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      if (currentKey && currentList) {
        result[currentKey] = currentList;
      }
      const key = kvMatch[1]!;
      const value = kvMatch[2]!;
      if (value.trim() === "") {
        currentKey = key;
        currentList = [];
      } else {
        result[key] = parseScalar(value);
        currentKey = null;
        currentList = null;
      }
    }
  }
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }
  return result;
}

/** 解析标量值：去除引号、转换布尔/数字 */
function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const num = Number(trimmed);
  if (trimmed !== "" && !Number.isNaN(num)) return num;
  return trimmed;
}

// ──────────────────────────────────────────────
// Skill 定义类型
// ──────────────────────────────────────────────

/** Skill 定义 */
export interface SkillDefinition {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 触发条件描述（给 LLM 参考何时使用此技能） */
  trigger: string;
  /** Prompt 模板内容 */
  prompt: string;
}

// ──────────────────────────────────────────────
// 内置 Skills
// ──────────────────────────────────────────────

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: "code-review",
    description: "代码审查技能 — 系统性地审查代码质量、安全性和最佳实践",
    trigger: "当用户请求代码审查、review 代码或检查代码质量时使用",
    prompt: `你是一个代码审查专家。请按照以下维度系统性审查代码：

1. **正确性** — 逻辑是否正确，边界条件是否处理
2. **安全性** — 是否存在注入、XSS、敏感信息泄露等风险
3. **性能** — 是否有明显的性能问题（N+1 查询、不必要的循环等）
4. **可读性** — 命名是否清晰，注释是否充分
5. **一致性** — 是否遵循项目现有代码风格

输出格式：
- 按严重程度分类：🔴 严重 / 🟡 建议 / 🟢 良好
- 每条审查意见附上文件路径和行号
- 最后给出总体评价和建议优先级`,
  },
  {
    name: "debug",
    description: "调试辅助技能 — 系统性地定位和修复 bug",
    trigger: "当用户遇到 bug、错误或异常行为需要调试时使用",
    prompt: `你是一个调试专家。请按照以下步骤系统性定位问题：

1. **复现** — 确认能稳定复现问题，记录复现步骤
2. **定位** — 使用 grep/glob 搜索相关代码，阅读关键文件
3. **分析** — 分析错误信息、堆栈追踪，确定根因
4. **修复** — 做最小化修改修复问题
5. **验证** — 运行测试或手动验证修复是否有效

注意事项：
- 不要猜测根因，用证据说话
- 修复后检查是否引入新问题
- 如果无法确定根因，说明还需要什么信息`,
  },
  {
    name: "refactor",
    description: "重构建议技能 — 识别代码异味并提供重构方案",
    trigger: "当用户请求重构、优化代码结构或改善代码质量时使用",
    prompt: `你是一个重构专家。请按照以下原则提供重构建议：

1. **识别异味** — 检查重复代码、过长函数、过大类、过深嵌套等
2. **评估风险** — 评估每项重构的风险和收益
3. **分步方案** — 将重构拆分为小步骤，每步可独立验证
4. **保持行为** — 重构不改变外部行为，强调测试先行

常用重构手法：
- 提取函数 / 提取变量
- 合并条件表达式
- 以多态取代条件
- 移动函数 / 移动字段`,
  },
  {
    name: "test",
    description: "测试编写技能 — 编写高质量单元测试和集成测试",
    trigger: "当用户请求编写测试、增加测试覆盖或修复测试时使用",
    prompt: `你是一个测试专家。请按照以下原则编写测试：

1. **Arrange-Act-Assert** — 每个测试遵循三段式结构
2. **单一职责** — 每个测试只验证一个行为
3. **描述性命名** — 测试名描述被测试的行为和预期结果
4. **边界覆盖** — 正常值、边界值、异常值、空值
5. **独立性** — 测试之间不依赖执行顺序

测试结构模板：
\`\`\`
describe("模块名", () => {
  test("当条件时应该产生预期行为", () => {
    // Arrange
    // Act
    // Assert
  });
});
\`\`\``,
  },
];

// ──────────────────────────────────────────────
// Skill 加载器
// ──────────────────────────────────────────────

/** Skill 加载器选项 */
export interface SkillLoaderOptions {
  /** 工作目录 */
  workdir: string;
  /** Skills 目录路径（覆盖默认 workdir/.fengagent/skills） */
  skillsDir?: string;
}

/**
 * 创建 Skill 加载器。
 *
 * 职责：
 * - 从 `.fengagent/skills/*.md` 加载自定义 Skill 定义
 * - 合并内置 Skill 定义
 * - 提供 list() 和 get() 查询接口
 */
export function createSkillLoader(options: SkillLoaderOptions) {
  const skills = new Map<string, SkillDefinition>();
  let loaded = false;

  function getSkillsDir(): string {
    if (options.skillsDir) {
      return expandTilde(options.skillsDir);
    }
    return join(options.workdir, SKILLS_DIR);
  }

  /** 将 frontmatter + body 转换为 SkillDefinition */
  function toSkillDefinition(
    frontmatter: Record<string, unknown>,
    body: string,
  ): SkillDefinition {
    const name = String(frontmatter["name"] ?? "").trim();
    if (!name) {
      throw new Error("Skill definition missing 'name' in frontmatter");
    }
    return {
      name,
      description: String(frontmatter["description"] ?? ""),
      trigger: String(frontmatter["trigger"] ?? ""),
      prompt: body,
    };
  }

  /** 加载所有 Skill 定义 */
  async function load(): Promise<void> {
    if (loaded) return;

    // 先注册内置 Skills
    for (const skill of BUILTIN_SKILLS) {
      skills.set(skill.name, skill);
    }

    // 加载自定义 Skills
    const dir = getSkillsDir();
    try {
      const glob = new Bun.Glob("*.md");
      const files = [...glob.scanSync({ cwd: dir, absolute: true })];

      for (const filePath of files) {
        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) continue;
          const content = await file.text();
          const { frontmatter, body } = parseMarkdownFrontmatter(content);
          const skill = toSkillDefinition(frontmatter, body);
          skills.set(skill.name, skill);
        } catch {
          // 跳过解析失败的文件
        }
      }
    } catch {
      // 目录不存在或不可读 — 仅使用内置 Skills
    }

    loaded = true;
  }

  /** 获取指定 Skill */
  function get(name: string): SkillDefinition | undefined {
    return skills.get(name);
  }

  /** 列出所有 Skill */
  function list(): SkillDefinition[] {
    return [...skills.values()];
  }

  /** 列出所有 Skill 名称 */
  function names(): string[] {
    return [...skills.keys()];
  }

  return {
    load,
    get,
    list,
    names,
    get isLoaded(): boolean {
      return loaded;
    },
  };
}

/** SkillLoader 实例类型 */
export type SkillLoader = ReturnType<typeof createSkillLoader>;

// ──────────────────────────────────────────────
// skill 工具实现
// ──────────────────────────────────────────────

const skillSchema = z.object({
  action: z
    .enum(["list", "load"])
    .describe("Action: 'list' to list available skills, 'load' to load a specific skill's prompt"),
  name: z
    .string()
    .optional()
    .describe("Skill name to load (required when action='load')"),
});

type SkillInput = z.input<typeof skillSchema>;

/**
 * 创建 skill 工具。
 *
 * 需要注入 SkillLoader 实例。
 * 如果未提供 SkillLoader，工具会自动创建一个并加载。
 */
export function createSkillTool(skillLoader?: SkillLoader): ToolDefinition<SkillInput> {
  let loader = skillLoader;

  async function ensureLoader(workdir: string): Promise<SkillLoader> {
    if (!loader) {
      loader = createSkillLoader({ workdir });
      await loader.load();
    }
    return loader;
  }

  return {
    name: "skill",
    description: [
      "List available skills or load a skill's prompt template.",
      "Skills are reusable prompt templates loaded from .fengagent/skills/*.md.",
      "Use action='list' to see available skills, action='load' with a name to get the prompt.",
    ].join("\n"),

    inputSchema: skillSchema,

    isReadOnly(): boolean {
      return true;
    },
    isDestructive(): boolean {
      return false;
    },
    isConcurrencySafe(): boolean {
      return true;
    },
    checkPermissions() {
      return ALLOW;
    },

    async execute(input: SkillInput, context: ToolContext): Promise<ToolResult> {
      const ldr = await ensureLoader(context.workdir);

      if (input.action === "list") {
        const skills = ldr.list();
        if (skills.length === 0) {
          return {
            content: "No skills available.",
            metadata: { count: 0 },
          };
        }

        const lines: string[] = [`Available skills (${skills.length}):`];
        lines.push("");
        for (const skill of skills) {
          lines.push(`  ${skill.name} — ${skill.description}`);
          if (skill.trigger) {
            lines.push(`    Trigger: ${skill.trigger}`);
          }
        }
        return {
          content: lines.join("\n"),
          metadata: {
            count: skills.length,
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
          },
        };
      }

      if (input.action === "load") {
        if (!input.name) {
          return {
            content: "Error: 'name' is required when action='load'.",
            isError: true,
          };
        }

        const skill = ldr.get(input.name);
        if (!skill) {
          const available = ldr.names().join(", ");
          return {
            content: `Skill "${input.name}" not found. Available: ${available}`,
            isError: true,
          };
        }

        return {
          content: skill.prompt,
          metadata: {
            name: skill.name,
            description: skill.description,
            trigger: skill.trigger,
          },
        };
      }

      return {
        content: `Unknown action: ${input.action}. Use 'list' or 'load'.`,
        isError: true,
      };
    },

    renderUse(input: SkillInput): string {
      if (input.action === "list") {
        return "skill: list available skills";
      }
      return `skill: load "${input.name ?? "?"}"`;
    },
  };
}

/** 内置 skill 工具（使用默认 SkillLoader） */
export const skillTool = createSkillTool();
