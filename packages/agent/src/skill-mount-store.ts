/**
 * @fengagent/agent — Skill 挂载层与版本快照（P1，SQLite）
 *
 * 内容层（团队 skill 库 .md 文件）与挂载层（谁挂了哪个 skill）分离：
 * - `agent_skill`：多对多挂载关系 + 独立启停（卸载只删关系，不删内容）；
 * - `skill_revision`： append-only 版本快照（sha256 + 正文），支持回滚与「被谁用」。
 *
 * 为什么放 SQLite 而不是继续写在 `agents/<id>/config.json`：挂载关系要支持
 * 「一个 skill 被 N 个 agent 使用」的反查与独立启停，文件形态每查一次都要扫全量
 * agent 目录；`config.skills` 保留为兼容视图（P1 双写，UI 详情页仍读它）。
 *
 * 与既有 store 同构：首启 `CREATE TABLE IF NOT EXISTS` + 老库按列补迁移，
 * 不引入独立迁移框架。
 */

import { Database } from "bun:sqlite";
import { expandTilde } from "@fengagent/shared/utils";

/** 挂载来源（内容层来源：builtin / team / workdir；导入方式另记在 skill-sources.json） */
export type SkillMountSource = "builtin" | "team" | "workdir";

/** 挂载记录 */
export interface AgentSkillMount {
  agentId: string;
  skillName: string;
  source: string;
  enabled: boolean;
  /** 覆盖 skill 自身的 trigger（P1 只做存储，P2 briefing 用） */
  triggerOverride?: string;
  createdAt: number;
  updatedAt: number;
}

/** 版本快照 */
export interface SkillRevision {
  skillName: string;
  version: number;
  contentHash: string;
  /** 导入方式 / 写入来源：manual | local | url | runtime_copy | restore | edit */
  source: string;
  /** 正文（含 frontmatter），用于 restore */
  content: string;
  createdAt: number;
}

/** 挂载入参 */
export interface UpsertSkillMountInput {
  agentId: string;
  skillName: string;
  source?: string;
  enabled?: boolean;
  triggerOverride?: string;
}

/** 建仓选项 */
export interface SkillMountStoreOptions {
  /** 复用既有连接（与 SessionStore 同库时传进来，避免多连接写锁） */
  db?: Database;
  now?: () => number;
}

/** 记录行（SQLite 原始） */
interface MountRow {
  agent_id: string;
  skill_name: string;
  source: string;
  enabled: number;
  trigger_override: string | null;
  created_at: number;
  updated_at: number;
}

/** 版本行（SQLite 原始） */
interface RevisionRow {
  skill_name: string;
  version: number;
  content_hash: string;
  source: string;
  content: string;
  created_at: number;
}

/** 挂载层仓 */
export class SkillMountStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly now: () => number;

  constructor(dbPath: string, options: SkillMountStoreOptions = {}) {
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(expandTilde(dbPath));
      this.ownsDb = true;
    }
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_skill (
        agent_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'team',
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_override TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, skill_name)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_skill_name ON agent_skill(skill_name);

      CREATE TABLE IF NOT EXISTS skill_revision (
        skill_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (skill_name, version)
      );
    `);
  }

  /** 某 agent 的全部挂载（按名字排序，UI 稳定） */
  listForAgent(agentId: string): AgentSkillMount[] {
    const rows = this.db
      .query("SELECT * FROM agent_skill WHERE agent_id = ? ORDER BY skill_name ASC")
      .all(agentId) as MountRow[];
    return rows.map(toMount);
  }

  /** 单条挂载 */
  get(agentId: string, skillName: string): AgentSkillMount | undefined {
    const row = this.db
      .query("SELECT * FROM agent_skill WHERE agent_id = ? AND skill_name = ?")
      .get(agentId, skillName) as MountRow | null;
    return row ? toMount(row) : undefined;
  }

  /**
   * 增量添加（`ON CONFLICT DO NOTHING`，对齐 Multica `AddAgentSkill`）。
   *
   * 已挂载时不覆盖既有 enabled/trigger —— 重复点「添加」不该悄悄把停用项重新启用。
   * @returns 最终行 + 是否新建
   */
  add(input: UpsertSkillMountInput): { mount: AgentSkillMount; created: boolean } {
    const existing = this.get(input.agentId, input.skillName);
    if (existing) return { mount: existing, created: false };
    const at = this.now();
    this.db
      .query(
        `INSERT INTO agent_skill (agent_id, skill_name, source, enabled, trigger_override, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, skill_name) DO NOTHING`,
      )
      .run(
        input.agentId,
        input.skillName,
        input.source ?? "team",
        input.enabled === false ? 0 : 1,
        input.triggerOverride ?? null,
        at,
        at,
      );
    return { mount: this.get(input.agentId, input.skillName)!, created: true };
  }

  /** 全量替换（对齐 Multica `SetAgentSkills`）：多删少增，保留已存在行的启停状态 */
  replace(agentId: string, skillNames: readonly string[], source = "team"): AgentSkillMount[] {
    const wanted = [...new Set(skillNames.map((name) => name.trim()).filter((name) => name !== ""))];
    const existing = new Set(this.listForAgent(agentId).map((mount) => mount.skillName));
    const tx = this.db.transaction(() => {
      for (const name of existing) {
        if (!wanted.includes(name)) {
          this.db.query("DELETE FROM agent_skill WHERE agent_id = ? AND skill_name = ?").run(agentId, name);
        }
      }
      for (const name of wanted) {
        if (existing.has(name)) continue;
        this.add({ agentId, skillName: name, source });
      }
    });
    tx();
    return this.listForAgent(agentId);
  }

  /** 启停 / 覆盖 trigger；行不存在返回 undefined */
  patch(
    agentId: string,
    skillName: string,
    patch: { enabled?: boolean; triggerOverride?: string | null },
  ): AgentSkillMount | undefined {
    const existing = this.get(agentId, skillName);
    if (!existing) return undefined;
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
    const trigger =
      patch.triggerOverride === undefined ? existing.triggerOverride : patch.triggerOverride;
    this.db
      .query(
        "UPDATE agent_skill SET enabled = ?, trigger_override = ?, updated_at = ? WHERE agent_id = ? AND skill_name = ?",
      )
      .run(enabled ? 1 : 0, trigger ?? null, this.now(), agentId, skillName);
    return this.get(agentId, skillName);
  }

  /** 卸载（只删关系，不删内容）；返回是否真的删了 */
  remove(agentId: string, skillName: string): boolean {
    const result = this.db
      .query("DELETE FROM agent_skill WHERE agent_id = ? AND skill_name = ?")
      .run(agentId, skillName);
    return result.changes > 0;
  }

  /** 删除某 agent 的全部挂载（归档/清理用） */
  removeAgent(agentId: string): number {
    const result = this.db.query("DELETE FROM agent_skill WHERE agent_id = ?").run(agentId);
    return result.changes;
  }

  /** 反向查询：哪些 agent 挂了这个 skill（「被 N 个智能体使用」） */
  agentsUsing(skillName: string): Array<{ agentId: string; enabled: boolean }> {
    const rows = this.db
      .query("SELECT agent_id, enabled FROM agent_skill WHERE skill_name = ? ORDER BY agent_id ASC")
      .all(skillName) as Array<{ agent_id: string; enabled: number }>;
    return rows.map((row) => ({ agentId: row.agent_id, enabled: row.enabled === 1 }));
  }

  /**
   * 追加一条版本快照。
   *
   * 内容与上一版相同则不重复追加（返回上一版）—— 避免「打开编辑再保存」刷出一堆
   * 同 hash 版本；内容变化才递增 version。
   */
  recordRevision(input: {
    skillName: string;
    content: string;
    contentHash: string;
    source: string;
  }): SkillRevision {
    const latest = this.latestRevision(input.skillName);
    if (latest && latest.contentHash === input.contentHash) return latest;
    const version = (latest?.version ?? 0) + 1;
    const at = this.now();
    this.db
      .query(
        `INSERT INTO skill_revision (skill_name, version, content_hash, source, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.skillName, version, input.contentHash, input.source, input.content, at);
    return {
      skillName: input.skillName,
      version,
      contentHash: input.contentHash,
      source: input.source,
      content: input.content,
      createdAt: at,
    };
  }

  /** 版本列表（新 → 旧；不含正文，列表接口用） */
  listRevisions(skillName: string): Array<Omit<SkillRevision, "content">> {
    const rows = this.db
      .query(
        "SELECT skill_name, version, content_hash, source, created_at FROM skill_revision WHERE skill_name = ? ORDER BY version DESC",
      )
      .all(skillName) as Array<Omit<RevisionRow, "content">>;
    return rows.map((row) => ({
      skillName: row.skill_name,
      version: row.version,
      contentHash: row.content_hash,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  /** 取指定版本（含正文；restore 用） */
  getRevision(skillName: string, version: number): SkillRevision | undefined {
    const row = this.db
      .query("SELECT * FROM skill_revision WHERE skill_name = ? AND version = ?")
      .get(skillName, version) as RevisionRow | null;
    return row ? toRevision(row) : undefined;
  }

  /** 最新版本 */
  latestRevision(skillName: string): SkillRevision | undefined {
    const row = this.db
      .query("SELECT * FROM skill_revision WHERE skill_name = ? ORDER BY version DESC LIMIT 1")
      .get(skillName) as RevisionRow | null;
    return row ? toRevision(row) : undefined;
  }

  /** 关库（注入的共享连接不关） */
  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

/** 行 → 挂载视图 */
function toMount(row: MountRow): AgentSkillMount {
  return {
    agentId: row.agent_id,
    skillName: row.skill_name,
    source: row.source,
    enabled: row.enabled === 1,
    ...(row.trigger_override === null ? {} : { triggerOverride: row.trigger_override }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 行 → 版本视图 */
function toRevision(row: RevisionRow): SkillRevision {
  return {
    skillName: row.skill_name,
    version: row.version,
    contentHash: row.content_hash,
    source: row.source,
    content: row.content,
    createdAt: row.created_at,
  };
}
