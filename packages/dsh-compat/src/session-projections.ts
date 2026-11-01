/**
 * @fengagent/dsh-compat — `ctx.sessionProjections` 服务面（P3 收尾）
 *
 * dsh 的 `SessionProjectionRegistry`（`@deepseek-ai/dsh-session-projection`）是
 * 「按会话从事件日志折叠出的整值状态」的注册表：领域插件登记纯函数
 * `{ key, init, apply, stateVersion, wire? }`，框架负责订阅事件、按会话缓存
 * 折叠结果、在**视图引用变化**时推变更。`dsh-tool-todo-plus` 的工具面板、
 * `dsh-plan-mode`、`dsh-token-meter` 都靠它读状态；`todo-plus` 更是把它列进
 * `inject`，缺它就是装载前的硬门槛。
 *
 * 本实现覆盖**读面 + 驱动面**：
 *
 * - `register()`（同名引用计数）、`onChanged()`、`stateOf()`、`snapshot()`、
 *   `cachedSnapshot()`、`checkpoint()`、`restoreFloor()`、`viewCheckpoint()`、
 *   `restore()`、`hydrate()`；
 * - 驱动由宿主接线：`SessionsCompat.append()` 写入
 *   {@link SessionEventLog} 后调用 {@link SessionProjectionsCompat.drive}，
 *   每个注册单元按 `apply` 前进一格（返回同一引用即视为「不关心」）。
 *
 * 已知偏差（写进 `docs/DSH-CONTRACT-MAP.md` §10）：
 * 1. 事件源是**进程内**日志（见 `session-events.ts`）：没有持久事件日志，
 *    因此 `restore()` 只能折叠**调用方传进来的**事件，不能从磁盘重放；
 *    `restoreFloor()` 恒为 `0`（必须从日志头折起）。
 * 2. 懒物化用 `session.events`（消息投影 + 领域事件）做首次折叠；消息投影的
 *    `seq` 会随消息增长位移，所以 `asOfSeq` / `checkpoint.seq` 是**进程内相对
 *    水位**，不能当持久游标用。
 * 3. 注册项的 `stateSchema` / `wire.viewSchema` 只做 `safeParse`/`parse` 校验
 *    （zod 结构类型），不 import zod；校验失败按上游口径抛错。
 */

import { DshContractUnsupportedError } from "./contracts.ts";
import type { DshSessionEvent, DshSessionHeader, DshSessionLike } from "./contracts.ts";

/** 最小 zod schema 面（`safeParse` 优先，退回 `parse`） */
export interface SchemaLike<T = unknown> {
  safeParse?(value: unknown): { success: true; data: T } | { success: false; error: unknown };
  parse?(value: unknown): T;
}

/**
 * 一个投影单元的注册参数（与上游 `ProjectionDefinition` 同形）。
 *
 * `K` 只是标签，运行时不校验 key 是否在 dsh 的类型表里——市场插件自带
 * `declare module` 扩展，兼容层没有那张表。
 */
export interface ProjectionDefinitionLike<S = unknown> {
  /** 投影键（同一键可被多个插件共享注册） */
  readonly key: string;
  /** 折叠前校验持久状态 */
  readonly stateSchema: SchemaLike<S>;
  /** 空日志的初始状态 */
  init(header: DshSessionHeader, inheritedEventCount: number): S;
  /** 纯同步折叠：不关心的事件必须返回同一引用 */
  apply(state: S, event: DshSessionEvent): S;
  /** 客户端视图（省略 = 只给宿主读） */
  readonly wire?: {
    readonly viewSchema: SchemaLike;
    view(state: S): unknown;
  };
  /** 状态版本（缓存失效用，非负整数） */
  readonly stateVersion: number;
}

/** 一次一致读切面 */
export interface ProjectionSnapshot {
  asOfSeq: number;
  values: Record<string, unknown>;
}

/** 一个单元的检查点行 */
export interface ProjectionCheckpointRow {
  ver: number;
  seq: number;
  val: unknown;
}

/** 一次检查点（key → 行） */
export type ProjectionCheckpoint = Record<string, ProjectionCheckpointRow>;

/** 变更监听器（`value` 已过 `viewSchema`） */
export type ProjectionChangeListener = (
  session: DshSessionLike,
  key: string,
  value: unknown,
  seq: number,
) => void;

/** 内部单元格：状态 + 水位 + 上次的 wire 结果 */
interface Cell {
  state: unknown;
  seq: number;
  wire: unknown;
  wireComputed: boolean;
}

/** 一个注册单元 */
interface Unit {
  readonly definition: ProjectionDefinitionLike;
  count: number;
}

/**
 * `ctx.sessionProjections` 的兼容实现。
 *
 * 用法与 dsh 一致：`ctx.sessionProjections.register({...})`，宿主在事件产生后
 * 调用 {@link drive}（`services-plugin` 已把 `sessions.append` 接上）。
 */
export class SessionProjectionsCompat {
  private readonly units = new Map<string, Unit>();
  private readonly cells = new Map<string, Map<string, Cell>>();
  private readonly listeners = new Set<ProjectionChangeListener>();

  /**
   * 注册一个投影单元。
   *
   * @param definition - 键 / schema / 纯折叠 / 可选客户端视图
   * @returns 精确的注销函数（引用计数归零时移除，并丢弃已缓存的单元格）
   */
  register(definition: ProjectionDefinitionLike): () => void {
    validateDefinition(definition);
    const existing = this.units.get(definition.key);
    if (existing) {
      existing.count += 1;
      return this.refCountDisposer(definition.key);
    }
    this.units.set(definition.key, { definition, count: 1 });
    return this.refCountDisposer(definition.key);
  }

  /**
   * 订阅变更推送（引用未变的视图不推）。
   *
   * @param listener - 变更回调
   * @returns 取消订阅函数
   */
  onChanged(listener: ProjectionChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 读一个单元的宿主状态（缺省懒物化）。
   *
   * @param session - 目标会话
   * @param key - 投影键
   * @returns 当前状态；键未注册时为 `undefined`
   */
  stateOf(session: DshSessionLike, key: string): unknown {
    const unit = this.units.get(key);
    if (!unit) return undefined;
    return this.cellFor(session, key).state;
  }

  /**
   * 一次一致读切面：所有**有客户端视图**的已注册单元的当前值。
   *
   * @param session - 目标会话
   * @param keys - 可选的键过滤
   */
  snapshot(session: DshSessionLike, keys?: readonly string[]): ProjectionSnapshot {
    const selected = this.selectedWireKeys(keys);
    const values: Record<string, unknown> = {};
    let asOfSeq = -1;
    for (const key of selected) {
      const cell = this.cellFor(session, key);
      values[key] = this.viewOf(key, cell);
      asOfSeq = Math.max(asOfSeq, cell.seq);
    }
    return { asOfSeq, values };
  }

  /**
   * 只读已物化的单元格（不折叠历史；缺省单元直接省略）。
   *
   * @param session - 目标会话
   * @param keys - 可选的键过滤
   * @returns 共同水位；没有任何已物化的视图时返回 `undefined`
   */
  cachedSnapshot(session: DshSessionLike, keys?: readonly string[]): ProjectionSnapshot | undefined {
    const cached = this.cells.get(session.id);
    if (!cached) return undefined;
    const values: Record<string, unknown> = {};
    let asOfSeq: number | undefined;
    for (const key of this.selectedWireKeys(keys)) {
      const cell = cached.get(key);
      if (!cell) continue;
      values[key] = this.viewOf(key, cell);
      asOfSeq = asOfSeq === undefined ? cell.seq : Math.min(asOfSeq, cell.seq);
    }
    if (asOfSeq === undefined) return undefined;
    return { asOfSeq, values };
  }

  /**
   * 写侧检查点：每个已注册单元的状态 + 水位 + 版本（结构化克隆，脱离活引用）。
   *
   * @param session - 目标会话
   */
  checkpoint(session: DshSessionLike): ProjectionCheckpoint {
    const rows: ProjectionCheckpoint = {};
    for (const key of this.units.keys()) {
      const cell = this.cellFor(session, key);
      const unit = this.units.get(key)!;
      rows[key] = {
        ver: unit.definition.stateVersion,
        seq: cell.seq,
        val: structuredClone(cell.state),
      };
    }
    return rows;
  }

  /**
   * 一次 `restore` 尾读要从哪开始：没有注册单元时 `undefined`；否则恒为 `0`
   * （进程内没有持久日志，必须从日志头折起）。
   *
   * @param _checkpoint - 已持久化的检查点（忽略）
   */
  restoreFloor(_checkpoint: ProjectionCheckpoint): number | undefined {
    return this.units.size === 0 ? undefined : 0;
  }

  /**
   * 零 I/O 视图：只服务「版本匹配」的检查点行，其余键省略。
   *
   * @param checkpoint - 持久化行
   * @param keys - 可选的键过滤
   */
  viewCheckpoint(checkpoint: ProjectionCheckpoint, keys?: readonly string[]): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const key of this.selectedWireKeys(keys)) {
      const unit = this.units.get(key);
      const row = checkpoint[key];
      if (!unit?.definition.wire || !row) continue;
      if (row.ver !== unit.definition.stateVersion) continue;
      const state = validate(unit.definition.stateSchema, row.val, `projection "${key}" state`);
      values[key] = validate(unit.definition.wire.viewSchema, unit.definition.wire.view(state), `projection "${key}" view`);
    }
    return values;
  }

  /**
   * 冷读：从检查点（可用时）或 `init` 起，折叠一段事件后缀并给出该切面的
   * 快照与刷新后的检查点。
   *
   * @param checkpoint - 持久化行
   * @param events - 从 `baseSeq` 起的事件（按 seq 升序）
   * @param baseSeq - 第一个事件的 seq
   * @param header - 会话元数据
   * @param inheritedEventCount - fork 继承的前缀长度
   */
  restore(
    checkpoint: ProjectionCheckpoint,
    events: readonly DshSessionEvent[],
    baseSeq: number,
    header: DshSessionHeader,
    inheritedEventCount: number,
  ): { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint } {
    const values: Record<string, unknown> = {};
    const rows: ProjectionCheckpoint = {};
    let endSeq = baseSeq - 1;

    for (const [key, unit] of this.units) {
      const row = checkpoint[key];
      const usable =
        row !== undefined && row.ver === unit.definition.stateVersion && row.seq >= baseSeq - 1;
      if (!usable && baseSeq > 0) {
        throw new Error(
          `dsh-compat/sessionProjections: "${key}" has no usable checkpoint row at baseSeq ${baseSeq}; refold from seq 0`,
        );
      }
      let state: unknown = usable
        ? validate(unit.definition.stateSchema, row.val, `projection "${key}" state`)
        : unit.definition.init(header, inheritedEventCount);
      let seq = usable ? row.seq : baseSeq - 1;
      for (const event of events) {
        const next = unit.definition.apply(state, event);
        if (!Object.is(next, state)) {
          state = next;
          seq = event.seq;
        }
      }
      endSeq = Math.max(endSeq, seq);
      rows[key] = { ver: unit.definition.stateVersion, seq, val: structuredClone(state) };
      if (unit.definition.wire) {
        values[key] = validate(
          unit.definition.wire.viewSchema,
          unit.definition.wire.view(state),
          `projection "${key}" view`,
        );
      }
    }
    return { snapshot: { asOfSeq: endSeq, values }, checkpoint: rows };
  }

  /**
   * 恢复一个精确切面并把它装进指定会话的单元格（后续驱动从该水位继续）。
   *
   * @param session - 目标会话
   * @param checkpoint - 持久化行
   * @param events - 该切面的事件
   * @param baseSeq - 第一个事件的 seq
   */
  hydrate(
    session: DshSessionLike,
    checkpoint: ProjectionCheckpoint,
    events: readonly DshSessionEvent[],
    baseSeq: number,
  ): ProjectionSnapshot {
    const { snapshot, checkpoint: rows } = this.restore(
      checkpoint,
      events,
      baseSeq,
      session.header,
      0,
    );
    const cells = this.cells.get(session.id) ?? new Map<string, Cell>();
    for (const [key, row] of Object.entries(rows)) {
      const unit = this.units.get(key);
      if (!unit) continue;
      cells.set(key, {
        state: row.val,
        seq: row.seq,
        wire: unit.definition.wire ? snapshot.values[key] : undefined,
        wireComputed: unit.definition.wire !== undefined,
      });
    }
    this.cells.set(session.id, cells);
    return snapshot;
  }

  /**
   * 驱动一格：把一个已提交事件喂给所有注册单元。
   *
   * 宿主接线点（`SessionsCompat.append` 已接）。返回同一引用的单元不产生
   * 任何下游工作，与上游口径一致。
   *
   * @param session - 事件所属会话
   * @param event - 已提交事件
   */
  drive(session: DshSessionLike, event: DshSessionEvent): void {
    if (this.units.size === 0) return;
    const cells = this.cellsFor(session);
    for (const [key, unit] of this.units) {
      // 懒物化只折「这条事件之前」的历史：`session.events` 可能已经包含它，
      // 再整体折叠一次会让 apply 跑两遍（首个 append 就不会推变更了）
      const cell = cells.get(key) ?? this.buildCell(session, key, event.seq);
      cells.set(key, cell);
      let next: unknown;
      try {
        next = unit.definition.apply(cell.state, event);
      } catch (error) {
        // 单元折叠失败不能把会话写路径带崩：保留旧状态并记录
        console.warn(
          `[dsh-compat] session project  "${key}" apply() 失败，保留上一状态：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (Object.is(next, cell.state)) continue;
      const previousWire = cell.wireComputed ? cell.wire : undefined;
      const nextCell: Cell = { state: next, seq: event.seq, wire: undefined, wireComputed: false };
      if (unit.definition.wire) {
        try {
          nextCell.wire = validate(
            unit.definition.wire.viewSchema,
            unit.definition.wire.view(next),
            `projection "${key}" view`,
          );
          nextCell.wireComputed = true;
        } catch (error) {
          console.warn(
            `[dsh-compat] session projection "${key}" view() 失败，保留上一视图：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          cells.set(key, { ...cell, state: next, seq: event.seq });
          continue;
        }
      }
      cells.set(key, nextCell);
      if (nextCell.wireComputed && !Object.is(previousWire, nextCell.wire)) {
        for (const listener of [...this.listeners]) {
          try {
            listener(session, key, nextCell.wire, event.seq);
          } catch (error) {
            console.warn(
              `[dsh-compat] session projection 监听器抛错（已忽略）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    }
  }

  /**
   * 显式声明不支持的面（保留给诊断）。
   *
   * @throws 恒抛——兼容层没有持久事件日志可供重放
   */
  unsupportedMutation(): never {
    throw new DshContractUnsupportedError(
      "sessionProjections",
      "the compat event log is in-process only; durable projection restore needs the P4 persistent event bridge",
    );
  }

  /** 当前注册的单元键（诊断用） */
  get registeredKeys(): readonly string[] {
    return [...this.units.keys()];
  }

  private selectedWireKeys(keys?: readonly string[]): string[] {
    const all = [...this.units.entries()]
      .filter(([, unit]) => unit.definition.wire !== undefined)
      .map(([key]) => key);
    if (keys === undefined) return all;
    return keys.filter((key) => all.includes(key));
  }

  private cellsFor(session: DshSessionLike): Map<string, Cell> {
    let cells = this.cells.get(session.id);
    if (!cells) {
      cells = new Map();
      this.cells.set(session.id, cells);
    }
    return cells;
  }

  /** 懒物化：从 `init` 起折叠该会话的完整事件视图 */
  private cellFor(session: DshSessionLike, key: string): Cell {
    const cells = this.cellsFor(session);
    const cached = cells.get(key);
    if (cached) return cached;
    const cell = this.buildCell(session, key);
    cells.set(key, cell);
    return cell;
  }

  /**
   * 从 `init` 起折叠事件建单元格。
   *
   * @param session - 目标会话
   * @param key - 投影键
   * @param beforeSeq - 只折 `seq < beforeSeq` 的事件（`drive` 防重复折叠）
   */
  private buildCell(session: DshSessionLike, key: string, beforeSeq?: number): Cell {
    const unit = this.units.get(key);
    if (!unit) {
      return { state: undefined, seq: -1, wire: undefined, wireComputed: false };
    }
    let state: unknown = unit.definition.init(
      session.header,
      session.header.seedLength ?? 0,
    );
    let seq = -1;
    for (const event of session.events) {
      if (beforeSeq !== undefined && event.seq >= beforeSeq) continue;
      const next = unit.definition.apply(state, event);
      if (!Object.is(next, state)) {
        state = next;
        seq = event.seq;
      }
    }
    let wire: unknown;
    let wireComputed = false;
    if (unit.definition.wire) {
      wire = validate(
        unit.definition.wire.viewSchema,
        unit.definition.wire.view(state),
        `projection "${key}" view`,
      );
      wireComputed = true;
    }
    return { state, seq, wire, wireComputed };
  }

  private viewOf(key: string, cell: Cell): unknown {
    const unit = this.units.get(key);
    if (!unit?.definition.wire) return undefined;
    if (cell.wireComputed) return cell.wire;
    const wire = validate(
      unit.definition.wire.viewSchema,
      unit.definition.wire.view(cell.state),
      `projection "${key}" view`,
    );
    cell.wire = wire;
    cell.wireComputed = true;
    return wire;
  }

  private refCountDisposer(key: string): () => void {
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const unit = this.units.get(key);
      if (!unit) return;
      unit.count -= 1;
      if (unit.count > 0) return;
      this.units.delete(key);
      for (const cells of this.cells.values()) cells.delete(key);
    };
  }
}

/** 结构校验：key 非空、函数在位、stateVersion 是非负整数 */
function validateDefinition(definition: ProjectionDefinitionLike): void {
  if (typeof definition?.key !== "string" || definition.key.length === 0) {
    throw new Error("dsh-compat/sessionProjections: definition.key must be a non-empty string");
  }
  if (typeof definition.init !== "function" || typeof definition.apply !== "function") {
    throw new Error(
      `dsh-compat/sessionProjections: "${definition.key}" needs init() and apply()`,
    );
  }
  if (!Number.isInteger(definition.stateVersion) || definition.stateVersion < 0) {
    throw new Error(
      `dsh-compat/sessionProjections: "${definition.key}" stateVersion must be a non-negative integer`,
    );
  }
}

/** zod 结构校验：优先 `safeParse`，退回 `parse`，都没有则原样返回 */
function validate<T>(schema: SchemaLike<T>, value: unknown, what: string): T {
  if (schema && typeof schema.safeParse === "function") {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new Error(`dsh-compat/sessionProjections: ${what} failed validation: ${String(result.error)}`);
  }
  if (schema && typeof schema.parse === "function") {
    return schema.parse(value);
  }
  return value as T;
}
