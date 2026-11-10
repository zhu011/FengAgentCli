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
import { SKILL_INDEX_FILE, SKILLS_DIR } from "@fengagent/shared";
import { resolveDataRoot, resolveTeamSkillsDir } from "@fengagent/shared";
import { expandTilde } from "@fengagent/shared/utils";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** 技能来源层：内置 < 团队（用户级，跨 workdir） < 项目（本目录） */
export type SkillSource = "builtin" | "team" | "project";

/** 被上层同名技能覆盖的低优先级层 */
export interface SkillShadowedLayer {
  /** 被覆盖的层 */
  source: SkillSource;
  /** 被覆盖定义的文件路径（内置层无） */
  path?: string;
}

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
  /** 来源层 */
  source: SkillSource;
  /** 定义文件绝对路径（内置技能无） */
  path?: string;
  /** 是否启用（团队索引 `skills.json` 的 disabled 名单，对内置层同样生效） */
  enabled: boolean;
  /** 被当前技能覆盖的低优先级同名层（由低到高） */
  shadowed: SkillShadowedLayer[];
  /** 定义文件字节数（内置技能无） */
  bytes?: number;
  /** 定义文件最后修改时间（ISO，内置技能无） */
  updatedAt?: string;
}

/** 技能目录里解析失败的文件（不再静默吞掉，UI/TUI 可见） */
export interface SkillLoadError {
  /** 文件绝对路径 */
  path: string;
  /** 失败原因 */
  message: string;
}

// ──────────────────────────────────────────────
// 内置 Skills
// ──────────────────────────────────────────────

/** 内置技能的静态定义（来源/启用/覆盖关系由 loader 补齐） */
type BuiltinSkillSeed = Pick<SkillDefinition, "name" | "description" | "trigger" | "prompt">;

const BUILTIN_SKILLS: BuiltinSkillSeed[] = [
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
  /** Skills 目录路径（覆盖默认 project 层：`<workdir>/.fengagent/skills` + `<数据根>/skills`） */
  skillsDir?: string;
  /** 团队技能目录（缺省 `FENG_TEAM_HOME` > `~/.fengagent-cordis/skills`） */
  teamDir?: string;
  /** 自定义 project 层目录（由低到高；提供时忽略 `skillsDir`/默认目录） */
  projectDirs?: string[];
  /** 环境变量（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
  /** home 目录（默认 env.HOME/USERPROFILE/home） */
  home?: string;
}

/** 单层扫描结果 */
interface ScannedLayer {
  source: SkillSource;
  skills: SkillDefinition[];
  errors: SkillLoadError[];
}

/**
 * 创建 Skill 加载器。
 *
 * 合并序（低 → 高，同名后者覆盖前者）：
 *
 *   builtin（代码内 4 个） → team（`~/.fengagent-cordis/skills`，跨 workdir 共享）
 *   → project（`<workdir>/.fengagent/skills` 只读兼容，`<数据根>/skills`）
 *
 * 停用语义：团队索引 `<team>/skills.json` 的 `disabled` 名单对**所有层**生效 —— 停用后
 * `list()/get()/names()` 都不含（skill 工具与 `/skill` 因此同步不可见），而 `all()` 仍
 * 能看到它（管理面要展示开关状态）。`shadowed` 记录被覆盖的低优先级层，供 UI 标「已被覆盖」。
 *
 * 缓存按「目录 mtime + 文件 mtime/size + 索引 mtime」判定失效：长驻 server 进程里新加/改
 * 一个 .md 不需要重启也可见。
 */
export function createSkillLoader(options: SkillLoaderOptions) {
  const env = options.env ?? process.env;
  let loaded = false;
  let cache: {
    signature: string;
    byName: Map<string, SkillDefinition>;
    layers: Array<SkillDefinition & { overriddenBy?: SkillSource }>;
    errors: SkillLoadError[];
  } | null = null;

  function teamSkillsDir(): string {
    if (options.teamDir) return expandTilde(options.teamDir);
    return resolveTeamSkillsDir({ env, ...(options.home ? { home: options.home } : {}) });
  }

  function projectSkillsDirs(): string[] {
    if (options.projectDirs && options.projectDirs.length > 0) {
      return options.projectDirs.map((d) => expandTilde(d));
    }
    if (options.skillsDir) return [expandTilde(options.skillsDir)];
    const legacy = join(options.workdir, SKILLS_DIR);
    const dataRoot = resolveDataRoot({ workdir: options.workdir, env });
    const modern = join(dataRoot, "skills");
    return legacy === modern ? [legacy] : [legacy, modern];
  }

  /** 各层目录（低 → 高） */
  function layers(): Array<{ source: SkillSource; dir: string }> {
    return [
      { source: "team" as const, dir: teamSkillsDir() },
      ...projectSkillsDirs().map((dir) => ({ source: "project" as const, dir })),
    ];
  }

  /** 目录 + 文件 + 索引的 mtime/size 指纹（用于缓存失效） */
  function signature(): string {
    const parts: string[] = [];
    for (const layer of layers()) {
      try {
        const st = statSync(layer.dir);
        parts.push(`${layer.dir}|d|${st.mtimeMs}`);
        const files = readdirSync(layer.dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name)
          .sort();
        for (const name of files) {
          try {
            const fst = statSync(join(layer.dir, name));
            parts.push(`${name}|${fst.mtimeMs}|${fst.size}`);
          } catch {
            parts.push(`${name}|missing`);
          }
        }
      } catch {
        parts.push(`${layer.dir}|missing`);
      }
    }
    const index = join(teamSkillsDir(), SKILL_INDEX_FILE);
    try {
      const st = statSync(index);
      parts.push(`index|${st.mtimeMs}|${st.size}`);
    } catch {
      parts.push("index|missing");
    }
    return parts.join("\n");
  }

  /** 读取团队索引里的 disabled 名单（损坏时记一条 error，不影响其他技能） */
  function readDisabled(errors: SkillLoadError[]): Set<string> {
    const index = join(teamSkillsDir(), SKILL_INDEX_FILE);
    let raw: string;
    try {
      raw = readFileSync(index, "utf-8");
    } catch {
      return new Set();
    }
    try {
      const parsed = JSON.parse(raw) as { disabled?: unknown };
      const list = Array.isArray(parsed.disabled) ? parsed.disabled : [];
      return new Set(list.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v));
    } catch (err) {
      errors.push({
        path: index,
        message: `技能索引不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return new Set();
    }
  }

  /** 扫描单层目录（解析失败进 errors，不静默吞） */
  function scanLayer(source: SkillSource, dir: string): ScannedLayer {
    const skills: SkillDefinition[] = [];
    const errors: SkillLoadError[] = [];
    let files: string[];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => join(dir, entry.name));
    } catch {
      // 目录不存在/不可读 — 这一层为空
      return { source, skills, errors };
    }

    for (const filePath of files) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseMarkdownFrontmatter(raw);
        const base = toSkillDefinition(frontmatter, body);
        let updatedAt: string | undefined;
        let bytes: number | undefined;
        try {
          const st = statSync(filePath);
          updatedAt = new Date(st.mtimeMs).toISOString();
          bytes = st.size;
        } catch {
          // 统计失败不影响技能本身
        }
        skills.push({
          ...base,
          source,
          path: filePath,
          enabled: true,
          shadowed: [],
          ...(updatedAt ? { updatedAt } : {}),
          ...(bytes !== undefined ? { bytes } : {}),
        });
      } catch (err) {
        errors.push({
          path: filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { source, skills, errors };
  }

  /** 将 frontmatter + body 转换为 SkillDefinition */
  function toSkillDefinition(
    frontmatter: Record<string, unknown>,
    body: string,
  ): Omit<SkillDefinition, "source" | "enabled" | "shadowed"> {
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

  /** 全量重建（内置 → team → project，同名覆盖） */
  function build(): void {
    const errors: SkillLoadError[] = [];
    const byName = new Map<string, SkillDefinition>();
    const layerEntries: Array<SkillDefinition & { overriddenBy?: SkillSource }> = [];

    for (const skill of BUILTIN_SKILLS) {
      const entry: SkillDefinition = {
        ...skill,
        source: "builtin",
        enabled: true,
        shadowed: [],
      };
      byName.set(skill.name, entry);
      layerEntries.push(entry);
    }

    const disabled = readDisabled(errors);

    for (const layer of layers()) {
      const scanned = scanLayer(layer.source, layer.dir);
      errors.push(...scanned.errors);
      for (const skill of scanned.skills) {
        const prev = byName.get(skill.name);
        if (prev) {
          skill.shadowed = [...prev.shadowed, { source: prev.source, ...(prev.path ? { path: prev.path } : {}) }];
        }
        byName.set(skill.name, skill);
        layerEntries.push(skill);
      }
    }

    // 停用名单对内置层同样生效
    for (const skill of byName.values()) {
      if (disabled.has(skill.name)) skill.enabled = false;
    }

    // 逐层明细：被更高优先级同名条目覆盖时标出「被谁覆盖」
    for (const entry of layerEntries) {
      const winner = byName.get(entry.name);
      if (winner && winner !== entry) entry.overriddenBy = winner.source;
    }

    cache = { signature: signature(), byName, layers: layerEntries, errors };
  }

  /** 指纹变了就重建（每次读都保证拿到最新盘上状态） */
  function ensureFresh(force = false): void {
    if (force || !cache || cache.signature !== signature()) build();
  }

  /** 加载所有 Skill 定义（异步签名保留给既有调用方） */
  async function load(): Promise<void> {
    ensureFresh();
    loaded = true;
  }

  /** 同步加载（TUI slash 命令等同步上下文） */
  function loadSync(): void {
    ensureFresh();
    loaded = true;
  }

  /** 强制重新读盘 */
  function reload(): void {
    ensureFresh(true);
    loaded = true;
  }

  /** 获取指定 Skill（已停用的不可见） */
  function get(name: string): SkillDefinition | undefined {
    ensureFresh();
    const skill = cache!.byName.get(name);
    return skill?.enabled ? skill : undefined;
  }

  /** 列出所有已启用 Skill（按名称排序） */
  function list(): SkillDefinition[] {
    ensureFresh();
    return [...cache!.byName.values()].filter((s) => s.enabled).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 列出所有已启用 Skill 名称 */
  function names(): string[] {
    return list().map((s) => s.name);
  }

  /** 列出全部 Skill（含已停用；管理面用） */
  function all(): SkillDefinition[] {
    ensureFresh();
    return [...cache!.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 解析失败的文件（管理面 / `/skill list` 尾部提示） */
  function errors(): SkillLoadError[] {
    ensureFresh();
    return [...cache!.errors];
  }

  /** 逐层明细（含被覆盖的条目；管理面用，`overriddenBy` 指出被谁覆盖） */
  function layersDetail(): Array<SkillDefinition & { overriddenBy?: SkillSource }> {
    ensureFresh();
    return [...cache!.layers];
  }

  /** 各层根目录（管理面展示「技能从哪来」） */
  function roots(): { team: string; project: string[] } {
    return { team: teamSkillsDir(), project: projectSkillsDirs() };
  }

  return {
    workdir: options.workdir,
    load,
    loadSync,
    reload,
    get,
    list,
    names,
    all,
    layers: layersDetail,
    errors,
    roots,
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
 * 如果未提供 SkillLoader，工具会按 context.workdir 自动创建并加载 —— 同一进程里
 * 换 workdir 会换 loader（skill 的 project 层是「本目录」语义，不能跨目录复用）。
 */
export function createSkillTool(skillLoader?: SkillLoader): ToolDefinition<SkillInput> {
  let loader = skillLoader;

  async function ensureLoader(workdir: string): Promise<SkillLoader> {
    if (!loader || loader.workdir !== workdir) {
      loader = createSkillLoader({ workdir });
      await loader.load();
    } else {
      // 长驻进程：盘上新增/修改/停用要在每次调用时可见
      loader.reload();
    }
    return loader;
  }

  return {
    name: "skill",
    description: [
      "List available skills or load a skill's prompt template.",
      "Skills are reusable prompt templates merged from builtin skills,",
      "the team skill library (~/.fengagent-cordis/skills, shared across workdirs),",
      "and this workdir's .fengagent/skills/*.md (higher priority overrides lower).",
      "Disabled skills are not listed and cannot be loaded.",
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
          const sourceTag = skill.source === "builtin" ? "" : ` [${skill.source}]`;
          lines.push(`  ${skill.name}${sourceTag} — ${skill.description}`);
          if (skill.trigger) {
            lines.push(`    Trigger: ${skill.trigger}`);
          }
        }
        return {
          content: lines.join("\n"),
          metadata: {
            count: skills.length,
            skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })),
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
            source: skill.source,
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
