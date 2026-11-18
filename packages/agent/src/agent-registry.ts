/**
 * @fengagent/agent — 智能体仓（目录即真相）
 *
 * 把「智能体」从一条 frontmatter + 一个字符串，提升成**一等公民**：
 *
 * ```
 * <dataRoot>/agents/
 *   coder/
 *     agent.md      # frontmatter（绑定/权限/模型）+ body（instructions）
 *     config.json   # env / envSecrets / args / skills / mcp / integrations
 * ```
 *
 * 三条刻意的设计选择（见 docs/AI-TEAM-PLATFORM-SPEC.md §4.2 / §5.1.1）：
 *
 * 1. **内容以文件为准**：一个 agent 一个目录，可 git、可复制、可手改；
 *    删除目录即下线 —— 与 agent-network 的「目录即真相」同一口径。
 * 2. **旧格式永远可读**：`.fengagent/agents/*.md`（平铺）继续被加载器读到，
 *    首次写入时迁移成目录形态，但**不删除**原文件（迁移幂等）。
 * 3. **归档不删数据**：`archived_at` 只是软删，目录与历史 run 全部保留。
 *
 * P0 不引入新表：绑定/配置/权限都是文件字段，概览与历史由 `RunIndex` 读侧聚合。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "@fengagent/shared";
import { parseAgentMarkdown } from "./agent-definition.ts";

/** 可见性：private = 仅本机；workspace = 同数据根内其他 agent 可发现 */
export type AgentVisibility = "private" | "workspace";

/** 工具调用级别权限：inherit 沿用全局规则 */
export type AgentPermissionMode = "inherit" | "ask" | "allow" | "deny";

/** 来源类型：user = 用户创建；builtin = 内置（后续阶段使用） */
export type AgentKind = "user" | "builtin";

/** `agents/<id>/config.json`（全部字段可缺省） */
export interface AgentConfigFile {
  /** 明文非敏感环境变量 */
  env: Record<string, string>;
  /** 敏感变量只存引用（`secret://<name>`），真实值在 secrets.env */
  envSecrets: Record<string, string>;
  /** 追加到 runtime CLI 的自定义参数 */
  args: string[];
  /** 默认工作目录覆盖（空 = 用派单默认目录） */
  cwd?: string;
  /** 挂载的 skill 名（P1 起与 agent_skill 表双写） */
  skills: string[];
  /** 挂载的 MCP server 名 */
  mcp: string[];
  /** 外部平台集成（P3） */
  integrations: string[];
}

/** 智能体记录（文件读出来的内存视图） */
export interface AgentRecord {
  /** 稳定 id = 目录名，创建后不可改 */
  id: string;
  /** 展示名 */
  displayName: string;
  description: string;
  /** system prompt 正文 */
  instructions: string;
  /** 绑定的 runtime 注册名；null = 未绑定（可编辑、可看历史、不能执行） */
  runtime: string | null;
  /** 主 runtime 不可用时的降级顺序 */
  runtimeFallbacks: string[];
  model: string;
  tools: string[];
  maxTurns: number;
  visibility: AgentVisibility;
  permissionMode: AgentPermissionMode;
  kind: AgentKind;
  createdAt: number;
  updatedAt: number;
  /** 归档时间（软删）；有值后不可派单，历史仍可查 */
  archivedAt?: number;
  config: AgentConfigFile;
}

/** 内置模板（一键创建） */
export interface AgentTemplate {
  id: string;
  displayName: string;
  description: string;
  instructions: string;
  tools: string[];
  maxTurns: number;
  /** 建议绑定的 runtime（本机装了才自动绑定） */
  suggestedRuntime?: string;
}

/** 内置模板：覆盖「写代码 / 调研 / 评审」三个最常用角色 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "coder",
    displayName: "代码工程师",
    description: "代码编写 Agent，擅长读取、修改代码并验证。",
    tools: ["file-read", "file-write", "file-edit", "bash", "glob", "grep"],
    maxTurns: 50,
    suggestedRuntime: "claude",
    instructions: [
      "你是一个代码编写 Agent。你的职责是根据任务描述，读取相关代码、进行修改并验证。",
      "",
      "工作原则：",
      "1. 先阅读相关文件了解上下文",
      "2. 做最小化的修改，不要重构无关代码",
      "3. 修改后验证（运行测试或检查类型）",
      "4. 返回修改摘要，包括修改的文件和关键变更",
    ].join("\n"),
  },
  {
    id: "researcher",
    displayName: "研究员",
    description: "研究 Agent，擅长搜索代码、阅读文档和分析架构。",
    tools: ["file-read", "glob", "grep"],
    maxTurns: 30,
    suggestedRuntime: "dsh",
    instructions: [
      "你是一个研究 Agent。你的职责是搜索和分析代码库，回答关于架构、实现和依赖的问题。",
      "",
      "工作原则：",
      "1. 使用 glob 和 grep 定位相关文件",
      "2. 阅读关键文件理解实现",
      "3. 提供结构化的分析结果",
      "4. 引用具体文件路径和行号",
    ].join("\n"),
  },
  {
    id: "reviewer",
    displayName: "评审员",
    description: "代码评审 Agent，优先找回归、边界与安全问题。",
    tools: ["file-read", "glob", "grep", "bash"],
    maxTurns: 30,
    suggestedRuntime: "claude",
    instructions: [
      "你是一个代码评审 Agent。你的职责是审查改动，找出真正的缺陷。",
      "",
      "工作原则：",
      "1. 先跑类型检查/测试，再看 diff",
      "2. 只报有证据的问题（文件:行号 + 复现路径），不做风格偏好之争",
      "3. 按严重程度排序：阻断 > 回归 > 边界 > 建议",
      "4. 给不出问题的结论时明确写「未发现阻断问题」",
    ].join("\n"),
  },
];

/** 仓错误码（路由映射 HTTP 状态） */
export type AgentRegistryErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_id"
  | "invalid_config"
  | "template_not_found"
  | "io_error";

/** 智能体仓错误 */
export class AgentRegistryError extends Error {
  readonly code: AgentRegistryErrorCode;
  readonly status: 400 | 404 | 409 | 422 | 500;

  constructor(code: AgentRegistryErrorCode, message: string) {
    super(message);
    this.name = "AgentRegistryError";
    this.code = code;
    this.status =
      code === "not_found"
        ? 404
        : code === "conflict"
          ? 409
          : code === "template_not_found" || code === "invalid_config"
            ? 422
            : code === "io_error"
              ? 500
              : 400;
  }

  toPayload(): { error: { message: string; code: AgentRegistryErrorCode } } {
    return { error: { message: this.message, code: this.code } };
  }
}

/** 创建入参 */
export interface CreateAgentInput {
  id?: string;
  displayName?: string;
  description?: string;
  instructions?: string;
  runtime?: string | null;
  runtimeFallbacks?: string[];
  model?: string;
  tools?: string[];
  maxTurns?: number;
  visibility?: AgentVisibility;
  permissionMode?: AgentPermissionMode;
  /** 内置模板 id（coder / researcher / reviewer） */
  template?: string;
  config?: Partial<AgentConfigFile>;
}

/** 更新入参（只改出现的字段） */
export interface UpdateAgentInput {
  displayName?: string;
  description?: string;
  instructions?: string;
  /** null = 解绑（历史 run 全部保留） */
  runtime?: string | null;
  runtimeFallbacks?: string[];
  model?: string;
  tools?: string[];
  maxTurns?: number;
  visibility?: AgentVisibility;
  permissionMode?: AgentPermissionMode;
  config?: Partial<AgentConfigFile>;
}

/** 仓选项 */
export interface AgentRegistryOptions {
  /** 数据根：agent 目录默认 `<dataRoot>/agents` */
  dataRoot: string;
  /** 工作目录（用于定位旧平铺目录 `.fengagent/agents`） */
  workdir?: string;
  /** 覆盖 agent 目录（测试用） */
  agentsDir?: string;
  /** 覆盖旧平铺目录（测试用） */
  legacyDir?: string;
  now?: () => number;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 单行化：frontmatter 的值不能带换行（简易 YAML 只支持单行标量） */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/** 由展示名生成稳定 id（中文等非 ASCII 回退为随机后缀） */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug === "" ? `agent-${Math.random().toString(36).slice(2, 8)}` : slug;
}

/** 字符串数组去重 + 去空 */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = String(item).trim();
    if (text !== "" && !out.includes(text)) out.push(text);
  }
  return out;
}

/** 读 JSON（文件缺失/损坏回退默认值，不抛错 —— 坏一个 agent 不该拖垮列表） */
function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 归一 config.json：只保留认识的字段，数组/对象逐项校验 */
function normalizeConfig(raw: unknown): AgentConfigFile {
  const value = (raw ?? {}) as Partial<AgentConfigFile>;
  const env: Record<string, string> = {};
  if (value.env && typeof value.env === "object") {
    for (const [key, item] of Object.entries(value.env)) {
      if (typeof item === "string") env[key] = item;
    }
  }
  const envSecrets: Record<string, string> = {};
  if (value.envSecrets && typeof value.envSecrets === "object") {
    for (const [key, item] of Object.entries(value.envSecrets)) {
      if (typeof item === "string") envSecrets[key] = item;
    }
  }
  const args = stringArray(value.args).map((arg) => {
    // 自定义参数会原样追加到 CLI：换行/超长直接拒绝（防注入）
    if (arg.includes("\n") || arg.includes("\r")) {
      throw new AgentRegistryError("invalid_config", "自定义参数不能包含换行");
    }
    if (arg.length > 4096) {
      throw new AgentRegistryError("invalid_config", "自定义参数长度不能超过 4096");
    }
    return arg;
  });
  return {
    env,
    envSecrets,
    args,
    ...(typeof value.cwd === "string" && value.cwd !== "" ? { cwd: value.cwd } : {}),
    skills: stringArray(value.skills),
    mcp: stringArray(value.mcp),
    integrations: stringArray(value.integrations),
  };
}

/**
 * 智能体仓。
 *
 * ```ts
 * const registry = new AgentRegistry({ dataRoot, workdir });
 * const coder = registry.create({ displayName: "代码工程师", template: "coder", runtime: "claude" });
 * registry.update(coder.id, { runtime: null });   // 解绑，历史不丢
 * ```
 */
export class AgentRegistry {
  /** 数据根（`sessions.db` / `secrets.env` 与 `agents/` 同级） */
  readonly dataRoot: string;
  private readonly agentsDir: string;
  private readonly legacyDir: string;
  private readonly now: () => number;

  constructor(options: AgentRegistryOptions) {
    this.dataRoot = options.dataRoot;
    this.agentsDir = options.agentsDir ?? join(options.dataRoot, "agents");
    this.legacyDir = options.legacyDir ?? join(options.workdir ?? ".", AGENTS_DIR);
    this.now = options.now ?? Date.now;
  }

  /** agent 目录（`<dataRoot>/agents`） */
  get directory(): string {
    return this.agentsDir;
  }

  /** 模板列表 */
  templates(): readonly AgentTemplate[] {
    return AGENT_TEMPLATES;
  }

  /**
   * 列出所有智能体（默认不含已归档）。
   *
   * 目录形态优先；旧平铺 `.md` 仍可读（不写盘，等第一次 PATCH 再迁移）。
   */
  list(options: { includeArchived?: boolean } = {}): AgentRecord[] {
    const agents = this.loadAll();
    const visible = options.includeArchived
      ? agents
      : agents.filter((agent) => agent.archivedAt === undefined);
    return visible.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 取单个（含已归档；不存在返回 null） */
  get(id: string): AgentRecord | null {
    if (!ID_PATTERN.test(id)) return null;
    const dirFile = join(this.agentsDir, id, "agent.md");
    if (existsSync(dirFile)) return this.readDirAgent(id, dirFile);
    const flatCandidates = [join(this.agentsDir, `${id}.md`), join(this.legacyDir, `${id}.md`)];
    for (const flat of flatCandidates) {
      if (!existsSync(flat)) continue;
      const parsed = this.readFlatAgent(id, flat);
      if (parsed) return parsed;
    }
    return null;
  }

  /**
   * 创建智能体（支持内置模板一键创建）。
   *
   * @throws {AgentRegistryError} id 非法 / 重名 / 模板不存在
   */
  create(input: CreateAgentInput): AgentRecord {
    const template =
      input.template === undefined
        ? undefined
        : AGENT_TEMPLATES.find((item) => item.id === input.template);
    if (input.template !== undefined && template === undefined) {
      throw new AgentRegistryError("template_not_found", `模板不存在: ${input.template}`);
    }

    const baseName = input.displayName ?? template?.displayName ?? input.id ?? "agent";
    // 模板一键创建：没给 id 时优先用模板 id（coder / researcher / reviewer），
    // 而不是把中文展示名 slug 成随机串；重名再由调用方换 id 或报 409。
    const rawId = input.id ?? (template === undefined ? slugify(baseName) : template.id);
    if (!ID_PATTERN.test(rawId)) {
      throw new AgentRegistryError(
        "invalid_id",
        `agent id 只能是小写字母/数字/._-（1-64 位），收到: ${rawId}`,
      );
    }
    if (this.exists(rawId)) {
      throw new AgentRegistryError("conflict", `agent 已存在: ${rawId}`);
    }

    const at = this.now();
    const config = normalizeConfig({ ...(input.config ?? {}) });
    const agent: AgentRecord = {
      id: rawId,
      displayName: oneLine(input.displayName ?? template?.displayName ?? rawId),
      description: oneLine(input.description ?? template?.description ?? ""),
      instructions: (input.instructions ?? template?.instructions ?? "").trim(),
      runtime: normalizeRuntime(input.runtime),
      runtimeFallbacks: stringArray(input.runtimeFallbacks),
      model: input.model ?? "",
      tools: input.tools ?? template?.tools ?? [],
      maxTurns: input.maxTurns ?? template?.maxTurns ?? 30,
      visibility: input.visibility ?? "private",
      permissionMode: input.permissionMode ?? "inherit",
      kind: "user",
      createdAt: at,
      updatedAt: at,
      config,
    };
    this.writeAgent(agent);
    return agent;
  }

  /**
   * 更新智能体（只改出现的字段；`runtime: null` = 解绑）。
   *
   * 旧平铺文件在这里被迁移成目录形态（原文件保留）。
   *
   * @throws {AgentRegistryError} 不存在
   */
  update(id: string, patch: UpdateAgentInput): AgentRecord {
    const current = this.get(id);
    if (!current) throw new AgentRegistryError("not_found", `agent 不存在: ${id}`);
    const at = this.now();
    const next: AgentRecord = {
      ...current,
      ...(patch.displayName === undefined
        ? {}
        : { displayName: oneLine(patch.displayName) }),
      ...(patch.description === undefined
        ? {}
        : { description: oneLine(patch.description) }),
      ...(patch.instructions === undefined
        ? {}
        : { instructions: patch.instructions.trim() }),
      ...(patch.runtime === undefined ? {} : { runtime: normalizeRuntime(patch.runtime) }),
      ...(patch.runtimeFallbacks === undefined
        ? {}
        : { runtimeFallbacks: stringArray(patch.runtimeFallbacks) }),
      ...(patch.model === undefined ? {} : { model: patch.model }),
      ...(patch.tools === undefined ? {} : { tools: stringArray(patch.tools) }),
      ...(patch.maxTurns === undefined ? {} : { maxTurns: patch.maxTurns }),
      ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
      ...(patch.permissionMode === undefined
        ? {}
        : { permissionMode: patch.permissionMode }),
      ...(patch.config === undefined
        ? {}
        : { config: normalizeConfig({ ...current.config, ...patch.config }) }),
      updatedAt: at,
    };
    this.writeAgent(next);
    return next;
  }

  /**
   * 归档（软删）：不删目录、不删历史，只是不再出现在列表里、不能再派单。
   *
   * @throws {AgentRegistryError} 不存在
   */
  archive(id: string): AgentRecord {
    const current = this.get(id);
    if (!current) throw new AgentRegistryError("not_found", `agent 不存在: ${id}`);
    if (current.archivedAt !== undefined) return current;
    const at = this.now();
    const next: AgentRecord = { ...current, archivedAt: at, updatedAt: at };
    this.writeAgent(next);
    return next;
  }

  /**
   * 迁移旧平铺定义到目录形态（幂等，保留原文件）。
   *
   * @returns 本次真正迁移的 id 列表
   */
  migrateLegacy(): string[] {
    const migrated: string[] = [];
    for (const id of this.scanFlatIds()) {
      if (existsSync(join(this.agentsDir, id, "agent.md"))) continue;
      const agent = this.get(id);
      if (!agent) continue;
      this.writeAgent(agent);
      migrated.push(id);
    }
    return migrated;
  }

  /** 是否已存在（目录或旧平铺） */
  private exists(id: string): boolean {
    return (
      existsSync(join(this.agentsDir, id, "agent.md")) ||
      existsSync(join(this.agentsDir, `${id}.md`)) ||
      existsSync(join(this.legacyDir, `${id}.md`))
    );
  }

  /** 扫描全部来源（目录优先） */
  private loadAll(): AgentRecord[] {
    const byId = new Map<string, AgentRecord>();
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(this.agentsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!ID_PATTERN.test(entry.name)) continue;
      const file = join(this.agentsDir, entry.name, "agent.md");
      if (!existsSync(file)) continue;
      const agent = this.readDirAgent(entry.name, file);
      if (agent) byId.set(agent.id, agent);
    }
    for (const id of this.scanFlatIds()) {
      if (byId.has(id)) continue;
      const agent = this.get(id);
      if (agent) byId.set(agent.id, agent);
    }
    return [...byId.values()];
  }

  /** 旧平铺目录里的 id 列表（不读内容） */
  private scanFlatIds(): string[] {
    const ids = new Set<string>();
    for (const dir of [this.agentsDir, this.legacyDir]) {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((name) => name.endsWith(".md"));
      } catch {
        continue;
      }
      for (const file of files) {
        const id = file.slice(0, -3);
        if (ID_PATTERN.test(id)) ids.add(id);
      }
    }
    return [...ids];
  }

  /** 读目录形态 */
  private readDirAgent(id: string, file: string): AgentRecord | null {
    try {
      const parsed = parseAgentMarkdown(readFileSync(file, "utf8"));
      const stat = statSync(file);
      const config = normalizeConfig(
        readJson<Partial<AgentConfigFile>>(join(this.agentsDir, id, "config.json"), {}),
      );
      return this.toRecord(id, parsed.frontmatter, parsed.body, config, stat.mtimeMs);
    } catch {
      return null;
    }
  }

  /** 读旧平铺形态 */
  private readFlatAgent(id: string, file: string): AgentRecord | null {
    try {
      const parsed = parseAgentMarkdown(readFileSync(file, "utf8"));
      const stat = statSync(file);
      const config = normalizeConfig({});
      const record = this.toRecord(id, parsed.frontmatter, parsed.body, config, stat.mtimeMs);
      return record ? { ...record, runtime: normalizeRuntime(parsed.frontmatter["runtime"]) } : null;
    } catch {
      return null;
    }
  }

  /** frontmatter + body + config → 记录 */
  private toRecord(
    id: string,
    frontmatter: Record<string, unknown>,
    body: string,
    config: AgentConfigFile,
    mtimeMs: number,
  ): AgentRecord {
    const createdAt = numberOr(frontmatter["created_at"], Math.round(mtimeMs));
    const updatedAt = numberOr(frontmatter["updated_at"], createdAt);
    const archivedAt = numberOr(frontmatter["archived_at"], null);
    return {
      id,
      displayName: oneLine(String(frontmatter["display_name"] ?? frontmatter["name"] ?? id)),
      description: oneLine(String(frontmatter["description"] ?? "")),
      instructions: body.trim(),
      runtime: normalizeRuntime(frontmatter["runtime"]),
      runtimeFallbacks: stringArray(frontmatter["runtime_fallbacks"]),
      model: String(frontmatter["model"] ?? ""),
      tools: stringArray(frontmatter["tools"]),
      maxTurns: numberOr(frontmatter["max_turns"], 30),
      visibility: frontmatter["visibility"] === "workspace" ? "workspace" : "private",
      permissionMode: normalizePermissionMode(frontmatter["permission_mode"]),
      kind: frontmatter["kind"] === "builtin" ? "builtin" : "user",
      createdAt,
      updatedAt,
      ...(archivedAt === null ? {} : { archivedAt }),
      config,
    };
  }

  /** 写目录形态（agent.md + config.json） */
  private writeAgent(agent: AgentRecord): void {
    const dir = join(this.agentsDir, agent.id);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agent.md"), serializeAgentMarkdown(agent), "utf8");
      writeFileSync(
        join(dir, "config.json"),
        `${JSON.stringify(agent.config, null, 2)}\n`,
        "utf8",
      );
    } catch (err) {
      throw new AgentRegistryError(
        "io_error",
        `写入 agent 失败（${dir}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** runtime 归一：空串/null → null（解绑） */
function normalizeRuntime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** permission_mode 归一 */
function normalizePermissionMode(value: unknown): AgentPermissionMode {
  return value === "ask" || value === "allow" || value === "deny" ? value : "inherit";
}

/** 数字字段（非法/缺失回退） */
function numberOr(value: unknown, fallback: number): number;
function numberOr(value: unknown, fallback: null): number | null;
function numberOr(value: unknown, fallback: number | null): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * 序列化 `agent.md`（frontmatter 单行标量 + block list，兼容既有简易解析器）。
 */
export function serializeAgentMarkdown(agent: AgentRecord): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${agent.id}`);
  lines.push(`display_name: ${oneLine(agent.displayName)}`);
  lines.push(`description: ${oneLine(agent.description)}`);
  lines.push(`runtime: ${agent.runtime ?? ""}`);
  if (agent.runtimeFallbacks.length > 0) {
    lines.push("runtime_fallbacks:");
    for (const fallback of agent.runtimeFallbacks) lines.push(`  - ${fallback}`);
  }
  lines.push(`model: ${agent.model}`);
  if (agent.tools.length > 0) {
    lines.push("tools:");
    for (const tool of agent.tools) lines.push(`  - ${tool}`);
  }
  lines.push(`max_turns: ${agent.maxTurns}`);
  lines.push(`visibility: ${agent.visibility}`);
  lines.push(`permission_mode: ${agent.permissionMode}`);
  lines.push(`kind: ${agent.kind}`);
  lines.push(`created_at: ${agent.createdAt}`);
  lines.push(`updated_at: ${agent.updatedAt}`);
  if (agent.archivedAt !== undefined) lines.push(`archived_at: ${agent.archivedAt}`);
  lines.push("---", "");
  return `${lines.join("\n")}${agent.instructions}\n`;
}
