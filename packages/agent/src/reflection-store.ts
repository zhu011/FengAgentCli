/**
 * @fengagent/agent — 自省卡仓（ReflectionStore，SQLite）
 *
 * RSI 首期 P0 的落盘层，两张表：
 *
 * - `reflections`       —— 当前卡片（`revision` 单调递增，是乐观锁版本）；
 * - `reflection_events` —— `reflect/*` 事件流（seq 单调），因此「证据 → 卡 → 注入」
 *   这条闭环可以从事件流复原（与 `TaskStore` 的 task_events 同口径）。
 *
 * 三个刻意的设计：
 *
 * 1. **证据门在存储层**（`create` / `ingest` 都过 {@link assertValidReflectionCard}）：
 *    无证据的「觉得」到不了库里，调用方无需自觉。
 * 2. **写必须是 CAS**：`transition(id, expectedRevision, patch)` 用
 *    `UPDATE ... WHERE id=? AND revision=?` 判定，冲突抛 `stale_revision` ——
 *    并发写同一张卡时后到的一方失败，而不是静默覆盖。
 * 3. **建表全是 `CREATE TABLE IF NOT EXISTS`**：老库开箱可用，无需迁移。
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ReflectionCard,
  ReflectionEffect,
  ReflectionEvidence,
  ReflectionScope,
  ReflectionStatus,
  ReflectionTargetKind,
  ReflectionTrigger,
  ReflectEvent,
} from "@fengagent/core";
import {
  ReflectionError,
  assertValidReflectionCard,
  hasReflectionEvidence,
  isReflectionInjectable,
  reflectionRank,
} from "@fengagent/core";
import { expandTilde, generateId } from "@fengagent/shared/utils";

/** 数据库行 */
interface ReflectionRow {
  id: string;
  revision: number;
  scope: string;
  scope_key: string;
  status: string;
  trigger: string;
  signal_json: string;
  lesson: string;
  evidence_json: string;
  applies_kind: string;
  applies_target: string;
  effect_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

interface ReflectionEventRow {
  seq: number;
  card_id: string;
  type: string;
  payload: string;
  at: number;
}

/** 新建卡片入参（id / revision / 时间戳由仓生成） */
export interface CreateReflectionInput {
  scope?: ReflectionScope;
  /** 作用域键（默认 `project:default`） */
  scopeKey?: string;
  trigger: ReflectionTrigger;
  signal?: {
    conclusion: string;
    completionScore?: number;
    correctnessScore?: number;
    sessionId?: string;
  };
  /** 一句话教训 */
  lesson: string;
  /** 证据指针（至少一条，否则不入库） */
  evidence: ReflectionEvidence[];
  appliesTo?: { kind: ReflectionTargetKind; target: string };
  /** 过期时间（毫秒时间戳；缺省用 ttlMs） */
  expiresAt?: number;
  /** 存活期（毫秒；0/undefined 表示不过期） */
  ttlMs?: number;
  /** 时间戳（测试可注入；默认 Date.now()） */
  at?: number;
}

/** 卡片状态推进入参 */
export interface TransitionReflectionInput {
  status?: ReflectionStatus;
  effect?: ReflectionEffect | null;
  lesson?: string;
  expiresAt?: number | null;
}

/** 查询过滤 */
export interface ListReflectionFilter {
  scope?: ReflectionScope;
  scopeKey?: string;
  status?: ReflectionStatus | ReflectionStatus[];
  /** 只看此刻可注入的（状态 + TTL + 证据门） */
  injectableAt?: number;
}

/** 仓选项 */
export interface ReflectionStoreOptions {
  /** 复用既有数据库连接（默认按 dbPath 自建） */
  db?: Database;
  /** 默认存活期（毫秒；默认 14 天，0 = 不过期） */
  ttlMs?: number;
  /** 时钟注入（测试用；默认 Date.now） */
  now?: () => number;
}

/** 默认存活期：14 天（与 FENG_REFLECT_TTL_MS 默认一致） */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** `recordInjection` 的「读 → CAS」重试次数（并发注入时重读最新 revision 再试） */
const RECORD_INJECTION_ATTEMPTS = 3;

function safeParse<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** 行 → 卡片 */
function rowToCard(row: ReflectionRow): ReflectionCard {
  return {
    id: row.id,
    revision: row.revision,
    scope: row.scope as ReflectionScope,
    scopeKey: row.scope_key,
    status: row.status as ReflectionStatus,
    trigger: row.trigger as ReflectionTrigger,
    signal: safeParse(row.signal_json),
    lesson: row.lesson,
    evidence: safeParse<ReflectionEvidence[]>(row.evidence_json),
    appliesTo: {
      kind: row.applies_kind as ReflectionTargetKind,
      target: row.applies_target,
    },
    effect: row.effect_json === null ? null : safeParse(row.effect_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

/**
 * 自省卡仓。
 *
 * 用法：
 * ```ts
 * const store = new ReflectionStore(resolveReflectDbPath());
 * const card = store.create({ trigger: "judge_failed", lesson: "...", evidence: [...] });
 * store.transition(card.id, card.revision, { status: "injected" });
 * ```
 */
export class ReflectionStore {
  private db: Database;
  private ownsDb: boolean;
  private ttlMs: number;
  private now: () => number;

  constructor(dbPath: string, options?: ReflectionStoreOptions) {
    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const expanded = expandTilde(dbPath);
      if (expanded !== ":memory:") {
        mkdirSync(dirname(expanded), { recursive: true });
      }
      this.db = new Database(expanded);
      this.ownsDb = true;
    }
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options?.now ?? Date.now;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        signal_json TEXT NOT NULL,
        lesson TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        applies_kind TEXT NOT NULL,
        applies_target TEXT NOT NULL,
        effect_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reflections_scope
        ON reflections(scope, scope_key, status);

      CREATE TABLE IF NOT EXISTS reflection_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reflection_events_card
        ON reflection_events(card_id, seq);
    `);
  }

  // ── 写入 ────────────────────────────────────

  /**
   * 新建卡片。
   *
   * @throws {ReflectionError} 无证据（`evidence_required`）/ 未知触发源 / 教训为空
   */
  create(input: CreateReflectionInput): ReflectionCard {
    assertValidReflectionCard(input);
    const at = input.at ?? this.now();
    const ttl = input.ttlMs ?? this.ttlMs;
    const expiresAt =
      input.expiresAt ?? (ttl > 0 ? at + ttl : undefined);

    const card: ReflectionCard = {
      id: generateId(),
      revision: 1,
      scope: input.scope ?? "project",
      scopeKey: input.scopeKey ?? "project:default",
      status: "proposed",
      trigger: input.trigger,
      signal: {
        conclusion: input.signal?.conclusion ?? "unknown",
        ...(input.signal?.completionScore === undefined
          ? {}
          : { completionScore: input.signal.completionScore }),
        ...(input.signal?.correctnessScore === undefined
          ? {}
          : { correctnessScore: input.signal.correctnessScore }),
        ...(input.signal?.sessionId === undefined
          ? {}
          : { sessionId: input.signal.sessionId }),
      },
      lesson: input.lesson.trim(),
      evidence: input.evidence.map((e) => ({ ...e })),
      appliesTo: input.appliesTo ?? { kind: "system-prompt", target: "prompt-overlay.md" },
      effect: null,
      createdAt: at,
      updatedAt: at,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };

    this.db
      .query(
        `INSERT INTO reflections
         (id, revision, scope, scope_key, status, trigger, signal_json, lesson,
          evidence_json, applies_kind, applies_target, effect_json,
          created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        card.id,
        card.revision,
        card.scope,
        card.scopeKey,
        card.status,
        card.trigger,
        JSON.stringify(card.signal),
        card.lesson,
        JSON.stringify(card.evidence),
        card.appliesTo.kind,
        card.appliesTo.target,
        card.createdAt,
        card.updatedAt,
        card.expiresAt ?? null,
      );

    this.appendEvent({
      type: "reflect/card-created",
      cardId: card.id,
      trigger: card.trigger,
      evidence: card.evidence.map((e) => ({ ...e })),
      at,
    });

    return card;
  }

  /**
   * 证据门式入库：无证据直接丢弃（返回 null，不抛）。
   *
   * 主循环/评测侧用它 —— 「无证据的觉得」是正常输入，不该让调用方处理异常。
   */
  ingest(input: CreateReflectionInput): ReflectionCard | null {
    if (!hasReflectionEvidence({ evidence: input.evidence })) return null;
    try {
      return this.create(input);
    } catch (err) {
      if (err instanceof ReflectionError) return null;
      throw err;
    }
  }

  /**
   * 状态推进（乐观锁 CAS）。
   *
   * @param id - 卡片 id
   * @param expectedRevision - 调用方读到的版本
   * @param patch - 变更内容
   * @returns 推进后的卡片
   * @throws {ReflectionError} 卡片不存在（`card_not_found`）或版本陈旧（`stale_revision`）
   */
  transition(
    id: string,
    expectedRevision: number,
    patch: TransitionReflectionInput,
    at?: number,
  ): ReflectionCard {
    const current = this.get(id);
    if (!current) {
      throw new ReflectionError(`reflection card ${id} not found`, "card_not_found");
    }
    if (current.revision !== expectedRevision) {
      throw new ReflectionError(
        `stale revision for reflection ${id}: expected ${expectedRevision}, stored ${current.revision}`,
        "stale_revision",
      );
    }

    const when = at ?? this.now();
    const nextStatus = patch.status ?? current.status;
    const nextEffect = patch.effect === undefined ? current.effect : patch.effect;
    const nextLesson =
      patch.lesson === undefined ? current.lesson : patch.lesson.trim();
    if (nextLesson.length === 0) {
      throw new ReflectionError("reflection lesson must not be empty", "invalid_lesson");
    }
    const nextExpires =
      patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt ?? undefined;
    const nextRevision = current.revision + 1;

    const result = this.db
      .query(
        `UPDATE reflections
         SET revision = ?, status = ?, lesson = ?, effect_json = ?,
             updated_at = ?, expires_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        nextRevision,
        nextStatus,
        nextLesson,
        nextEffect === null ? null : JSON.stringify(nextEffect),
        when,
        nextExpires ?? null,
        id,
        expectedRevision,
      );

    // CAS 兜底：即便上面的读校验通过，并发写仍可能抢在前面（changes=0 → 陈旧）
    if (result.changes === 0) {
      throw new ReflectionError(
        `stale revision for reflection ${id}: write lost the race at revision ${expectedRevision}`,
        "stale_revision",
      );
    }

    this.appendEvent(
      nextStatus === "expired"
        ? { type: "reflect/expired", cardId: id, at: when }
        : nextStatus === "adopted"
          ? { type: "reflect/adopted", cardId: id, at: when }
          : nextStatus === "rejected"
            ? { type: "reflect/rejected", cardId: id, reason: "rejected by gate", at: when }
            : {
                type: "reflect/card-updated",
                cardId: id,
                revision: nextRevision,
                status: nextStatus,
                at: when,
              },
    );

    return this.get(id)!;
  }

  /**
   * 记录一次注入（状态 → injected，`effect.injectedCount` 累加）。
   *
   * 「读 → CAS」是两步：真正并发注入同一张卡时，后到的一方会撞上 `stale_revision`。
   * 这里做**有界重试**（重读最新 revision 再试），重试仍冲突就放弃这张卡 ——
   * 注入记账不是主线事务，不该把异常抛给对话主循环。
   *
   * @param ids - 本轮注入的卡片 id
   * @param sessionId - 注入到的会话
   * @param at - 时间戳
   * @returns 实际更新的卡片数
   */
  recordInjection(ids: readonly string[], sessionId: string, at?: number): number {
    const when = at ?? this.now();
    let updated = 0;
    for (const id of ids) {
      for (let attempt = 0; attempt < RECORD_INJECTION_ATTEMPTS; attempt++) {
        const card = this.get(id);
        if (!card) break; // 卡片不存在/已删除 → 跳过，不算更新
        const effect: ReflectionEffect = {
          injectedCount: (card.effect?.injectedCount ?? 0) + 1,
          lastInjectedAt: when,
        };
        try {
          this.transition(
            id,
            card.revision,
            { status: card.status === "adopted" ? "adopted" : "injected", effect },
            when,
          );
        } catch (err) {
          if (err instanceof ReflectionError && err.code === "stale_revision") {
            // 版本陈旧 → 重读最新 revision 再试；重试用尽就放弃这张卡
            if (attempt < RECORD_INJECTION_ATTEMPTS - 1) continue;
            break;
          }
          throw err;
        }
        this.appendEvent({ type: "reflect/injected", cardId: id, sessionId, at: when });
        updated++;
        break;
      }
    }
    return updated;
  }

  /**
   * 过期清理：把 `expiresAt <= now` 的卡片置为 expired，并留痕。
   *
   * @returns 被清理的卡片 id
   */
  expireDue(now?: number): string[] {
    const when = now ?? this.now();
    const rows = this.db
      .query(
        `SELECT * FROM reflections
         WHERE expires_at IS NOT NULL AND expires_at <= ?
           AND status IN ('proposed','injected','adopted')`,
      )
      .all(when) as ReflectionRow[];
    const expired: string[] = [];
    for (const row of rows) {
      const card = rowToCard(row);
      this.transition(card.id, card.revision, { status: "expired" }, when);
      expired.push(card.id);
    }
    return expired;
  }

  // ── 读取 ────────────────────────────────────

  /** 取一张卡（不存在返回 null） */
  get(id: string): ReflectionCard | null {
    const row = this.db
      .query("SELECT * FROM reflections WHERE id = ?")
      .get(id) as ReflectionRow | null;
    return row ? rowToCard(row) : null;
  }

  /** 列表查询 */
  list(filter?: ListReflectionFilter): ReflectionCard[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.scope) {
      where.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter?.scopeKey) {
      where.push("scope_key = ?");
      params.push(filter.scopeKey);
    }
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const sql =
      `SELECT * FROM reflections${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}` +
      " ORDER BY created_at DESC, rowid DESC";
    const rows = this.db.query(sql).all(...(params as never[])) as ReflectionRow[];
    const cards = rows.map(rowToCard);
    if (filter?.injectableAt === undefined) return cards;
    const at = filter.injectableAt;
    return cards.filter((c) => isReflectionInjectable(c, at));
  }

  /**
   * 选出本轮要注入的卡片（排序后由注入通道按预算截断）。
   *
   * @param opts - 作用域 + 时间 + 条数上限
   */
  selectForInjection(opts?: {
    scope?: ReflectionScope;
    scopeKey?: string;
    at?: number;
    limit?: number;
  }): ReflectionCard[] {
    const at = opts?.at ?? this.now();
    const candidates = this.list({
      ...(opts?.scope ? { scope: opts.scope } : {}),
      ...(opts?.scopeKey ? { scopeKey: opts.scopeKey } : {}),
      injectableAt: at,
    });
    candidates.sort((a, b) => reflectionRank(b, at) - reflectionRank(a, at));
    const limit = opts?.limit ?? candidates.length;
    return candidates.slice(0, limit);
  }

  /** 事件流（可按卡片过滤，seq 升序） */
  events(cardId?: string): ReflectEvent[] {
    const rows = (
      cardId === undefined
        ? this.db.query("SELECT * FROM reflection_events ORDER BY seq").all()
        : this.db
            .query("SELECT * FROM reflection_events WHERE card_id = ? ORDER BY seq")
            .all(cardId)
    ) as ReflectionEventRow[];
    return rows.map((r) => safeParse<ReflectEvent>(r.payload));
  }

  /** 关闭自建连接（复用的连接由调用方负责） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private appendEvent(event: ReflectEvent): void {
    this.db
      .query(
        `INSERT INTO reflection_events (card_id, type, payload, at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "cardId" in event ? event.cardId : "",
        event.type,
        JSON.stringify(event),
        event.at,
      );
  }
}
