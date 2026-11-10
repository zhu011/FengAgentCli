/**
 * @fengagent/web-ui — 技能库视图（团队级共享 skill P0）
 *
 * 团队页第四个子视图：三层技能（内置 / 团队 / 本目录）的合并管理。
 * - 合并视图列出所有层定义：同名高优先层（workdir > team > builtin）胜出，
 *   被覆盖的定义带「已被 X 覆盖」徽章（管理界面要能看出 /skill 行为差异的来源）；
 * - 添加/编辑团队级技能（编辑内置 = 团队级同名覆盖，沿用同名覆盖语义）；
 * - 启停为名字级状态：停用 = 该技能对 agent 侧不可见（skill 工具与 /skill 都不含）；
 * - 删除团队技能 / 恢复内置默认（两步确认）；
 * - 「填入输入框」跳 ?view=chat&prefill-skill=<name>（等价 TUI /skill <name> 的可编辑再发）。
 *
 * 数据源：真实 API 优先，探测失败回退 SkillsMock（与任务库/成员库同模式）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Loader2, Plus, RotateCcw } from "lucide-react";
import type { ApiClient } from "../api/client.ts";
import { SKILL_SOURCE_LABEL, SkillsMock, type SkillLibrarySource } from "../api/skills-mock.ts";
import type { SkillInfo } from "../api/types.ts";
import { EMPTY_SKILL_FORM, formToSkillEntry, validateSkillForm, type SkillFormValue } from "./skill-form.ts";

/** 技能数据源：真实 API 优先，失败回退 mock（后端未落地阶段） */
function useSkillSource(client: ApiClient, forceMock: boolean) {
  const mockRef = useRef<SkillsMock | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const source = useMemo<SkillLibrarySource>(() => {
    if (mockMode) {
      mockRef.current ??= new SkillsMock();
      return mockRef.current;
    }
    return client;
  }, [mockMode, client]);

  const probe = useCallback(async () => {
    if (forceMock) {
      setMockMode(true);
      return;
    }
    try {
      await client.listSkills();
      setMockMode(false);
      setProbeError(null);
    } catch (err) {
      // 后端未就绪（404 / 网络错误）→ 回退 mock 演示数据
      setMockMode(true);
      setProbeError(err instanceof Error ? err.message : String(err));
    }
  }, [client, forceMock]);

  return { source, mockMode, probeError, probe };
}

/** 来源徽章样式 */
function sourceBadgeClass(source: SkillInfo["source"]): string {
  switch (source) {
    case "team":
      return "ag-badge ag-badge--ok";
    case "workdir":
      return "ag-badge ag-badge--running";
    default:
      return "ag-badge ag-badge--muted";
  }
}

/** 技能库（团队页子视图） */
export function SkillLibraryView({
  client,
  onPrefill,
}: {
  client: ApiClient;
  /** 「填入输入框」→ 跳聊天页并预填该技能 prompt（teams 页接线 navigate） */
  onPrefill: (name: string) => void;
}) {
  const forceMock = useMemo(() => {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  }, []);
  const { source, mockMode, probeError, probe } = useSkillSource(client, forceMock);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  /** 表单开/关 + 当前编辑对象（null = 添加模式） */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [form, setForm] = useState<SkillFormValue>(EMPTY_SKILL_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 删除/恢复默认的两步确认目标 */
  const [deleteTarget, setDeleteTarget] = useState<SkillInfo | null>(null);
  const [resetTarget, setResetTarget] = useState<SkillInfo | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSkills(await source.listSkills(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_SKILL_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(skill: SkillInfo) {
    setEditing(skill);
    setForm({
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      prompt: skill.prompt ?? "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  /** 保存（添加或编辑；编辑内置/本目录 = 在团队级创建同名覆盖） */
  async function save() {
    if (saving) return;
    const errors = validateSkillForm(form, editing !== null);
    if (errors.length > 0) {
      setFormError(errors.join("；"));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const entry = formToSkillEntry(form);
      if (editing) {
        await source.updateSkill(editing.name, entry);
      } else {
        await source.createSkill(entry);
      }
      setFormOpen(false);
      await reload();
    } catch (err) {
      // 后端返回什么错就原样显示（重名 409 / 名称规则 / 落盘失败…）
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** 启停（名字级：停用 = agent 侧不可见） */
  async function toggleEnabled(skill: SkillInfo) {
    try {
      await source.updateSkill(skill.name, { enabled: !skill.enabled });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    try {
      await source.deleteSkill(target.name);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doReset() {
    const target = resetTarget;
    if (!target) return;
    setResetTarget(null);
    try {
      await source.resetSkill(target.name);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // 搜索过滤（名称/描述，忽略大小写）
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, search]);

  // 同名分组：组内按层优先级排序（胜出者在前），并标注该名是否有内置层
  const groups = useMemo(() => {
    const byName = new Map<string, SkillInfo[]>();
    for (const s of visible) {
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }
    return [...byName.entries()].map(([name, entries]) => ({
      name,
      entries: [...entries].sort((a, b) => Number(Boolean(b.overriddenBy)) - Number(Boolean(a.overriddenBy))),
      hasBuiltin: entries.some((e) => e.source === "builtin"),
    }));
  }, [visible]);

  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <h2 className="ag-section__title">
          <BookOpen size={14} aria-hidden="true" /> 技能库
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="search"
            className="ag-form__select"
            style={{ width: 180 }}
            placeholder="搜索技能…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索技能"
          />
          <button type="button" className="ag-btn ag-btn--primary" onClick={openCreate}>
            <Plus size={14} aria-hidden="true" /> 添加技能
          </button>
        </div>
      </div>

      {mockMode && probeError ? (
        <div className="ag-page__hint">技能后端探测失败：{probeError}，已回退演示数据</div>
      ) : null}
      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}

      {/* 添加 / 编辑表单 */}
      {formOpen && (
        <div className="ag-form" data-testid="skill-form">
          <div className="tm-libhead">
            <h3 className="ag-section__title">
              {editing ? `编辑 ${editing.name}${editing.source !== "team" ? "（保存为团队级覆盖）" : ""}` : "添加技能"}
            </h3>
          </div>
          {formError ? <div className="ag-page__hint ag-page__hint--error">{formError}</div> : null}

          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="sk-name">名称</label>
            <input
              id="sk-name"
              className="ag-form__select"
              value={form.name}
              disabled={editing !== null}
              placeholder="如 code-review（小写 kebab-case）"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="sk-desc">描述</label>
            <input
              id="sk-desc"
              className="ag-form__select"
              value={form.description}
              placeholder="一句话说明这个技能做什么"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="sk-trigger">触发条件</label>
            <input
              id="sk-trigger"
              className="ag-form__select"
              value={form.trigger}
              placeholder="什么时候该用这个技能（给 LLM 参考，可留空）"
              onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
            />
          </div>
          <div className="ag-form__row">
            <label className="ag-form__label" htmlFor="sk-prompt">prompt 正文</label>
            <textarea
              id="sk-prompt"
              className="ag-form__select"
              rows={8}
              value={form.prompt}
              placeholder="技能的 Prompt 模板（/skill <name> 载入到这里）"
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </div>

          <div className="ag-form__actions">
            <button type="button" className="ag-btn ag-btn--primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
              {editing ? "保存修改" : "添加"}
            </button>
            <button type="button" className="ag-btn ag-btn--ghost" onClick={() => setFormOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 删除确认（两步，同成员库） */}
      {deleteTarget && (
        <div className="ag-page__hint ag-page__hint--error">
          确认删除团队技能「{deleteTarget.name}」？该技能将不再对团队成员可见。
          <button
            type="button"
            className="ag-btn ag-btn--mini ag-btn--ghost"
            style={{ marginLeft: 12 }}
            onClick={() => void doDelete()}
          >
            确认删除
          </button>
          <button
            type="button"
            className="ag-btn ag-btn--mini ag-btn--ghost"
            style={{ marginLeft: 6 }}
            onClick={() => setDeleteTarget(null)}
          >
            取消
          </button>
        </div>
      )}

      {/* 恢复默认确认（移除团队级覆盖，回到内置版本） */}
      {resetTarget && (
        <div className="ag-page__hint ag-page__hint--error">
          确认恢复「{resetTarget.name}」的内置默认版本？团队级覆盖将被移除（本目录文件不受影响）。
          <button
            type="button"
            className="ag-btn ag-btn--mini ag-btn--ghost"
            style={{ marginLeft: 12 }}
            onClick={() => void doReset()}
          >
            确认恢复
          </button>
          <button
            type="button"
            className="ag-btn ag-btn--mini ag-btn--ghost"
            style={{ marginLeft: 6 }}
            onClick={() => setResetTarget(null)}
          >
            取消
          </button>
        </div>
      )}

      {skills.length === 0 && !loading ? (
        <div className="ag-page__empty">暂无技能 — 用上方「添加技能」录入团队共享技能</div>
      ) : (
        <div className="ag-runtime-grid">
          {groups.map(({ name, entries, hasBuiltin }) =>
            entries.map((s) => {
              const shadowed = s.overriddenBy !== undefined;
              return (
                <div
                  key={`${s.source}:${name}`}
                  className="ag-runtime-card"
                  data-testid="skill-card"
                  data-skill-name={name}
                  data-skill-source={s.source}
                  style={shadowed || !s.enabled ? { opacity: 0.55 } : undefined}
                >
                  <div className="ag-runtime-card__head">
                    <span className="ag-runtime-card__name">{name}</span>
                    <span className={sourceBadgeClass(s.source)}>{SKILL_SOURCE_LABEL[s.source]}</span>
                  </div>
                  <div className="ag-runtime-card__meta">{s.description}</div>
                  {s.trigger ? (
                    <div className="ag-runtime-card__meta" style={{ opacity: 0.7 }}>
                      触发：{s.trigger}
                    </div>
                  ) : null}
                  <div className="ag-runtime-card__chips">
                    {!s.enabled ? <span className="ag-chip ag-chip--muted">已停用（agent 侧不可见）</span> : null}
                    {shadowed ? (
                      <span className="ag-chip ag-chip--muted">已被{SKILL_SOURCE_LABEL[s.overriddenBy!]}覆盖</span>
                    ) : null}
                  </div>
                  {!shadowed ? (
                    <div className="ag-runtime-card__actions" style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <button type="button" className="ag-btn ag-btn--mini" onClick={() => onPrefill(name)}>
                        填入输入框
                      </button>
                      <button type="button" className="ag-btn ag-btn--mini" onClick={() => void toggleEnabled(s)}>
                        {s.enabled ? "停用" : "启用"}
                      </button>
                      {s.source !== "workdir" ? (
                        <button type="button" className="ag-btn ag-btn--mini" onClick={() => openEdit(s)}>
                          编辑
                        </button>
                      ) : null}
                      {s.source === "team" ? (
                        hasBuiltin ? (
                          <button
                            type="button"
                            className="ag-btn ag-btn--mini ag-btn--ghost"
                            title="移除团队级覆盖，回到内置默认"
                            onClick={() => setResetTarget(s)}
                          >
                            <RotateCcw size={12} aria-hidden="true" /> 恢复默认
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ag-btn ag-btn--mini ag-btn--ghost"
                            onClick={() => setDeleteTarget(s)}
                          >
                            删除
                          </button>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            }),
          )}
        </div>
      )}
    </div>
  );
}
