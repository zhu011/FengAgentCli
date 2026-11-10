/**
 * @fengagent/server — 团队级技能库服务（P0）
 *
 * 团队级 skill 的唯一写侧：把 `.md` 落到**团队数据根** `<teamRoot>/skills`
 * （默认 `~/.fengagent-cordis/skills`，`FENG_TEAM_HOME` 可覆盖），并维护停用索引
 * `<teamRoot>/skills/skills.json`（`{ version: 1, disabled: string[] }`）。
 *
 * 读侧不在这里重写一遍合并逻辑 —— 直接复用 `@fengagent/tools` 的 loader
 * （内置 → team → project 三层合并、mtime 失效、停用过滤），保证「UI 看到的」
 * 与「skill 工具 / `/skill` 看到的」是同一套结果。
 *
 * 写入语义（与 UI 交互一一对应）：
 * - 新建：团队层重名 409；
 * - 编辑：团队层有文件就改它；只有内置/本目录同名项时 → **在团队层创建同名覆盖**；
 * - 删除：只删团队层文件；目标是内置/本目录 → 409（提示用「恢复默认」）；
 * - 恢复默认：删团队层文件 + 清掉停用名单里的同名项；
 * - 停用：写索引，对内置层同样生效（停用后 agent 侧不可见）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SKILL_INDEX_FILE, resolveTeamSkillsDir } from "@fengagent/shared";
import {
  createSkillLoader,
  type SkillDefinition,
  type SkillLoadError,
  type SkillSource,
} from "@fengagent/tools/builtin/skill";

/** 错误码（与 runtimes / mcp-groups 一致，供前端按 code 分支） */
export type SkillErrorCode = "bad_request" | "not_found" | "conflict" | "not_editable" | "internal";

/** 技能库业务错误 */
export class SkillServiceError extends Error {
  readonly code: SkillErrorCode;

  constructor(message: string, code: SkillErrorCode) {
    super(message);
    this.name = "SkillServiceError";
    this.code = code;
  }
}

/** 技能库服务选项 */
export interface SkillServiceOptions {
  /** 工作目录（决定 project 层） */
  workdir: string;
  /** 团队技能目录（缺省按 FENG_TEAM_HOME / home 解析；测试注入） */
  teamDir?: string;
  /** 环境变量（默认 process.env；测试注入） */
  env?: Record<string, string | undefined>;
  /** home（测试注入） */
  home?: string;
}

/** 管理面看到的技能条目（list / layers 共用） */
export interface SkillView {
  name: string;
  description: string;
  trigger: string;
  /**
   * 来源层（对外契约）：`builtin` 内置 / `team` 团队级 / `workdir` 本目录。
   * 内部 loader 把「本目录」叫 `project`，对前端统一叫 `workdir`（与 KG 的 UI 契约一致）。
   */
  source: SkillApiSource;
  enabled: boolean;
  /** 是否可在 UI 里编辑（只有团队层可写；内置/本目录 走「同名覆盖」） */
  editable: boolean;
  path?: string;
  /** 被哪个更高优先级层覆盖（逐层明细里用） */
  overriddenBy?: SkillApiSource;
  /** 当前条目覆盖了哪些低优先级层（合并视图里用） */
  shadowed: Array<{ source: SkillApiSource; path?: string }>;
  bytes?: number;
  updatedAt?: string;
  /**
   * prompt 正文。列表也带上：UI「编辑」可直接回填，不必再单独取详情
   * （契约里该字段本就可选，列表带上属于向后兼容的超集）。
   */
  prompt?: string;
}

/** 对外来源枚举（内部 project → 对外 workdir） */
export type SkillApiSource = "builtin" | "team" | "workdir";

/** 技能库列表响应 */
export interface SkillListView {
  roots: { team: string; project: string[] };
  /** 合并视图（每个名字一条胜出项，含已停用项 enabled=false） */
  skills: SkillView[];
  /** 逐层明细（含被覆盖的条目，带 overriddenBy） */
  layers: SkillView[];
  errors: SkillLoadError[];
}

/** 新建技能入参 */
export interface SkillCreateInput {
  name: string;
  description: string;
  trigger?: string;
  prompt: string;
}

/** 编辑技能入参（名称锁定） */
export interface SkillUpdateInput {
  description?: string;
  trigger?: string;
  prompt?: string;
  enabled?: boolean;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 200;
const MAX_TRIGGER = 200;
const MAX_PROMPT_BYTES = 64 * 1024;

/** 单行化 frontmatter 值（多行会破坏 `key: value` 结构） */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/** 拼装 .md 正文（与现有 `.fengagent/skills/*.md` 完全同构） */
export function renderSkillMarkdown(input: SkillCreateInput): string {
  const lines = ["---", `name: ${oneLine(input.name)}`, `description: ${oneLine(input.description)}`];
  if (input.trigger && input.trigger.trim() !== "") {
    lines.push(`trigger: ${oneLine(input.trigger)}`);
  }
  lines.push("---", "", input.prompt.trim(), "");
  return lines.join("\n");
}

/** 解析 .md 的 frontmatter（与 loader 同口径的最小实现，仅用于读团队层原值） */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = (kv[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]!] = value;
  }
  return { frontmatter, body: (match[2] ?? "").trim() };
}

/** 内部层名 → 对外来源（project 对前端叫 workdir） */
function apiSource(source: SkillSource): SkillApiSource {
  return source === "project" ? "workdir" : source;
}

/**
 * 团队级技能库服务。
 *
 * 所有方法同步（技能就是几个小文件，同步实现让路由与测试都简单）。
 */
export class SkillService {
  private readonly workdir: string;
  private readonly teamDir: string;
  private readonly env: Record<string, string | undefined>;
  private readonly home?: string;

  constructor(options: SkillServiceOptions) {
    this.workdir = options.workdir;
    this.env = options.env ?? process.env;
    this.home = options.home;
    this.teamDir =
      options.teamDir ??
      resolveTeamSkillsDir({
        env: this.env,
        ...(options.home ? { home: options.home } : {}),
      });
  }

  /** 团队技能目录（写侧根） */
  get teamSkillsDir(): string {
    return this.teamDir;
  }

  /** 每次调用新建 loader：写后立刻读得到，不依赖缓存失效时机 */
  private loader() {
    const loader = createSkillLoader({
      workdir: this.workdir,
      teamDir: this.teamDir,
      env: this.env,
      ...(this.home ? { home: this.home } : {}),
    });
    loader.loadSync();
    return loader;
  }

  private toView(skill: SkillDefinition & { overriddenBy?: SkillSource }): SkillView {
    return {
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      source: apiSource(skill.source),
      enabled: skill.enabled,
      editable: skill.source === "team",
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.overriddenBy ? { overriddenBy: apiSource(skill.overriddenBy) } : {}),
      shadowed: skill.shadowed.map((s) => ({
        source: apiSource(s.source),
        ...(s.path ? { path: s.path } : {}),
      })),
      ...(skill.bytes !== undefined ? { bytes: skill.bytes } : {}),
      ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}),
      prompt: skill.prompt,
    };
  }

  /** 列表（merge=true 时返回三层合并视图 + 逐层明细；否则只回团队层） */
  list(options: { merge?: boolean } = {}): SkillListView {
    const loader = this.loader();
    const roots = loader.roots();
    if (options.merge === false) {
      return {
        roots,
        skills: loader.all().filter((s) => s.source === "team").map((s) => this.toView(s)),
        layers: [],
        errors: loader.errors(),
      };
    }
    return {
      roots,
      skills: loader.all().map((s) => this.toView(s)),
      layers: loader.layers().map((s) => this.toView(s)),
      errors: loader.errors(),
    };
  }

  /** 详情（含 prompt 正文；已停用也返回，管理面要看） */
  detail(name: string): SkillView & { prompt: string } {
    const loader = this.loader();
    const skill = loader.all().find((s) => s.name === name);
    if (!skill) throw new SkillServiceError(`技能不存在: ${name}`, "not_found");
    return { ...this.toView(skill), prompt: skill.prompt };
  }

  /** 新建团队技能（团队层重名 409；内置/本目录同名允许建覆盖） */
  create(input: SkillCreateInput): SkillView {
    const name = String(input.name ?? "").trim();
    this.assertName(name);
    const description = String(input.description ?? "").trim();
    this.assertDescription(description);
    const trigger = String(input.trigger ?? "").trim();
    this.assertTrigger(trigger);
    const prompt = String(input.prompt ?? "").trim();
    this.assertPrompt(prompt);

    if (existsSync(this.fileOf(name))) {
      throw new SkillServiceError(`团队技能已存在: ${name}`, "conflict");
    }

    this.writeSkill({ name, description, trigger, prompt });
    // 新建同名覆盖时顺手解除停用，否则「加了却看不到」
    this.setDisabled(name, false);
    return this.detail(name) as SkillView;
  }

  /** 编辑：先改团队层文件（无则建同名覆盖），再按需改停用状态 */
  update(name: string, patch: SkillUpdateInput): SkillView {
    const loader = this.loader();
    const existing = loader.all().find((s) => s.name === name);
    const teamFile = this.fileOf(name);
    const hasTeamFile = existsSync(teamFile);

    const touchesContent =
      patch.description !== undefined || patch.trigger !== undefined || patch.prompt !== undefined;

    if (touchesContent) {
      if (!existing) throw new SkillServiceError(`技能不存在: ${name}`, "not_found");
      const base = hasTeamFile ? this.readTeamSkill(name) : existing;
      const next: SkillCreateInput = {
        name,
        description: patch.description !== undefined ? String(patch.description).trim() : base.description,
        trigger: patch.trigger !== undefined ? String(patch.trigger).trim() : base.trigger,
        prompt: patch.prompt !== undefined ? String(patch.prompt) : base.prompt,
      };
      this.assertDescription(next.description);
      this.assertTrigger(next.trigger ?? "");
      this.assertPrompt(next.prompt);
      this.writeSkill(next);
      if (patch.enabled === undefined) this.setDisabled(name, false);
    } else if (!existing && !hasTeamFile) {
      throw new SkillServiceError(`技能不存在: ${name}`, "not_found");
    }

    if (patch.enabled !== undefined) {
      if (!existing && !hasTeamFile) throw new SkillServiceError(`技能不存在: ${name}`, "not_found");
      this.setDisabled(name, patch.enabled === false);
    }

    return this.detail(name) as SkillView;
  }

  /** 删除团队技能（内置/本目录 409，提示用「恢复默认」） */
  remove(name: string): void {
    this.assertName(name);
    const file = this.fileOf(name);
    if (!existsSync(file)) {
      const existing = this.loader().all().find((s) => s.name === name);
      if (!existing) throw new SkillServiceError(`技能不存在: ${name}`, "not_found");
      throw new SkillServiceError(
        `「${name}」来自 ${existing.source} 层，不能删除；内置/本目录技能请用「恢复默认」或直接删除本目录文件`,
        "not_editable",
      );
    }
    rmSync(file, { force: true });
    this.setDisabled(name, false);
  }

  /** 恢复默认：移除团队层覆盖 + 解除停用（内置技能回到内置定义） */
  reset(name: string): SkillView {
    this.assertName(name);
    const file = this.fileOf(name);
    const removedFile = existsSync(file);
    if (removedFile) rmSync(file, { force: true });
    const removedDisable = this.setDisabled(name, false);
    const existing = this.loader().all().find((s) => s.name === name);
    if (!existing) {
      if (!removedFile && !removedDisable) {
        throw new SkillServiceError(`技能不存在: ${name}`, "not_found");
      }
      throw new SkillServiceError(`「${name}」已无任何定义可恢复`, "not_found");
    }
    return this.toView(existing as SkillDefinition & { overriddenBy?: SkillSource });
  }

  // ── 校验 ────────────────────────────────────

  private assertName(name: string): void {
    if (name === "") throw new SkillServiceError("name 必填", "bad_request");
    if (!NAME_PATTERN.test(name)) {
      throw new SkillServiceError(
        `name 必须是小写 kebab-case（^[a-z0-9]+(-[a-z0-9]+)*$）: ${name}`,
        "bad_request",
      );
    }
    if (name.includes("..") || name.includes("/") || name.includes("\\")) {
      throw new SkillServiceError("name 不允许包含路径分隔符", "bad_request");
    }
  }

  private assertDescription(description: string): void {
    if (description === "") throw new SkillServiceError("description 必填", "bad_request");
    if (description.length > MAX_DESCRIPTION) {
      throw new SkillServiceError(`description 超长（>${MAX_DESCRIPTION} 字）`, "bad_request");
    }
  }

  private assertTrigger(trigger: string): void {
    if (trigger.length > MAX_TRIGGER) {
      throw new SkillServiceError(`trigger 超长（>${MAX_TRIGGER} 字）`, "bad_request");
    }
  }

  private assertPrompt(prompt: string): void {
    if (prompt === "") throw new SkillServiceError("prompt 必填", "bad_request");
    if (Buffer.byteLength(prompt, "utf-8") > MAX_PROMPT_BYTES) {
      throw new SkillServiceError(`prompt 超长（>${MAX_PROMPT_BYTES / 1024}KB）`, "bad_request");
    }
  }

  // ── 落盘 ────────────────────────────────────

  private fileOf(name: string): string {
    return join(this.teamDir, `${name}.md`);
  }

  /** 读团队层原始定义（编辑内置覆盖时以它为 base） */
  private readTeamSkill(name: string): SkillCreateInput {
    const raw = readFileSync(this.fileOf(name), "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      name,
      description: frontmatter["description"] ?? "",
      trigger: frontmatter["trigger"] ?? "",
      prompt: body,
    };
  }

  /** 原子写团队技能（临时文件 + rename，避免半截文件被 loader 读到） */
  private writeSkill(input: SkillCreateInput): void {
    if (!existsSync(this.teamDir)) mkdirSync(this.teamDir, { recursive: true });
    const file = this.fileOf(input.name);
    const tmp = join(this.teamDir, `.${input.name}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, renderSkillMarkdown(input), "utf-8");
    renameSync(tmp, file);
  }

  /** 读停用索引（损坏时视为空并重建，不让坏文件卡死整个库） */
  private readIndex(): { version: number; disabled: string[] } {
    const file = join(this.teamDir, SKILL_INDEX_FILE);
    if (!existsSync(file)) return { version: 1, disabled: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        version?: unknown;
        disabled?: unknown;
      };
      const disabled = Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((v): v is string => typeof v === "string")
        : [];
      return { version: 1, disabled };
    } catch {
      return { version: 1, disabled: [] };
    }
  }

  /** 原子写停用索引 */
  private writeIndex(index: { version: number; disabled: string[] }): void {
    if (!existsSync(this.teamDir)) mkdirSync(this.teamDir, { recursive: true });
    const file = join(this.teamDir, SKILL_INDEX_FILE);
    const tmp = join(this.teamDir, `.${SKILL_INDEX_FILE}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
    renameSync(tmp, file);
  }

  /** 设置某技能的停用状态；返回是否真的改动了索引 */
  private setDisabled(name: string, disabled: boolean): boolean {
    const index = this.readIndex();
    const has = index.disabled.includes(name);
    if (disabled && has) return false;
    if (!disabled && !has) return false;
    index.disabled = disabled ? [...index.disabled, name] : index.disabled.filter((n) => n !== name);
    index.disabled.sort();
    this.writeIndex(index);
    return true;
  }
}

/** 便捷：按 dataRoot/workdir 建服务（route 层用） */
export function createSkillService(options: SkillServiceOptions): SkillService {
  return new SkillService(options);
}

/** 团队技能目录当前是否存在（route 层给前端「首次使用」提示用） */
export function teamSkillsDirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
