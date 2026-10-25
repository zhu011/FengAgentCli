/**
 * @fengagent/server — 外部 agent 运行时注册表
 *
 * 「能把任务派给谁」的事实来源：`<数据根>/runtimes.json`（缺省写一份默认注册表），
 * 每项描述一个本机 agent 二进制怎么拉起来（command + args + env + enabled），
 * 探测结果（agentInfo / 能力 / 可达性）缓存在内存里，可显式刷新。
 *
 * 为什么要有注册表而不是硬编码：`dispatch_task` 的 `agent` 参数、Agents 页的
 * runtime 卡片、探测徽标都从同一份清单来 —— 加一个 runtime 只改 json，不改代码。
 *
 * 实测方言（同 NDJSON ACP）：`kimi acp`（冷启 ~0.7s）、`dsh-acp acp`（冷启 ~13s）、
 * `fengagent acp`（本仓库自身）。探测超时因此给到 20s。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AcpClient } from "@fengagent/agent";
import type { AcpHandshake } from "@fengagent/agent";
import { createLogger } from "@fengagent/shared";

const log = createLogger("agent-runtimes");

/** 注册表条目（落盘形状） */
export interface RuntimeEntry {
  /** 注册名（`dispatch_task` 的 agent 参数） */
  name: string;
  /** 可执行文件 */
  command: string;
  /** 参数（默认 `["acp"]`） */
  args?: string[];
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
  command: string;
  agentName: string;
  agentVersion: string;
  capabilities: { resume: boolean; loadSession: boolean; image: boolean };
  probeStatus: "ok" | "unreachable" | "unprobed";
  probeError?: string;
  probedAt?: string;
  enabled: boolean;
  recentTaskCount: number;
}

/** 默认注册表：本机能直接派发的三个（装了哪个就探到哪个） */
export const DEFAULT_RUNTIME_ENTRIES: readonly RuntimeEntry[] = [
  { name: "fengagent", command: "fengagent", args: ["acp"], enabled: true },
  { name: "dsh", command: "dsh-acp", args: ["acp"], enabled: true },
  { name: "kimi", command: "kimi", args: ["acp"], enabled: true },
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
}

/**
 * 运行时注册表。
 *
 * 用法：
 * ```ts
 * const registry = new AgentRuntimeRegistry({ dataRoot });
 * const infos = await registry.probeAll();      // 探测（可也显式逐个 probe）
 * const entry = registry.get("kimi");           // 派发前拿 command/args
 * ```
 */
export class AgentRuntimeRegistry {
  private readonly configPath: string;
  private readonly entriesByName = new Map<string, RuntimeEntry>();
  private readonly probes = new Map<string, PersistedProbe>();
  private readonly probeImpl: (entry: RuntimeEntry) => Promise<RuntimeProbeResult>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: AgentRuntimeRegistryOptions) {
    this.configPath = join(options.dataRoot, "runtimes.json");
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
    this.now = options.now ?? Date.now;
    this.probeImpl = options.probe ?? ((entry) => this.spawnProbe(entry));

    const persisted = options.entries === undefined ? this.loadPersisted() : null;
    const entries = options.entries ?? persisted?.runtimes ?? [...DEFAULT_RUNTIME_ENTRIES];
    for (const entry of entries) {
      this.entriesByName.set(entry.name, { ...entry, args: entry.args ?? ["acp"] });
    }
    if (options.entries === undefined) {
      if (persisted === null) this.save();
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
    if (!entry) throw new Error(`未注册的 runtime: ${name}`);
    entry.enabled = enabled;
    this.save();
    return this.toInfo(entry, 0);
  }

  /**
   * 探测单个 runtime（真 spawn + initialize + 回收）。
   *
   * @param name - 注册名
   * @param taskCount - 卡片上显示的近 24h 任务数
   */
  async probe(name: string, taskCount = 0): Promise<RuntimeInfo> {
    const entry = this.entriesByName.get(name);
    if (!entry) throw new Error(`未注册的 runtime: ${name}`);
    try {
      const result = await withTimeout(
        this.probeImpl(entry),
        this.probeTimeoutMs,
        `探测 ${name} 超时（${this.probeTimeoutMs}ms）`,
      );
      this.probes.set(name, {
        status: "ok",
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        capabilities: result.capabilities,
        probedAt: result.probedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.probes.set(name, {
        status: "unreachable",
        error: message.slice(0, 500),
        probedAt: new Date(this.now()).toISOString(),
      });
      log.warn("probe", `${name} 不可达: ${message.slice(0, 200)}`);
    }
    this.save();
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

  /** 用一个短命子进程真跑一次 initialize（默认探测实现） */
  private async spawnProbe(entry: RuntimeEntry): Promise<RuntimeProbeResult> {
    const client = new AcpClient({
      command: entry.command,
      args: entry.args ?? ["acp"],
      env: entry.env ?? {},
      requestTimeoutMs: this.probeTimeoutMs,
      onLog: (level, message) => log[level]("probe", `${entry.name}: ${message}`),
    });
    try {
      const handshake: AcpHandshake = await client.initialize();
      return {
        agentName: handshake.agentInfo.name,
        agentVersion: handshake.agentInfo.version,
        capabilities: handshake.capabilities,
        probedAt: new Date(this.now()).toISOString(),
      };
    } finally {
      await client.close(1500).catch(() => undefined);
    }
  }

  private toInfo(entry: RuntimeEntry, recentTaskCount: number): RuntimeInfo {
    const probe = this.probes.get(entry.name);
    const base = {
      name: entry.name,
      command: [entry.command, ...(entry.args ?? [])].join(" "),
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
      log.warn("registry", `写 runtimes.json 失败: ${String(err)}`);
    }
  }
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
