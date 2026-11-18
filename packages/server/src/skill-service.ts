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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";import { createHash, randomBytes } from "node:crypto";
import { SKILL_INDEX_FILE, resolveTeamSkillsDir } from "@fengagent/shared";
import type { SkillMountStore, SkillRevision } from "@fengagent/agent";
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

/** URL 导入用的 fetch 形态（不绑定 Bun 的全局 fetch 类型，便于测试注入） */
export type SkillFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
  /** 挂载层仓（P1：版本快照 / 「被谁使用」）；不传则相关接口降级为空 */
  mounts?: SkillMountStore;
  /** 本地导入允许根（缺省：workdir + 团队目录 + 用户 skills 根） */
  importRoots?: string[];
  /** 运行时 skills 根（runtime_copy 用；缺省见 DEFAULT_RUNTIME_SKILL_ROOTS） */
  runtimeSkillRoots?: Record<string, string | string[]>;
  /** URL 导入域名白名单（缺省 DEFAULT_URL_IMPORT_HOSTS，追加去重） */
  urlHostAllowlist?: string[];
  /** fetch 注入（测试用；缺省全局 fetch） */
  fetchImpl?: SkillFetch;
  /** 时钟注入（测试用） */
  now?: () => number;
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

/** 四种导入方式（P1，spec §5.3.2） */
export type SkillImportType = "manual" | "local" | "url" | "runtime_copy";

/** 重名冲突策略（对齐 Multica） */
export type SkillConflictPolicy = "fail" | "overwrite" | "rename" | "skip";

/** 导入入参（按 type 取用对应字段） */
export interface SkillImportInput {
  type: SkillImportType;
  /** manual：完整技能定义（等价于 POST /api/skills） */
  name?: string;
  description?: string;
  trigger?: string;
  prompt?: string;
  /** local：允许根内的 .md 路径（支持 ~ 展开） */
  path?: string;
  /** url：https 地址（域名白名单 + 重定向二次校验） */
  url?: string;
  /** runtime_copy：运行时名（claude / codex / dsh / agents） */
  runtime?: string;
  /** runtime_copy：该运行时 skills 根下的目录名或文件名 */
  skillName?: string;
  /** 冲突策略；缺省 fail */
  onConflict?: SkillConflictPolicy;
}

/** 来源台账条目（`<teamDir>/skill-sources.json`） */
export interface SkillSourceRecord {
  type: SkillImportType | "edit" | "restore";
  url?: string;
  path?: string;
  runtime?: string;
  sha256: string;
  importedAt: string;
}

/** 导入结果 */
export interface SkillImportResult {
  skill: SkillView;
  /** 本次写入产生的版本（skip 时为 undefined） */
  revision?: Omit<SkillRevision, "content">;
  source: SkillSourceRecord;
  /** rename 策略下实际落的名字 */
  renamedFrom?: string;
  /** skip 策略命中 */
  skipped?: boolean;
}

/** 技能被哪些智能体使用（「被 N 个智能体使用」） */
export interface SkillUsage {
  name: string;
  count: number;
  agents: Array<{ agentId: string; enabled: boolean }>;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 200;
const MAX_TRIGGER = 200;
const MAX_PROMPT_BYTES = 64 * 1024;
/** 导入文件大小上限（spec：local / url 均 1 MiB） */
const MAX_IMPORT_BYTES = 1024 * 1024;
/** URL 导入超时（spec：15s） */
const URL_IMPORT_TIMEOUT_MS = 15_000;
/** 来源台账文件名（与 skills.json 并列，不进 skill 列表） */
export const SKILL_SOURCES_FILE = "skill-sources.json";
/** URL 导入域名白名单（可在选项里追加） */
export const DEFAULT_URL_IMPORT_HOSTS: readonly string[] = [
  "raw.githubusercontent.com",
  "github.com",
  "gist.githubusercontent.com",
  "www.anet.sh",
];

/** 各运行时声明的 skills 根（runtime_copy 只读这些根，spec §5.3.2） */
const DEFAULT_RUNTIME_SKILL_ROOTS: Record<string, string[]> = {
  claude: ["~/.claude/skills"],
  codex: ["$CODEX_HOME/skills", "~/.codex/skills"],
  dsh: ["~/.dsh/skills"],
  agents: ["~/.agents/skills"],
};

/** `~` / `$VAR` 展开（只认 HOME 与调用方环境，避免读进程全局状态） */
function expandPath(input: string, env: Record<string, string | undefined>): string {
  let value = input.trim();
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = env["HOME"] ?? env["USERPROFILE"] ?? "";
    value = home === "" ? value : join(home, value.slice(1));
  }
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name: string) => env[name] ?? "");
}

/** 内容 hash（sha256，版本台账与来源台账共用） */
export function hashSkillContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** target 是否在 root 内（含 root 自身；大小写按平台归一） */
function isInside(root: string, target: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const rel = relative(normalize(root), normalize(target));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

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
  private readonly mounts?: SkillMountStore;
  private readonly importRoots: string[];
  private readonly runtimeSkillRoots: Record<string, string | string[]>;
  private readonly urlHostAllowlist: string[];
  private readonly fetchImpl: SkillFetch;
  private readonly now: () => number;

  constructor(options: SkillServiceOptions) {
    this.workdir = options.workdir;
    this.env = options.env ?? process.env;
    this.home = options.home;
    this.mounts = options.mounts;
    this.importRoots = (options.importRoots ?? []).map((root) => expandPath(root, this.env));
    this.runtimeSkillRoots = options.runtimeSkillRoots ?? DEFAULT_RUNTIME_SKILL_ROOTS;
    this.urlHostAllowlist = [
      ...new Set([...DEFAULT_URL_IMPORT_HOSTS, ...(options.urlHostAllowlist ?? [])]),
    ];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
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
    this.recordRevision(name, renderSkillMarkdown({ name, description, trigger, prompt }), "manual");
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
      this.recordRevision(name, renderSkillMarkdown(next), "edit");
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
        `「${name}」来自 ${apiSource(existing.source)} 层，不能删除；内置/本目录技能请用「恢复默认」或直接删除本目录文件`,
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

  // ── 导入 / 版本 / 使用关系（P1）────────────

  /**
   * 四种导入方式统一入口（spec §5.3.2）。
   *
   * - manual：等价 `create()`；
   * - local：只读允许根内的 `.md`（拒绝符号链接逃逸、>1 MiB）；
   * - url：https + 域名白名单 + 重定向后再校验 + 15s 超时 + ≤1 MiB；
   * - runtime_copy：只读该运行时声明的 skills 根。
   *
   * 写入后统一记 `skill-sources.json` + `skill_revision`（sha256 快照）。
   */
  async importSkill(input: SkillImportInput): Promise<SkillImportResult> {
    const type = input.type;
    if (type === "manual") {
      return this.importManual(input);
    }
    if (type === "local") {
      return this.importLocal(input);
    }
    if (type === "url") {
      return this.importUrl(input);
    }
    if (type === "runtime_copy") {
      return this.importRuntimeCopy(input);
    }
    throw new SkillServiceError(`不支持的导入类型: ${String(type)}`, "bad_request");
  }

  /** 版本列表（新 → 旧） */
  revisions(name: string): Array<Omit<SkillRevision, "content">> {
    this.assertName(name);
    if (!this.mounts) return [];
    return this.mounts.listRevisions(name);
  }

  /** 回滚到指定版本（把快照正文原样写回团队层，并追加一条 restore 版本） */
  restore(name: string, version: number): SkillView {
    this.assertName(name);
    if (!this.mounts) {
      throw new SkillServiceError("版本仓未装配（缺少 SkillMountStore）", "internal");
    }
    if (!Number.isInteger(version) || version <= 0) {
      throw new SkillServiceError("version 必须是正整数", "bad_request");
    }
    const revision = this.mounts.getRevision(name, version);
    if (!revision) {
      throw new SkillServiceError(`版本不存在: ${name}@${version}`, "not_found");
    }
    const { frontmatter, body } = parseFrontmatter(revision.content);
    const parsedName = frontmatter["name"] ?? name;
    if (parsedName !== name) {
      throw new SkillServiceError(
        `版本 ${version} 的 name=${parsedName} 与目标 ${name} 不一致，拒绝回滚`,
        "conflict",
      );
    }
    this.assertDescription(frontmatter["description"] ?? "");
    this.assertPrompt(body);
    this.writeRaw(name, revision.content);
    this.setDisabled(name, false);
    this.mounts.recordRevision({
      skillName: name,
      content: revision.content,
      contentHash: revision.contentHash,
      source: "restore",
    });
    this.recordSource(name, {
      type: "restore",
      sha256: revision.contentHash,
      importedAt: new Date(this.now()).toISOString(),
    });
    return this.detail(name) as SkillView;
  }

  /** 「被哪些智能体使用」；未装配挂载仓时降级为空 */
  usage(name: string): SkillUsage {
    this.assertName(name);
    const agents = this.mounts?.agentsUsing(name) ?? [];
    return { name, count: agents.length, agents };
  }

  /** 来源台账（失败/不存在时返回空表，不让坏文件拖垮导入） */
  sources(): Record<string, SkillSourceRecord> {
    const file = join(this.teamDir, SKILL_SOURCES_FILE);
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        sources?: Record<string, SkillSourceRecord>;
      };
      return parsed.sources ?? {};
    } catch {
      return {};
    }
  }

  /** manual 导入：走既有 create，但把冲突策略也算进去 */
  private importManual(input: SkillImportInput): SkillImportResult {
    const name = String(input.name ?? "").trim();
    this.assertName(name);
    const body: SkillCreateInput = {
      name,
      description: String(input.description ?? "").trim(),
      trigger: String(input.trigger ?? "").trim(),
      prompt: String(input.prompt ?? "").trim(),
    };
    const policy = this.normalizePolicy(input.onConflict);
    const exists = existsSync(this.fileOf(name));
    if (exists && policy === "skip") {
      return {
        skill: this.detail(name) as SkillView,
        source: this.sources()[name] ?? this.manualSource(name),
        skipped: true,
      };
    }
    if (exists && policy === "fail") {
      throw new SkillServiceError(`团队技能已存在: ${name}`, "conflict");
    }
    const finalName = exists && policy === "rename" ? this.freeName(name) : name;
    const skill =
      exists && policy === "overwrite"
        ? this.update(name, { description: body.description, trigger: body.trigger, prompt: body.prompt })
        : this.create({ ...body, name: finalName });
    const revision = this.latestRevision(finalName);
    const source = this.manualSource(finalName);
    this.recordSource(finalName, source);
    return {
      skill,
      ...(revision ? { revision } : {}),
      source,
      ...(finalName !== name ? { renamedFrom: name } : {}),
    };
  }

  /** local 导入：允许根 + realpath 校验（拒绝符号链接逃逸） */
  private importLocal(input: SkillImportInput): SkillImportResult {
    const rawPath = String(input.path ?? "").trim();
    if (rawPath === "") throw new SkillServiceError("local 导入需要 path", "bad_request");
    const absolute = resolve(expandPath(rawPath, this.env));
    this.assertInsideImportRoots(absolute);

    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      throw new SkillServiceError(`文件不存在: ${rawPath}`, "not_found");
    }
    // 符号链接可能指向根外：realpath 之后再校验一次
    this.assertInsideImportRoots(real);
    const stat = statSync(real);
    if (!stat.isFile()) throw new SkillServiceError(`不是文件: ${rawPath}`, "bad_request");
    if (stat.size > MAX_IMPORT_BYTES) {
      throw new SkillServiceError(`文件超过 ${MAX_IMPORT_BYTES / 1024}KB 上限`, "bad_request");
    }
    const content = readFileSync(real, "utf-8");
    const parsed = this.parseImportedSkill(content, rawPath);
    return this.finishImport(parsed, {
      type: "local",
      path: real,
      sha256: hashSkillContent(content),
      importedAt: new Date(this.now()).toISOString(),
    }, input.onConflict, content);
  }

  /** URL 导入：https + 白名单 + 重定向二次校验 + 超时/大小上限 */
  private async importUrl(input: SkillImportInput): Promise<SkillImportResult> {
    const rawUrl = String(input.url ?? "").trim();
    if (rawUrl === "") throw new SkillServiceError("url 导入需要 url", "bad_request");
    const parsedUrl = this.parseAllowedUrl(rawUrl);

    let response: Response;
    try {
      response = await this.fetchImpl(parsedUrl.toString(), {
        redirect: "follow",
        signal: AbortSignal.timeout(URL_IMPORT_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SkillServiceError(`URL 读取失败: ${message}`, "internal");
    }
    if (!response.ok) {
      throw new SkillServiceError(`URL 返回 ${response.status}: ${rawUrl}`, "internal");
    }
    // 跟随重定向后，最终地址必须仍是 https + 白名单 host（SSRF 兜底）
    const finalUrl = response.url === "" ? parsedUrl.toString() : response.url;
    this.parseAllowedUrl(finalUrl);

    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
      throw new SkillServiceError(`文件超过 ${MAX_IMPORT_BYTES / 1024}KB 上限`, "bad_request");
    }
    const content = await response.text();
    if (Buffer.byteLength(content, "utf-8") > MAX_IMPORT_BYTES) {
      throw new SkillServiceError(`文件超过 ${MAX_IMPORT_BYTES / 1024}KB 上限`, "bad_request");
    }
    const parsed = this.parseImportedSkill(content, finalUrl);
    return this.finishImport(
      parsed,
      {
        type: "url",
        url: finalUrl,
        sha256: hashSkillContent(content),
        importedAt: new Date(this.now()).toISOString(),
      },
      input.onConflict,
      content,
    );
  }

  /** runtime_copy 导入：只读该运行时声明的 skills 根 */
  private importRuntimeCopy(input: SkillImportInput): SkillImportResult {
    const runtime = String(input.runtime ?? "").trim();
    if (runtime === "") throw new SkillServiceError("runtime_copy 需要 runtime", "bad_request");
    const wanted = String(input.skillName ?? input.name ?? "").trim();
    if (wanted === "") {
      throw new SkillServiceError("runtime_copy 需要 skillName", "bad_request");
    }
    if (wanted.includes("..") || wanted.includes("/") || wanted.includes("\\")) {
      throw new SkillServiceError("skillName 不允许包含路径分隔符", "bad_request");
    }
    const roots = this.runtimeRootsFor(runtime);
    if (roots.length === 0) {
      throw new SkillServiceError(
        `运行时 ${runtime} 未声明 skills 根（可用: ${Object.keys(this.runtimeSkillRoots).join(" / ")}）`,
        "bad_request",
      );
    }
    let file: string | undefined;
    for (const root of roots) {
      const candidates = [join(root, wanted, "SKILL.md"), join(root, `${wanted}.md`)];
      file = candidates.find((candidate) => existsSync(candidate));
      if (file) break;
    }
    if (!file) {
      throw new SkillServiceError(
        `运行时 ${runtime} 的 skills 根里找不到 ${wanted}（已查 ${roots.join("、")}）`,
        "not_found",
      );
    }
    const stat = statSync(file);
    if (stat.size > MAX_IMPORT_BYTES) {
      throw new SkillServiceError(`文件超过 ${MAX_IMPORT_BYTES / 1024}KB 上限`, "bad_request");
    }
    const content = readFileSync(file, "utf-8");
    const parsed = this.parseImportedSkill(content, file);
    return this.finishImport(
      parsed,
      {
        type: "runtime_copy",
        runtime,
        path: file,
        sha256: hashSkillContent(content),
        importedAt: new Date(this.now()).toISOString(),
      },
      input.onConflict,
      content,
    );
  }

  /** 校验 + 按冲突策略落盘 + 记来源/版本（三种文件型导入共用） */
  private finishImport(
    parsed: { name: string; description: string; trigger: string; content: string },
    source: SkillSourceRecord,
    onConflict: SkillConflictPolicy | undefined,
    content: string,
  ): SkillImportResult {
    const policy = this.normalizePolicy(onConflict);
    const originalName = parsed.name;
    const exists = existsSync(this.fileOf(originalName));
    if (exists && policy === "skip") {
      return {
        skill: this.detail(originalName) as SkillView,
        source: this.sources()[originalName] ?? source,
        skipped: true,
      };
    }
    if (exists && policy === "fail") {
      throw new SkillServiceError(`团队技能已存在: ${originalName}`, "conflict");
    }

    const name = exists && policy === "rename" ? this.freeName(originalName) : originalName;
    const finalContent =
      name === originalName ? content : this.renameFrontmatter(content, originalName, name);
    this.writeRaw(name, finalContent);
    this.setDisabled(name, false);
    const hash = hashSkillContent(finalContent);
    const revision = this.recordRevision(name, finalContent, source.type);
    this.recordSource(name, { ...source, sha256: hash });
    return {
      skill: this.detail(name) as SkillView,
      ...(revision ? { revision } : {}),
      source: { ...source, sha256: hash },
      ...(name !== originalName ? { renamedFrom: originalName } : {}),
    };
  }

  /** 解析导入内容：必须是 markdown + frontmatter（name/description 必填） */
  private parseImportedSkill(
    content: string,
    origin: string,
  ): { name: string; description: string; trigger: string; content: string } {
    if (content.trim() === "") {
      throw new SkillServiceError(`导入内容为空: ${origin}`, "bad_request");
    }
    const { frontmatter, body } = parseFrontmatter(content);
    const name = String(frontmatter["name"] ?? "").trim();
    if (name === "") {
      throw new SkillServiceError("导入内容缺少 frontmatter name", "bad_request");
    }
    this.assertName(name);
    const description = String(frontmatter["description"] ?? "").trim();
    this.assertDescription(description);
    const trigger = String(frontmatter["trigger"] ?? "").trim();
    this.assertTrigger(trigger);
    this.assertPrompt(body);
    return { name, description, trigger, content };
  }

  /** URL 安全校验：https + 精确 host 白名单 */
  private parseAllowedUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SkillServiceError(`不是合法 URL: ${raw}`, "bad_request");
    }
    if (url.protocol !== "https:") {
      throw new SkillServiceError("只允许 https:// 导入", "bad_request");
    }
    if (!this.urlHostAllowlist.includes(url.hostname)) {
      throw new SkillServiceError(
        `域名不在白名单: ${url.hostname}（允许: ${this.urlHostAllowlist.join(" / ")}）`,
        "bad_request",
      );
    }
    return url;
  }

  /** 允许根校验（workdir / 团队目录 / 用户 skills 根 / 显式注入） */
  private assertInsideImportRoots(target: string): void {
    const roots = this.allowedImportRoots();
    const realRoots = roots.map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return resolve(root);
      }
    });
    const resolved = resolve(target);
    const inside = realRoots.some((root) => isInside(root, resolved));
    if (!inside) {
      throw new SkillServiceError(
        `路径不在允许的导入根内: ${target}（允许: ${realRoots.join("、")}）`,
        "bad_request",
      );
    }
  }

  private allowedImportRoots(): string[] {
    const roots = [
      this.workdir,
      this.teamDir,
      ...this.importRoots,
      ...this.userSkillRoots(),
    ];
    return [...new Set(roots.map((root) => resolve(expandPath(root, this.env))))];
  }

  /** 用户级 skills 根（本地导入的常见来源） */
  private userSkillRoots(): string[] {
    const home = this.home ?? this.env["HOME"] ?? this.env["USERPROFILE"] ?? "";
    if (home === "") return [];
    return [join(home, ".fengagent", "skills"), join(home, ".claude", "skills"), join(home, ".agents", "skills")];
  }

  private runtimeRootsFor(runtime: string): string[] {
    const raw = this.runtimeSkillRoots[runtime] ?? [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((root) => resolve(expandPath(root, this.env))).filter((root) => root !== "");
  }

  private normalizePolicy(policy: SkillConflictPolicy | undefined): SkillConflictPolicy {
    if (policy === undefined) return "fail";
    if (policy === "fail" || policy === "overwrite" || policy === "rename" || policy === "skip") {
      return policy;
    }
    throw new SkillServiceError(`不支持的 onConflict: ${String(policy)}`, "bad_request");
  }

  /** rename：`name` → `name-2` / `name-3`（上限 100，避免死循环） */
  private freeName(name: string): string {
    for (let index = 2; index <= 100; index += 1) {
      const candidate = `${name}-${index}`;
      if (!existsSync(this.fileOf(candidate))) return candidate;
    }
    throw new SkillServiceError(`无法为 ${name} 找到可用名称`, "conflict");
  }

  /** 改 frontmatter 的 name 行（rename 用；正文原样保留） */
  private renameFrontmatter(content: string, from: string, to: string): string {
    const pattern = new RegExp(`^(---\\s*\\n[\\s\\S]*?\\nname:\\s*)${from.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(\\s*\\n)`, "m");
    if (pattern.test(content)) return content.replace(pattern, `$1${to}$2`);
    return renderSkillMarkdown({
      name: to,
      description: parseFrontmatter(content).frontmatter["description"] ?? "",
      trigger: parseFrontmatter(content).frontmatter["trigger"] ?? "",
      prompt: parseFrontmatter(content).body,
    });
  }

  /** 原样写团队层（导入/回滚保留来源字节；临时文件 + rename） */
  private writeRaw(name: string, content: string): void {
    this.assertName(name);
    if (!existsSync(this.teamDir)) mkdirSync(this.teamDir, { recursive: true });
    const file = this.fileOf(name);
    const tmp = join(this.teamDir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, file);
  }

  /** 记一条版本快照（未装配版本仓时静默跳过） */
  private recordRevision(
    name: string,
    content: string,
    source: string,
  ): Omit<SkillRevision, "content"> | undefined {
    if (!this.mounts) return undefined;
    const revision = this.mounts.recordRevision({
      skillName: name,
      content,
      contentHash: hashSkillContent(content),
      source,
    });
    return {
      skillName: revision.skillName,
      version: revision.version,
      contentHash: revision.contentHash,
      source: revision.source,
      createdAt: revision.createdAt,
    };
  }

  private latestRevision(name: string): Omit<SkillRevision, "content"> | undefined {
    if (!this.mounts) return undefined;
    const revision = this.mounts.latestRevision(name);
    if (!revision) return undefined;
    return {
      skillName: revision.skillName,
      version: revision.version,
      contentHash: revision.contentHash,
      source: revision.source,
      createdAt: revision.createdAt,
    };
  }

  /** 记来源台账（原子写；坏文件覆盖重建） */
  private recordSource(name: string, record: SkillSourceRecord): void {
    const all = this.sources();
    all[name] = record;
    if (!existsSync(this.teamDir)) mkdirSync(this.teamDir, { recursive: true });
    const file = join(this.teamDir, SKILL_SOURCES_FILE);
    const tmp = join(this.teamDir, `.${SKILL_SOURCES_FILE}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ version: 1, sources: all }, null, 2)}\n`, "utf-8");
    renameSync(tmp, file);
  }

  private manualSource(name: string): SkillSourceRecord {
    const skill = this.detail(name);
    return {
      type: "manual",
      sha256: hashSkillContent(
        renderSkillMarkdown({
          name,
          description: skill.description,
          trigger: skill.trigger,
          prompt: skill.prompt,
        }),
      ),
      importedAt: new Date(this.now()).toISOString(),
    };
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
