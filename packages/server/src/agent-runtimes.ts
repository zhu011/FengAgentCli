/**
 * @fengagent/server — 外部 agent 运行时注册表
 *
 * 「能把任务派给谁」的事实来源：`<数据根>/runtimes.json`（缺省写一份默认注册表），
 * 每项描述一个本机 agent 二进制怎么拉起来（command + args + env + enabled），
 * 探测结果（agentInfo / 能力 / 可达性）缓存在内存里，可显式刷新。
 *
 * 为什么要有注册表而不是硬编码：`dispatch_task` 的 `agent` 参数、Agents 页的
 * runtime 卡片、探测徽标都从同一份清单来 —— 加一个 runtime 只改 json，不改代码；
 * 页面上「添加 runtime」走的也是这里（`create` / `update` / `remove` / `probeCandidate`）。
 *
 * **失败必须可解释**：注册与探测的每一步都用 {@link RuntimeRegistryError} 带上
 * 机器可读的 `code`（`command_not_found` / `unsupported_protocol` / `spawn_failed` /
 * `credentials_missing` / …），HTTP 侧原样落成 `{error:{message,code}}`，
 * 前端直接把 `message` 显示给人看 —— 不允许「失败但说不清为什么」。
 *
 * 实测方言（同 NDJSON ACP）：`kimi acp`（冷启 ~0.7s）、`dsh-acp acp`（冷启 ~13s）、
 * `fengagent acp`（本仓库自身）。探测超时因此给到 20s。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { createRuntimeDriver } from "@fengagent/agent";
import type { RuntimeProtocol } from "@fengagent/agent";
import { createLogger } from "@fengagent/shared";

const log = createLogger("agent-runtimes");

/** 注册表条目（落盘形状） */
export interface RuntimeEntry {
  /** 注册名（`dispatch_task` 的 agent 参数） */
  name: string;
  /** 可执行文件 */
  command: string;
  /** 参数（ACP 默认 `["acp"]`；claude 由驱动自己拼，留空即可） */
  args?: string[];
  /**
   * 启动协议（默认 `acp`）。
   *
   * - `acp`：NDJSON JSON-RPC，长驻进程（dsh / kimi / fengagent）；
   * - `claude-stream-json`：`claude -p --output-format stream-json`，一次性进程（claude）。
   */
  protocol?: RuntimeProtocol;
  /** 追加环境变量 */
  env?: Record<string, string>;
  /**
   * headless 派发时该 runtime 的权限策略（覆盖服务的默认 `deny`）。
   *
   * 验收/联调需要目标真的写文件时，在 `runtimes.json` 里给这个 runtime 单独配
   * `"permissionPolicy": "allow"`；默认（不配）仍是拒绝并存事件。
   */
  permissionPolicy?: "allow" | "deny";
  /** 是否可被派发（关掉只影响新任务，不动历史） */
  enabled: boolean;
}

/** 探测结果（内存缓存 + 落盘） */
export interface RuntimeProbeResult {
  agentName: string;
  agentVersion: string;
  capabilities: { resume: boolean; loadSession: boolean; image: boolean };
  probedAt: string;
}

/** 对外的 runtime 卡片（与 WebUI `RuntimeInfo` 契约一致） */
export interface RuntimeInfo {
  name: string;
  /** 启动命令（含参数，卡片展示用） */
  command: string;
  /** 纯可执行文件（编辑表单回填用，不含 args；toInfo 总会带） */
  executable?: string;
  /** 启动参数（编辑表单要回填，所以单独给一份而不只给拼好的 command） */
  args?: string[];
  /** 启动协议（`acp` / `claude-stream-json`） */
  protocol?: string;
  /** 追加环境变量（凭据在这里；本机管理面才看得到） */
  env?: Record<string, string>;
  agentName: string;
  agentVersion: string;
  capabilities: { resume: boolean; loadSession: boolean; image: boolean };
  probeStatus: "ok" | "unreachable" | "unprobed";
  probeError?: string;
  /** 探测失败的原因分类（成功时缺省） */
  probeErrorCode?: RuntimeRegistryErrorCode;
  probedAt?: string;
  enabled: boolean;
  recentTaskCount: number;
}

/**
 * 注册/探测失败的原因分类。
 *
 * 这些 code 会原样出现在 HTTP 错误的 `{error:{code}}` 里，前端据此着色/提示，
 * `message` 则直接展示给人看（必须包含可操作的信息，例如缺哪个命令、支持哪些协议）。
 */
export type RuntimeRegistryErrorCode =
  | "bad_request"
  | "conflict"
  | "not_found"
  | "unsupported_protocol"
  | "command_not_found"
  | "spawn_failed"
  | "credentials_missing"
  | "handshake_failed"
  | "probe_timeout"
  | "registry_io";

/** HTTP 状态码（与 code 一一对应，路由直接用它回包） */
const STATUS_BY_CODE: Record<RuntimeRegistryErrorCode, 400 | 404 | 409 | 422 | 500> = {
  bad_request: 400,
  conflict: 409,
  not_found: 404,
  unsupported_protocol: 400,
  command_not_found: 400,
  spawn_failed: 422,
  credentials_missing: 422,
  handshake_failed: 422,
  probe_timeout: 422,
  registry_io: 500,
};

/** 注册表/探测失败（带机器可读 code，路由原样回 `{error:{message,code}}`） */
export class RuntimeRegistryError extends Error {
  readonly code: RuntimeRegistryErrorCode;
  readonly status: 400 | 404 | 409 | 422 | 500;

  constructor(code: RuntimeRegistryErrorCode, message: string, status?: 400 | 404 | 409 | 422 | 500) {
    super(message);
    this.name = "RuntimeRegistryError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
  }

  /** HTTP 错误体（与 mcp-groups 等既有接口同契约） */
  toPayload(): { error: { message: string; code: RuntimeRegistryErrorCode } } {
    return { error: { message: this.message, code: this.code } };
  }
}

/** dispatch 真正实现了的启动协议（新增协议 = 新增客户端 + 加进这个表） */
export const SUPPORTED_PROTOCOLS: readonly RuntimeProtocol[] = ["acp", "claude-stream-json"];

/**
 * 「我们认识、但 dispatch 还没实现」的命令/协议。
 *
 * 存在的意义正是**失败原因**：用户把 opencode 填进来时，直接告诉他
 * 「opencode 走 `run --json`，不是 acp，也不在 dispatch 已实现的协议里」，
 * 而不是让他等一个看不懂的 spawn 报错。
 */
export const KNOWN_AGENT_PROTOCOLS: Readonly<
  Record<string, { protocol: string; label: string }>
> = {
  opencode: { protocol: "opencode-run-json", label: "opencode 的 `run --json`（一次性事件流）" },
  claude: { protocol: "claude-stream-json", label: "claude 的 `-p --output-format stream-json`" },
};

/** 创建/编辑载荷（`PATCH` 时字段可缺省；运行时逐字段校验） */
export interface RuntimeEntryInput {
  name?: string;
  command?: string;
  args?: string[];
  protocol?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  permissionPolicy?: "allow" | "deny";
}

/** 表单「探测验证」的结果（不落盘） */
export interface RuntimeCandidateProbe extends RuntimeProbeResult {
  probeStatus: "ok";
}

/** 表单「探测验证」失败时的结果（不落盘，也不抛错 —— 原因要显示给人看） */
export interface RuntimeCandidateProbeFailure {
  probeStatus: "unreachable";
  probeError: string;
  probeErrorCode: RuntimeRegistryErrorCode;
}

/** 默认注册表：本机能直接派发的三个（装了哪个就探到哪个） */
export const DEFAULT_RUNTIME_ENTRIES: readonly RuntimeEntry[] = [
  { name: "fengagent", command: "fengagent", args: ["acp"], enabled: true },
  { name: "dsh", command: "dsh-acp", args: ["acp"], enabled: true },
  { name: "kimi", command: "kimi", args: ["acp"], enabled: true },
  // claude 不是 ACP：走 `claude -p --output-format stream-json`（见 claude-client.ts）
  { name: "claude", command: "claude", protocol: "claude-stream-json", enabled: true },
];

/** 注册表选项 */
export interface AgentRuntimeRegistryOptions {
  /** 数据根（`<数据根>/runtimes.json`） */
  dataRoot: string;
  /** 覆盖默认条目（测试用；不传则读/写 json） */
  entries?: readonly RuntimeEntry[];
  /** 探测实现（测试注入；默认真 spawn） */
  probe?: (entry: RuntimeEntry) => Promise<RuntimeProbeResult>;
  /** 探测超时（毫秒，默认 20000 —— dsh 冷启实测 ~13s） */
  probeTimeoutMs?: number;
  now?: () => number;
}

interface PersistedRegistry {
  runtimes: RuntimeEntry[];
  probes?: Record<string, PersistedProbe>;
}

/** 落盘/缓存用的探测结果（成功带身份与能力，失败只带错误） */
interface PersistedProbe {
  status: "ok" | "unreachable";
  probedAt: string;
  agentName?: string;
  agentVersion?: string;
  capabilities?: { resume: boolean; loadSession: boolean; image: boolean };
  error?: string;
  errorCode?: RuntimeRegistryErrorCode;
}

/**
 * 运行时注册表。
 *
 * 用法：
 * ```ts
 * const registry = new AgentRuntimeRegistry({ dataRoot });
 * const infos = await registry.probeAll();      // 探测（可也显式逐个 probe）
 * const entry = registry.get("kimi");           // 派发前拿 command/args
 * registry.create({ name: "my-agent", command: "my-agent", args: ["acp"] });
 * ```
 */
export class AgentRuntimeRegistry {
  private readonly configPath: string;
  private readonly dataRoot: string;
  private readonly entriesByName = new Map<string, RuntimeEntry>();
  private readonly probes = new Map<string, PersistedProbe>();
  private readonly probeImpl: (entry: RuntimeEntry) => Promise<RuntimeProbeResult>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: AgentRuntimeRegistryOptions) {
    this.configPath = join(options.dataRoot, "runtimes.json");
    this.dataRoot = options.dataRoot;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
    this.now = options.now ?? Date.now;
    this.probeImpl = options.probe ?? ((entry) => this.spawnProbe(entry));

    const persisted = options.entries === undefined ? this.loadPersisted() : null;
    const entries = options.entries ?? persisted?.runtimes ?? [...DEFAULT_RUNTIME_ENTRIES];
    for (const entry of entries) {
      // ACP 缺省参数是 ["acp"]；claude 这类一次性协议自己拼参数，别塞 "acp"
      this.entriesByName.set(entry.name, {
        ...entry,
        ...(entry.protocol === "claude-stream-json" ? {} : { args: entry.args ?? ["acp"] }),
      });
    }
    if (options.entries === undefined) {
      if (persisted === null) {
        // 首次落盘失败不致命：内存里的注册表照样能用，下次写入再重试。
        try {
          this.save();
        } catch (err) {
          log.warn("registry", `初始化写 runtimes.json 失败: ${errorMessage(err)}`);
        }
      }
      for (const [name, probe] of Object.entries(persisted?.probes ?? {})) {
        this.probes.set(name, probe);
      }
    }
  }

  /** 当前注册条目（含启用状态） */
  entries(): RuntimeEntry[] {
    return [...this.entriesByName.values()];
  }

  /** 取某个 runtime（不存在返回 undefined） */
  get(name: string): RuntimeEntry | undefined {
    return this.entriesByName.get(name);
  }

  /**
   * 对外卡片（不探测，只回缓存）。
   *
   * @param taskCounts - runtime → 近 24h 任务数（由 service 从任务仓统计）
   */
  list(taskCounts: Map<string, number> = new Map()): RuntimeInfo[] {
    return this.entries().map((entry) => this.toInfo(entry, taskCounts.get(entry.name) ?? 0));
  }

  /**
   * 启用/停用某个 runtime（落盘）。
   *
   * @param name - 注册名
   * @param enabled - 目标状态
   */
  setEnabled(name: string, enabled: boolean): RuntimeInfo {
    const entry = this.entriesByName.get(name);
    if (!entry) {
      throw new RuntimeRegistryError("not_found", `未注册的 runtime: ${name}`);
    }
    entry.enabled = enabled;
    this.save();
    return this.toInfo(entry, 0);
  }

  /**
   * 新增一个 runtime（落盘）。
   *
   * @param input - 表单载荷（name / command / args / protocol / env / enabled）
   * @param options - `probe: true` 时先真 spawn 一次 `initialize`，失败则**不落盘**并抛错
   * @returns 最新卡片列表
   */
  async create(input: RuntimeEntryInput, options: { probe?: boolean } = {}): Promise<RuntimeInfo[]> {
    const name = normalizeName(input.name);
    if (this.entriesByName.has(name)) {
      throw new RuntimeRegistryError("conflict", `runtime 已存在: ${name}（换个名字，或直接编辑它）`);
    }
    const entry = this.normalizeEntry(input, name);

    if (options.probe === true) {
      // 探测是「添加」的一部分时：失败就带着原因整体失败，别留下一条永远派发不出去的注册。
      try {
        const result = await this.executeProbe(entry);
        this.probes.set(name, {
          status: "ok",
          agentName: result.agentName,
          agentVersion: result.agentVersion,
          capabilities: result.capabilities,
          probedAt: result.probedAt,
        });
      } catch (err) {
        const failure = classifyProbeError(err);
        throw new RuntimeRegistryError(failure.code, failure.message, 422);
      }
    }

    this.entriesByName.set(name, entry);
    this.save();
    return this.list();
  }

  /**
   * 编辑一个 runtime（落盘；注册名不可改，它是 `dispatch_task` 的 agent 参数）。
   *
   * 只覆盖请求里**出现过**的字段；改了 command / args / protocol / env 之后
   * 旧探测结果作废（重新变回 unprobed），避免卡片显示已经过期的「可用」。
   *
   * @param name - 注册名（路径参数）
   * @param patch - 要改的字段
   * @returns 最新卡片列表
   */
  update(name: string, patch: RuntimeEntryInput): RuntimeInfo[] {
    const existing = this.entriesByName.get(name);
    if (!existing) {
      throw new RuntimeRegistryError("not_found", `未注册的 runtime: ${name}`);
    }

    const merged: RuntimeEntry = { ...existing };
    const touched = (key: keyof RuntimeEntryInput): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);

    let connectionChanged = false;
    if (touched("command")) {
      merged.command = normalizeCommand(patch.command);
      connectionChanged = true;
    }
    if (touched("args")) {
      merged.args = normalizeArgs(patch.args);
      connectionChanged = true;
    }
    if (touched("env")) {
      const env = normalizeEnv(patch.env);
      if (env === undefined) delete merged.env;
      else merged.env = env;
      connectionChanged = true;
    }
    if (touched("protocol")) {
      merged.protocol = validateProtocol(merged.command, patch.protocol);
      connectionChanged = true;
    }
    if (touched("enabled")) merged.enabled = normalizeEnabled(patch.enabled);
    if (touched("permissionPolicy")) {
      const policy = normalizePermissionPolicy(patch.permissionPolicy);
      if (policy === undefined) delete merged.permissionPolicy;
      else merged.permissionPolicy = policy;
    }

    // 命令换了要重新确认它真的在 PATH 里（否则等于把注册表改坏了）
    if (touched("command")) ensureExecutable(merged.command);
    // 协议总校验一次（command 变了可能和已有 protocol 不搭）
    merged.protocol = validateProtocol(merged.command, merged.protocol);
    // ACP 一条没参数时补默认 ["acp"]，否则派发会落成裸命令
    if (merged.protocol !== "claude-stream-json" && merged.args === undefined) {
      merged.args = ["acp"];
    }

    if (connectionChanged) this.probes.delete(name);
    this.entriesByName.set(name, merged);
    this.save();
    return this.list();
  }

  /**
   * 删除一个 runtime（落盘 + 清探测缓存）。
   *
   * @param name - 注册名
   * @returns 最新卡片列表
   */
  remove(name: string): RuntimeInfo[] {
    if (!this.entriesByName.has(name)) {
      throw new RuntimeRegistryError("not_found", `未注册的 runtime: ${name}`);
    }
    this.entriesByName.delete(name);
    this.probes.delete(name);
    this.save();
    return this.list();
  }

  /**
   * 表单「探测验证」：拿一份**还没落盘**的配置真 spawn 一次 `initialize`。
   *
   * 与 {@link probe} 的区别是它不写注册表、不写缓存，而且**不抛错** ——
   * 失败原因（命令不存在 / 协议不支持 / spawn 失败 / 凭据缺失 / 握手失败）
   * 原样回给前端展示。
   *
   * @param input - 表单载荷（name 可缺省）
   */
  async probeCandidate(
    input: RuntimeEntryInput,
  ): Promise<RuntimeCandidateProbe | RuntimeCandidateProbeFailure> {
    let entry: RuntimeEntry;
    try {
      // 候选项也要有命令、也要在 PATH 里 —— 「探测验证」的产出就是这些具体原因，
      // 不能等 spawn 报一个看不懂的错。
      entry = this.normalizeEntry(input, input.name?.trim() || "<candidate>", true);
    } catch (err) {
      const failure = classifyProbeError(err);
      return {
        probeStatus: "unreachable",
        probeError: failure.message,
        probeErrorCode: failure.code,
      };
    }
    try {
      const result = await this.executeProbe(entry);
      return {
        probeStatus: "ok",
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        capabilities: result.capabilities,
        probedAt: result.probedAt,
      };
    } catch (err) {
      const failure = classifyProbeError(err);
      return {
        probeStatus: "unreachable",
        probeError: failure.message,
        probeErrorCode: failure.code,
      };
    }
  }

  /**
   * 探测单个 runtime（真 spawn + initialize + 回收）。
   *
   * 失败不抛错：结果落缓存并回在卡片的 `probeError` / `probeErrorCode` 上
   * —— 列表页要显示「不可达 + 为什么」，不能因为一个 runtime 挂掉整页报错。
   *
   * @param name - 注册名
   * @param taskCount - 卡片上显示的近 24h 任务数
   */
  async probe(name: string, taskCount = 0): Promise<RuntimeInfo> {
    const entry = this.entriesByName.get(name);
    if (!entry) {
      throw new RuntimeRegistryError("not_found", `未注册的 runtime: ${name}`);
    }
    try {
      const result = await this.executeProbe(entry);
      this.probes.set(name, {
        status: "ok",
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        capabilities: result.capabilities,
        probedAt: result.probedAt,
      });
    } catch (err) {
      const failure = classifyProbeError(err);
      this.probes.set(name, {
        status: "unreachable",
        error: failure.message.slice(0, 500),
        errorCode: failure.code,
        probedAt: new Date(this.now()).toISOString(),
      });
      log.warn("probe", `${name} 不可达(${failure.code}): ${failure.message.slice(0, 200)}`);
    }
    try {
      this.save();
    } catch (err) {
      log.warn("registry", `写 runtimes.json 失败: ${errorMessage(err)}`);
    }
    return this.toInfo(entry, taskCount);
  }

  /**
   * 探测全部**启用**的 runtime（并发、互相独立）。
   *
   * @param taskCounts - runtime → 近 24h 任务数
   */
  async probeAll(taskCounts: Map<string, number> = new Map()): Promise<RuntimeInfo[]> {
    const entries = this.entries().filter((entry) => entry.enabled);
    await Promise.all(
      entries.map((entry) =>
        this.probe(entry.name, taskCounts.get(entry.name) ?? 0).catch(() => undefined),
      ),
    );
    return this.list(taskCounts);
  }

  /** 真正跑一次探测（成功返回握手信息，失败抛原始错误；超时算 probe_timeout） */
  private async executeProbe(entry: RuntimeEntry): Promise<RuntimeProbeResult> {
    try {
      return await withTimeout(
        this.probeImpl(entry),
        this.probeTimeoutMs,
        `探测 ${entry.name} 超时（${this.probeTimeoutMs}ms）：目标进程没有在超时内回应 initialize`,
      );
    } catch (err) {
      if (err instanceof RuntimeRegistryError) throw err;
      const message = errorMessage(err);
      if (/超时/.test(message)) {
        throw new RuntimeRegistryError("probe_timeout", message, 422);
      }
      throw err;
    }
  }

  /** 用一个短命子进程真跑一次 initialize（默认探测实现） */
  private async spawnProbe(entry: RuntimeEntry): Promise<RuntimeProbeResult> {
    const driver = createRuntimeDriver(entry, {
      cwd: this.dataRoot,
      requestTimeoutMs: this.probeTimeoutMs,
      promptTimeoutMs: this.probeTimeoutMs,
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.args ? { extraArgs: entry.args } : {}),
      onLog: (level, message) => log[level]("probe", `${entry.name}: ${message}`),
    });
    try {
      const handshake = await driver.initialize();
      return {
        agentName: handshake.agentName,
        agentVersion: handshake.agentVersion,
        capabilities: handshake.capabilities,
        probedAt: new Date(this.now()).toISOString(),
      };
    } finally {
      await driver.close(1500).catch(() => undefined);
    }
  }

  /**
   * 校验 + 规范化一条注册条目。
   *
   * @param input - 表单载荷
   * @param name - 已规范化的注册名
   * @param requireCommand - 创建/探测时命令必填
   */
  private normalizeEntry(
    input: RuntimeEntryInput,
    name: string,
    requireCommand = true,
  ): RuntimeEntry {
    const command = normalizeCommand(input.command, requireCommand);
    const protocol = validateProtocol(command, input.protocol);
    if (requireCommand) ensureExecutable(command);

    const entry: RuntimeEntry = { name, command, protocol, enabled: normalizeEnabled(input.enabled) };
    if (Object.prototype.hasOwnProperty.call(input, "args")) {
      entry.args = normalizeArgs(input.args);
    } else if (protocol !== "claude-stream-json") {
      entry.args = ["acp"];
    }
    const env = normalizeEnv(input.env);
    if (env !== undefined) entry.env = env;
    const policy = normalizePermissionPolicy(input.permissionPolicy);
    if (policy !== undefined) entry.permissionPolicy = policy;
    return entry;
  }

  private toInfo(entry: RuntimeEntry, recentTaskCount: number): RuntimeInfo {
    const probe = this.probes.get(entry.name);
    const base = {
      name: entry.name,
      command: [entry.command, ...(entry.args ?? [])].join(" "),
      executable: entry.command,
      ...(entry.args === undefined ? {} : { args: [...entry.args] }),
      protocol: entry.protocol ?? "acp",
      ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
      enabled: entry.enabled,
      recentTaskCount,
    };
    if (!probe) {
      return {
        ...base,
        agentName: "",
        agentVersion: "",
        capabilities: { resume: false, loadSession: false, image: false },
        probeStatus: "unprobed",
      };
    }
    if (probe.status === "unreachable") {
      return {
        ...base,
        agentName: "",
        agentVersion: "",
        capabilities: { resume: false, loadSession: false, image: false },
        probeStatus: "unreachable",
        probeError: probe.error,
        ...(probe.errorCode === undefined ? {} : { probeErrorCode: probe.errorCode }),
        probedAt: probe.probedAt,
      };
    }
    return {
      ...base,
      agentName: probe.agentName ?? "",
      agentVersion: probe.agentVersion ?? "",
      capabilities:
        probe.capabilities ?? { resume: false, loadSession: false, image: false },
      probeStatus: "ok",
      probedAt: probe.probedAt,
    };
  }

  private loadPersisted(): PersistedRegistry | null {
    if (!existsSync(this.configPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf-8")) as PersistedRegistry;
      if (!Array.isArray(raw.runtimes)) return null;
      return raw;
    } catch (err) {
      log.warn("registry", `runtimes.json 解析失败，回退默认注册表: ${String(err)}`);
      return null;
    }
  }

  private save(): void {
    const probes: PersistedRegistry["probes"] = {};
    for (const [name, probe] of this.probes) probes[name] = probe;
    const payload: PersistedRegistry = { runtimes: this.entries(), probes };
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    } catch (err) {
      throw new RuntimeRegistryError(
        "registry_io",
        `写 runtimes.json 失败: ${errorMessage(err)}（数据根: ${this.dataRoot}）`,
      );
    }
  }
}

// ──────────────────────────────────────────────
// 校验 / 归类工具
// ──────────────────────────────────────────────

/** 注册名：派发参数 + URL 路径都用到，限制成可安全出现在两者里的字符 */
const RUNTIME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") {
    throw new RuntimeRegistryError("bad_request", "name 必填（注册名，就是 dispatch_task 的 agent 参数）");
  }
  if (!RUNTIME_NAME_PATTERN.test(name)) {
    throw new RuntimeRegistryError(
      "bad_request",
      `name 不合法: ${name}（只允许字母/数字/._-，以字母或数字开头，最长 64）`,
    );
  }
  return name;
}

function normalizeCommand(raw: unknown, required = true): string {
  const command = typeof raw === "string" ? raw.trim() : "";
  if (command === "") {
    if (!required) return "";
    throw new RuntimeRegistryError(
      "bad_request",
      "command 必填（要拉起的可执行文件，例如 kimi / dsh-acp / opencode）",
    );
  }
  if (/[\r\n]/.test(command)) {
    throw new RuntimeRegistryError("bad_request", "command 不能包含换行（一整条命令行请拆成 args）");
  }
  return command;
}

function normalizeArgs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new RuntimeRegistryError(
      "bad_request",
      'args 必须是字符串数组（例如 ["acp"]；一整条命令行请拆开写）',
    );
  }
  return raw.map((item) => item as string);
}

function normalizeEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeRegistryError("bad_request", "env 必须是 { 变量名: 值 } 对象（凭据放这里）");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() === "") {
      throw new RuntimeRegistryError("bad_request", "env 的变量名不能为空");
    }
    if (typeof value !== "string") {
      throw new RuntimeRegistryError("bad_request", `env.${key} 必须是字符串`);
    }
    env[key] = value;
  }
  return env;
}

function normalizeEnabled(raw: unknown): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== "boolean") {
    throw new RuntimeRegistryError("bad_request", "enabled 必须是布尔值");
  }
  return raw;
}

function normalizePermissionPolicy(raw: unknown): "allow" | "deny" | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw !== "allow" && raw !== "deny") {
    throw new RuntimeRegistryError("bad_request", "permissionPolicy 只能是 allow 或 deny");
  }
  return raw;
}

/** 命令名归一（去掉 exe/.cmd 后缀，用于查「这个命令原生是什么协议」） */
function commandKey(command: string): string {
  return basename(command).toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}

/**
 * 校验启动协议。
 *
 * 三种失败都要说清楚，且都以「协议不支持」开头（前端原样展示，验收点）：
 * 1. 值本身不在 dispatch 已实现的协议里；
 * 2. 这个命令我们认识，它的原生协议不是选中的这个（opencode 的 `run --json`）；
 * 3. 空的 protocol → 缺省 acp（合法）。
 *
 * @param command - 可执行文件（用来查命令的原生协议）
 * @param raw - 请求里的 protocol
 */
function validateProtocol(command: string, raw: unknown): RuntimeProtocol {
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw new RuntimeRegistryError("bad_request", "protocol 必须是字符串（acp / claude-stream-json）");
  }
  const requested = typeof raw === "string" ? raw.trim() : "";
  const effective = requested === "" ? "acp" : requested;
  const supported = SUPPORTED_PROTOCOLS as readonly string[];
  const key = commandKey(command);
  const known = key === "" ? undefined : KNOWN_AGENT_PROTOCOLS[key];

  if (supported.includes(effective)) {
    if (known !== undefined && known.protocol !== effective) {
      throw new RuntimeRegistryError(
        "unsupported_protocol",
        `协议不支持: ${known.label}，不是 ${effective}。dispatch 目前只实现 acp / claude-stream-json 两种协议，这个 runtime 加上也派发不出去。`,
      );
    }
    return effective as RuntimeProtocol;
  }

  const knownValue = known === undefined ? "" : `；${known.label} 属于它自己的协议`;
  throw new RuntimeRegistryError(
    "unsupported_protocol",
    `协议不支持: ${effective}${knownValue}。dispatch 目前只实现 acp（NDJSON JSON-RPC）与 claude-stream-json（claude -p --output-format stream-json）两种。`,
  );
}

/**
 * 确认命令能被拉起（在 PATH 里找得到，或是存在的可执行文件）。
 *
 * 只做「存在性」检查，不 spawn —— 添加表单要能立刻回答「命令不存在」，
 * 而不是等 20s 探测超时。
 *
 * @param command - 可执行文件名或路径
 */
function ensureExecutable(command: string): void {
  if (resolveExecutable(command) !== null) return;
  throw new RuntimeRegistryError(
    "command_not_found",
    `命令不存在: ${command}（PATH 里找不到可执行文件；装了但没进 PATH 的话，请填绝对路径）`,
  );
}

/** PATH 解析（Windows 按 PATHEXT 补后缀；找不到返回 null） */
function resolveExecutable(command: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")
      : [""];
  const withExts = (path: string): string[] => {
    if (process.platform !== "win32") return [path];
    const lower = path.toLowerCase();
    if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) return [path];
    // PATH 里找到的是无后缀 shim 时，Windows 实际要的是 .cmd/.exe 那份
    return exts.map((ext) => `${path}${ext.toLowerCase()}`);
  };

  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    candidates.push(...withExts(command));
  } else {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (dir.trim() === "") continue;
      candidates.push(...withExts(join(dir, command)));
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在就试下一个
    }
  }
  return null;
}

/**
 * 把探测失败归类成「人能看懂且能行动」的原因。
 *
 * @param err - 探测时的原始错误
 */
export function classifyProbeError(err: unknown): {
  code: RuntimeRegistryErrorCode;
  message: string;
} {
  if (err instanceof RuntimeRegistryError) {
    return { code: err.code, message: err.message };
  }
  const raw = errorMessage(err);
  const detail = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
  const suffix = detail === "" ? "" : ` 原始信息: ${detail}`;

  // 凭据：目标跑起来但自报缺 key / 未登录（放在 spawn 判断之前，
  // 因为 stderr 里常同时出现 ENOENT 之类的噪音）
  if (
    /api[\s_-]?key|unauthori[sz]ed|not logged in|credential|auth(?:entication)? failed|401|403|请先登录|未登录|认证失败|凭据/i.test(
      raw,
    )
  ) {
    return {
      code: "credentials_missing",
      message: `凭据缺失或无效: 目标进程自报鉴权失败，请在「凭据」里填上它需要的环境变量（如 API Key），或先在本机登录该 CLI。${suffix}`,
    };
  }
  if (/ENOENT|not found|找不到|不是内部或外部命令|executable not found/i.test(raw)) {
    return { code: "command_not_found", message: `命令不存在或无法拉起:${suffix}` };
  }
  if (/EINVAL|EACCES|EPERM|spawn 失败|spawn .*failed/i.test(raw)) {
    const hint =
      process.platform === "win32" && /EINVAL/i.test(raw)
        ? "（Windows 上 .cmd/.bat 不能直接 spawn，请指向 .exe 或给该 CLI 装原生可执行文件）"
        : "";
    return { code: "spawn_failed", message: `spawn 失败${hint}:${suffix}` };
  }
  if (/超时|timed? ?out/i.test(raw)) {
    return {
      code: "probe_timeout",
      message: `探测超时: 目标进程没有在超时内完成 initialize 握手。${suffix}`,
    };
  }
  return {
    code: "handshake_failed",
    message: `initialize 握手失败: 目标进程没有按所选协议回应。${suffix}`,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 带超时的 promise（探测不能把 HTTP 请求吊死） */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
