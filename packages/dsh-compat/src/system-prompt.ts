/**
 * @fengagent/dsh-compat — `ctx.systemPrompt` 服务面（P3 收尾 / trivial-shim）
 *
 * dsh 的 `SystemPrompt`（`@deepseek-ai/dsh-system-prompt`，0.1.5+ 才有
 * `getSectionOrder`，本实现按 0.2.1 面写）是一个**有序注册表**：插件往里登记
 * 「段落 / 运行时上下文 / 工具 schema / 插值变量」，每回合装配时由宿主
 * `assemble()` 求值并 `renderPrompt()` 渲染。
 *
 * 兼容层只承诺**注册面 + 装配面**（这正是 `better-edit`、`dsh-persona`、
 * `dsh-tool-fs` 这类插件 inject 它的用途）：
 *
 * - `section(spec)` / `context(spec)` / `variable(name, fn)` / `tools(fn)` 返回
 *   精确 disposer，按 `order` 升序、同序按 name 的 code-unit 升序装配；
 * - `getSectionOrder(name)` / `getContextOrder(name)` 返回 dsh 中心分配的槽位
 *   （表与上游逐项一致，未知名字抛错——上游也是抛错，插件的 `try/catch` 依赖这点）；
 * - `assemble()` → `{ sections, contexts, tools, variables }`，`renderPrompt()` /
 *   `renderContextSnapshot()` 按上游口径做 `{{variable}}` 严格插值。
 *
 * 已知偏差（写进 `docs/DSH-CONTRACT-MAP.md` §10）：
 * 1. **没有按 scope 分层**：上游 `section()` 注册在「调用者所在的 scope」，同名
 *    段落按层遮蔽；本实现拿不到调用者 ctx（`ctx.reflect.provide` 只挂一个实例），
 *    因此所有注册落在同一层，同名按**引用计数覆盖**处理——后注册者赢，
 *    最后一个 disposer 才移除。多 agent 同时装 `better-edit` 时因此不会互相抛
 *    「重复段落」，代价是「每 agent 各一份文案」退化成「最后安装者一份」。
 * 2. **`complete` 段落**：只保留最后一个 `complete: true` 的段落（上游多于一个
 *    即装配失败）；这里更宽松，避免把宿主整个提示词打挂。
 * 3. 段落 `text` 支持函数形式（每次装配求值）；`interpolate: false` 原样保留。
 */

/** 段落槽位表（与 `@deepseek-ai/dsh-system-prompt@0.2.1` 的 `SECTION_ORDERS` 一致） */
export const SECTION_ORDERS = Object.freeze({
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOL_COMPUTER_USE: 3000,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900,
  HARNESS_SOURCE: 10000,
  WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const);

/** 运行时上下文槽位表（与上游 `CONTEXT_ORDERS` 一致） */
export const CONTEXT_ORDERS = Object.freeze({
  WORKING_DIRECTORY: 100,
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
  TEAM_IDENTITY: 125,
  HARNESS_SOURCE: 200,
  WEB_SURFACE: 210,
} as const);

/** 段落槽位名 */
export type PromptSectionOrderName = keyof typeof SECTION_ORDERS;
/** 上下文槽位名 */
export type PromptContextOrderName = keyof typeof CONTEXT_ORDERS;

/** 一次装配的上下文（scope 字段接受但当前不参与分层，见文件头偏差 1） */
export interface AssembleContext {
  scope?: unknown;
  signal?: AbortSignal;
}

/** 一段系统提示词（注册输入） */
export interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;
  readonly complete?: boolean;
}

/** 一段运行时上下文（装配后作为 user 角色快照进历史） */
export interface PromptContext {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;
  readonly required?: boolean;
}

/** 已解析文本的段落 */
export interface AssembledSection {
  name: string;
  text: string;
  interpolate?: boolean;
}

/** 已解析文本的运行时上下文 */
export interface AssembledContext {
  name: string;
  text: string;
  interpolate?: boolean;
}

/** 工具 schema 提供者的一次产出 */
export interface ToolProviderResult {
  readonly schemas: readonly unknown[];
  readonly knownNames?: readonly string[];
}

/** 装配结果（与上游 `PromptAssembly` 同形） */
export interface PromptAssembly {
  sections: AssembledSection[];
  contexts: AssembledContext[];
  tools: unknown[];
  variables: Record<string, string | undefined>;
}

/** 注册项：定义 + 引用计数（同名多 agent 安装时计数，文本取最新） */
interface Registration<T> {
  spec: T;
  count: number;
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * 提示词段落 / 上下文 / 变量注册表。
 *
 * 与上游的差别只有「分层」一项（见文件头）；方法签名与返回的 disposer
 * 形状保持一致，插件按 dsh 写法的调用可以直接工作。
 */
export class SystemPromptCompat {
  private readonly sections = new Map<string, Registration<PromptSection>>();
  private readonly contexts = new Map<string, Registration<PromptContext>>();
  private readonly variables = new Map<
    string,
    Registration<(context: AssembleContext) => string | undefined>
  >();
  private readonly toolProviders: Array<{
    provider: (context: AssembleContext) => ToolProviderResult;
    active: boolean;
  }> = [];
  private readonly changeListeners = new Set<() => void>();
  private runtimeContextSuppressed = 0;

  /**
   * 注册一段系统提示词。
   *
   * @param section - 段落定义（name 唯一；order 必须有限）
   * @returns 精确的注销函数（引用计数归零时移除）
   */
  section(section: PromptSection): () => void {
    this.validateSection(section);
    const existing = this.sections.get(section.name);
    if (existing) {
      // 同名再注册：引用计数 +1，文本换成最新一份（多 agent 安装各自的文案时
      // 「最后安装者赢」，见文件头偏差 1）
      existing.spec = section;
      existing.count += 1;
      this.notifyChange();
      return this.refCountDisposer(this.sections, section.name);
    }
    this.sections.set(section.name, { spec: section, count: 1 });
    this.notifyChange();
    return this.refCountDisposer(this.sections, section.name);
  }

  /**
   * 解析中心分配的段落槽位。
   *
   * @param name - 槽位名
   * @returns 该槽位的排序值
   * @throws 未知槽位名（与上游一致，插件的 `catch` 依赖这个行为）
   */
  getSectionOrder(name: PromptSectionOrderName): number {
    if (!(name in SECTION_ORDERS)) {
      throw new Error(`dsh-compat/systemPrompt: unknown section order "${String(name)}"`);
    }
    return SECTION_ORDERS[name];
  }

  /**
   * 解析中心分配的上下文槽位。
   *
   * @param name - 槽位名
   * @returns 该槽位的排序值
   * @throws 未知槽位名
   */
  getContextOrder(name: PromptContextOrderName): number {
    if (!(name in CONTEXT_ORDERS)) {
      throw new Error(`dsh-compat/systemPrompt: unknown context order "${String(name)}"`);
    }
    return CONTEXT_ORDERS[name];
  }

  /**
   * 注册一段运行时上下文。
   *
   * @param context - 上下文定义
   * @returns 精确的注销函数
   */
  context(context: PromptContext): () => void {
    this.validateContext(context);
    const existing = this.contexts.get(context.name);
    if (existing) {
      existing.count += 1;
      this.notifyChange();
      return this.refCountDisposer(this.contexts, context.name);
    }
    this.contexts.set(context.name, { spec: context, count: 1 });
    this.notifyChange();
    return this.refCountDisposer(this.contexts, context.name);
  }

  /**
   * 临时压制可选运行时上下文（不影响必填项）。
   *
   * @returns 恢复函数
   */
  suppressRuntimeContext(): () => void {
    this.runtimeContextSuppressed += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.runtimeContextSuppressed = Math.max(0, this.runtimeContextSuppressed - 1);
    };
  }

  /**
   * 注册工具 schema 提供者。
   *
   * @param provider - 每次装配求值
   * @returns 精确的注销函数
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    const entry = { provider, active: true };
    this.toolProviders.push(entry);
    return () => {
      entry.active = false;
      const index = this.toolProviders.indexOf(entry);
      if (index >= 0) this.toolProviders.splice(index, 1);
    };
  }

  /**
   * 注册插值变量。
   *
   * @param name - `[a-z][a-z0-9_]*` 的变量名
   * @param provider - 每次装配求值
   * @returns 精确的注销函数
   */
  variable(
    name: string,
    provider: (context: AssembleContext) => string | undefined,
  ): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(
        `dsh-compat/systemPrompt: invalid variable name "${name}" (must match ${VARIABLE_NAME.source})`,
      );
    }
    const existing = this.variables.get(name);
    if (existing) {
      existing.count += 1;
      return this.refCountDisposer(this.variables, name);
    }
    this.variables.set(name, { spec: provider, count: 1 });
    return this.refCountDisposer(this.variables, name);
  }

  /**
   * 重新求值运行时上下文（段落 / 工具 / 变量保持已接受的那次装配）。
   *
   * @param assembly - 已接受的装配
   * @param context - 装配上下文
   * @returns 上下文被刷新后的新装配
   */
  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {
    return { ...assembly, contexts: this.assembleContexts(context) };
  }

  /**
   * 装配全部注册项。
   *
   * @param context - 装配上下文（scope 当前不参与分层）
   * @returns 段落 / 上下文 / 工具 / 变量的快照
   */
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    const sections = [...this.sections.values()]
      .map(({ spec }) => ({
        name: spec.name,
        text: typeof spec.text === "function" ? spec.text(context) : spec.text,
        ...(spec.interpolate === undefined ? {} : { interpolate: spec.interpolate }),
        order: spec.order,
        complete: spec.complete === true,
      }))
      .filter((section) => section.text.length > 0)
      .sort((a, b) => a.order - b.order || compareCodeUnits(a.name, b.name));

    const complete = sections.filter((section) => section.complete);
    const effective = complete.length > 0 ? [complete[complete.length - 1]!] : sections;

    const variables: Record<string, string | undefined> = {};
    for (const [name, registration] of this.variables) {
      variables[name] = registration.spec(context);
    }

    const tools: unknown[] = [];
    for (const entry of [...this.toolProviders]) {
      const result = entry.provider(context);
      tools.push(...result.schemas);
    }

    return {
      sections: effective.map(({ name, text, interpolate }) => ({
        name,
        text,
        ...(interpolate === undefined ? {} : { interpolate }),
      })),
      contexts: this.assembleContexts(context),
      tools,
      variables,
    };
  }

  /** 订阅注册变更（`system-prompt/change` 的本地等价物） */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private assembleContexts(context: AssembleContext): AssembledContext[] {
    return [...this.contexts.values()]
      .map(({ spec }) => ({
        name: spec.name,
        text: typeof spec.text === "function" ? spec.text(context) : spec.text,
        interpolate: spec.interpolate,
        required: spec.required === true,
        order: spec.order,
      }))
      .filter((entry) => entry.text.length > 0 && (entry.required || this.runtimeContextSuppressed === 0))
      .sort((a, b) => a.order - b.order || compareCodeUnits(a.name, b.name))
      .map(({ name, text, interpolate }) => ({
        name,
        text,
        ...(interpolate === undefined ? {} : { interpolate }),
      }));
  }

  private validateSection(section: PromptSection): void {
    if (typeof section?.name !== "string" || section.name.length === 0) {
      throw new Error("dsh-compat/systemPrompt: section.name must be a non-empty string");
    }
    if (!Number.isFinite(section.order)) {
      throw new Error(
        `dsh-compat/systemPrompt: section "${section.name}" order must be a finite number`,
      );
    }
  }

  private validateContext(context: PromptContext): void {
    if (typeof context?.name !== "string" || context.name.length === 0) {
      throw new Error("dsh-compat/systemPrompt: context.name must be a non-empty string");
    }
    if (!Number.isFinite(context.order)) {
      throw new Error(
        `dsh-compat/systemPrompt: context "${context.name}" order must be a finite number`,
      );
    }
  }

  private refCountDisposer<T>(map: Map<string, Registration<T>>, name: string): () => void {
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const entry = map.get(name);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) {
        map.delete(name);
        this.notifyChange();
      }
    };
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // 变更通知不能让注册方失败（与 dsh 的 emit 语义一致）
      }
    }
  }
}

/**
 * 按 `{{variable}}` 严格插值并拼接段落（与上游 `renderPrompt` 同口径）：
 * 空段落丢弃、段落之间空行分隔、未知/未定义变量抛错、`interpolate:false`
 * 的段落原样保留。孤立的 `{{` 视为普通文本。
 *
 * @param assembly - 装配结果
 * @returns 渲染后的系统提示词（全部为空时返回 `""`）
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map((section) =>
      section.interpolate === false
        ? section.text
        : interpolate(section.text, assembly.variables, section.name),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * 渲染运行时上下文快照（与上游 `renderContextSnapshot` 同口径）。
 *
 * @param assembly - 装配结果
 * @returns 快照文本；没有生效上下文时为 `""`
 */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return assembly.contexts
    .map((context) =>
      context.interpolate === false
        ? context.text
        : interpolate(context.text, assembly.variables, context.name),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** `{{name}}` 严格替换：未定义即抛错（上游行为） */
function interpolate(
  text: string,
  variables: Record<string, string | undefined>,
  owner: string,
): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!(name in variables)) {
      throw new Error(
        `dsh-compat/systemPrompt: "${owner}" references unknown variable "{{${name}}}"`,
      );
    }
    const value = variables[name];
    if (value === undefined) {
      throw new Error(
        `dsh-compat/systemPrompt: "${owner}" references undefined variable "{{${name}}}"`,
      );
    }
    return value;
  });
}

/** UTF-16 code unit 比较（默认 `Array#sort` 的字符串比较） */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
