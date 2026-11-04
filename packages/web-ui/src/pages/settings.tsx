/**
 * @fengagent/web-ui — Settings 页（S2）
 *
 * 五 tab（插件/市场/通用/模型/关于）的分段骨架 + 插件管理 tab（消费 `/api/plugins`
 * CRUD API，按 docs/PLUGINS.md 契约）+ 市场 tab（消费 `/api/plugins/market`，
 * 插件市场接入 · C）。模型 tab 等 S3 的 `settings/model` API；通用/关于 tab 先落
 * 最小可用（主题切换 + 版本/健康）。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, Package, RefreshCw, Settings as SettingsIcon, Upload } from "lucide-react";
import { ApiError, type ApiClient } from "../api/client.ts";
import type { PluginsListResponse } from "../api/types.ts";
import type { Theme } from "../lib/theme.ts";
import { MarketTab } from "./market-tab.tsx";

/* ------------------------------ 页面 ------------------------------ */

type SettingsTab = "general" | "model" | "plugins" | "market" | "about";

interface SettingsPageProps {
  client: ApiClient;
  theme: Theme;
  onSelectTheme: (t: Theme) => void;
}

export function SettingsPage({ client, theme, onSelectTheme }: SettingsPageProps): ReactNode {
  const [tab, setTab] = useState<SettingsTab>("plugins");

  return (
    <section className="ag-page">
      <header className="ag-page__header">
        <div>
          <h1 className="ag-page__title">
            <SettingsIcon className="ag-page__title-icon" aria-hidden="true" />
            设置
          </h1>
          <p className="ag-page__subtitle">模型参数、插件管理与系统信息</p>
        </div>
      </header>

      <div className="ag-filter tm-subnav" role="tablist">
        {(
          [
            ["plugins", "插件"],
            ["market", "市场"],
            ["general", "通用"],
            ["model", "模型"],
            ["about", "关于"],
          ] as Array<[SettingsTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`ag-filter__chip tm-subnav__chip ${tab === key ? "ag-filter__chip--active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "plugins" ? <PluginsTab client={client} /> : null}
      {tab === "market" ? <MarketTab client={client} /> : null}
      {tab === "general" ? <GeneralTab theme={theme} onSelectTheme={onSelectTheme} /> : null}
      {tab === "model" ? <ModelTab /> : null}
      {tab === "about" ? <AboutTab /> : null}
    </section>
  );
}

/* ------------------------------ 插件 tab ------------------------------ */

function PluginsTab({ client }: { client: ApiClient }): ReactNode {
  const [data, setData] = useState<PluginsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await client.listPlugins());
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 404
          ? "HTTP 404（插件管理 API 未装配？）"
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const install = useCallback(async () => {
    const source = installSource.trim();
    if (source === "" || installing) return;
    setInstalling(true);
    setNotice(null);
    try {
      await client.installPluginFromSource(source);
      setInstallSource("");
      setNotice("安装成功（WebUI 插件即时生效；工具/服务面需重启宿主）");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, [client, installSource, installing, reload]);

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await client.setPluginEnabled(id, enabled);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await client.uninstallPlugin(id);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, reload],
  );

  const entries = useMemo(() => data?.plugins ?? [], [data]);

  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <h2 className="ag-section__title">
          <Package size={14} aria-hidden="true" /> 插件
        </h2>
        <button type="button" className="ag-btn ag-btn--ghost" onClick={() => void reload()}>
          <RefreshCw size={14} aria-hidden="true" /> 刷新
        </button>
      </div>

      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}
      {notice ? <div className="ag-page__hint">{notice}</div> : null}
      {data?.restartRequired ? (
        <div className="ag-page__hint">插件变更后需重启宿主进程，工具/服务面才会重新装载</div>
      ) : null}

      <div className="ag-form">
        <div className="ag-form__row">
          <label className="ag-form__label" htmlFor="tm-plugin-source">
            安装源（本地目录或 .tgz 路径）
          </label>
          <input
            id="tm-plugin-source"
            className="ag-form__select"
            value={installSource}
            onChange={(e) => setInstallSource(e.target.value)}
            placeholder="如 D:\plugins\my-plugin 或 D:\pkgs\my-plugin-1.0.0.tgz"
          />
        </div>
        <div className="ag-form__actions">
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={installing || installSource.trim() === ""}
            onClick={() => void install()}
          >
            {installing ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
            安装
          </button>
        </div>
      </div>

      {loading && entries.length === 0 ? (
        <div className="ag-page__empty">
          <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
        </div>
      ) : entries.length === 0 && !loading ? (
        <div className="ag-page__empty">
          暂无已装插件（放入插件目录或经上方安装源装入；WebUI 插件在
          package.json 里声明 fengagent.webui 即被 manifest 收录）
        </div>
      ) : (
        <div className="ag-page__table-wrap">
          <table className="ag-page__table">
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>版本</th>
                <th>状态</th>
                <th>来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((p) => (
                <tr key={p.id} className="ag-row">
                  <td className="ag-row__id" title={p.id}>{p.id}</td>
                  <td>{p.name}</td>
                  <td>{p.version}</td>
                  <td>
                    <span className={`ag-badge ${p.enabled ? "ag-badge--ok" : "ag-badge--muted"}`}>
                      {p.enabled ? "启用" : "停用"}
                    </span>
                    {p.error ? <span className="ag-badge ag-badge--error" title={p.error}>异常</span> : null}
                  </td>
                  <td className="ag-row__content" title={p.source}>
                    {p.source.length > 36 ? `${p.source.slice(0, 36)}…` : p.source}
                  </td>
                  <td className="ag-row__actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="ag-btn ag-btn--mini"
                      onClick={() => void toggle(p.id, !p.enabled)}
                    >
                      {p.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="ag-btn ag-btn--mini ag-btn--ghost"
                      onClick={() => void remove(p.id)}
                    >
                      卸载
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 通用 tab ------------------------------ */

function GeneralTab({ theme, onSelectTheme }: { theme: Theme; onSelectTheme: (t: Theme) => void }): ReactNode {
  return (
    <div className="ag-section">
      <h2 className="ag-section__title">通用</h2>
      <div className="ag-form__row">
        <span className="ag-form__label">主题</span>
        <div className="tm-modebar__switch">
          {(["light", "dark", "cyber"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tm-modebar__opt ${theme === t ? "tm-modebar__opt--on" : ""}`}
              onClick={() => onSelectTheme(t)}
            >
              {t === "light" ? "浅色" : t === "dark" ? "深色" : "Cyber"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 模型 tab（S3） ------------------------------ */

interface ProviderField {
  key: string;
  label: string;
  type: string;
  env?: string;
  required?: boolean;
  locked?: boolean;
  configured?: boolean;
  value?: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  description?: string;
  active?: boolean;
  configured?: boolean;
  models?: string[];
  fields?: ProviderField[];
}

interface ModelSettingsSnapshot {
  settings: Record<string, unknown>;
  sources: Record<string, string>;
  envLocked: string[];
  overridden?: string[];
  applyError?: string | null;
  active?: Record<string, unknown>;
}

/** 掩码 secret（后端打码格式，如 `sk-a****`）——不回填 form、不提交 */
const MASKED_SECRET = /\*{3,}$/;

function ModelTab(): ReactNode {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [snap, setSnap] = useState<ModelSettingsSnapshot | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySnapshot = useCallback((body: ModelSettingsSnapshot) => {
    setSnap(body);
    setForm((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(body.settings)) {
        if (typeof v !== "string" && typeof v !== "number") continue;
        // 掩码 secret 不回填 form——防止保存时把 `sk-a****` 覆盖真实 Key
        if (typeof v === "string" && MASKED_SECRET.test(v)) continue;
        next[k] = String(v);
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pRes, mRes] = await Promise.all([
        fetch("/api/settings/providers"),
        fetch("/api/settings/model"),
      ]);
      if (pRes.ok) {
        const body = (await pRes.json()) as { providers?: ProviderInfo[] };
        setProviders(body.providers ?? []);
      }
      if (mRes.ok) {
        applySnapshot((await mRes.json()) as ModelSettingsSnapshot);
      }
      if (!pRes.ok && !mRes.ok) throw new Error("模型设置 API 未装配（settings/model 路由缺失？）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applySnapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProvider = form["provider"] ?? snap?.active?.["provider"] ?? "";
  const providerInfo = providers?.find((p) => p.id === selectedProvider);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of ["provider", "model", "smallModel", "fallbackModel", "maxTokens", "temperature", "contextWindow", "compactThreshold"]) {
        const v = form[key];
        if (v === undefined || v === "") continue;
        if (["maxTokens", "contextWindow", "compactThreshold"].includes(key)) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) patch[key] = n;
        } else if (key === "temperature") {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 2) patch[key] = n;
        } else {
          patch[key] = v;
        }
      }
      for (const f of providerInfo?.fields ?? []) {
        const v = form[f.key];
        if (v === undefined || v === "" || f.locked) continue;
        // 掩码值不提交（后端打码的 `****` 不是真实 Key）
        if (typeof v === "string" && MASKED_SECRET.test(v)) continue;
        patch[f.key] = v;
      }
      const res = await fetch("/api/settings/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string } | string;
        snapshot?: ModelSettingsSnapshot;
      };
      if (!res.ok) {
        const msg = typeof body.error === "string" ? body.error : body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      if (body.snapshot) applySnapshot(body.snapshot);
      if (body.snapshot?.applyError) {
        setNotice("已保存，重启后生效（当前进程应用失败）");
      } else if (body.snapshot?.overridden && body.snapshot.overridden.length > 0) {
        const keys = body.snapshot.overridden.join("、");
        setNotice(`已保存（${keys} 被环境变量覆盖，实际仍用环境变量值）`);
      } else {
        setNotice("已保存并热切换（下一轮对话即用新模型）");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [saving, form, providerInfo, applySnapshot]);

  const sourceBadge = (key: string): ReactNode => {
    if (snap?.envLocked?.includes(key)) {
      return <span className="ag-badge ag-badge--muted" title="环境变量锁定，改 UI 不生效">env 锁定</span>;
    }
    if (snap?.sources?.[key] === "settings") {
      return <span className="ag-badge ag-badge--ok" title="来自 settings.json">已保存</span>;
    }
    return null;
  };

  return (
    <div className="ag-section">
      <h2 className="ag-section__title">模型</h2>
      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}
      {notice ? <div className="ag-page__hint">{notice}</div> : null}

      <div className="ag-form">
        <div className="ag-form__row">
          <label className="ag-form__label" htmlFor="tm-set-provider">Provider</label>
          <select
            id="tm-set-provider"
            className="ag-form__select"
            value={form["provider"] ?? ""}
            disabled={snap?.envLocked?.includes("provider")}
            onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value }))}
          >
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}{p.configured ? "" : "（未配置）"}
              </option>
            ))}
          </select>
          {sourceBadge("provider")}
        </div>

        <div className="ag-form__row">
          <label className="ag-form__label" htmlFor="tm-set-model">模型</label>
          <input
            id="tm-set-model"
            className="ag-form__select"
            list="tm-set-model-suggestions"
            value={form["model"] ?? ""}
            disabled={snap?.envLocked?.includes("model")}
            onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
          />
          <datalist id="tm-set-model-suggestions">
            {(providerInfo?.models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {sourceBadge("model")}
        </div>

        <div className="ag-form__row">
          <label className="ag-form__label" htmlFor="tm-set-max-tokens">maxTokens</label>
          <input
            id="tm-set-max-tokens"
            className="ag-form__select"
            type="number"
            value={form["maxTokens"] ?? ""}
            disabled={snap?.envLocked?.includes("maxTokens")}
            onChange={(e) => setForm((p) => ({ ...p, maxTokens: e.target.value }))}
          />
        </div>

        <div className="ag-form__row">
          <label className="ag-form__label" htmlFor="tm-set-temperature">temperature</label>
          <input
            id="tm-set-temperature"
            className="ag-form__select"
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={form["temperature"] ?? ""}
            disabled={snap?.envLocked?.includes("temperature")}
            onChange={(e) => setForm((p) => ({ ...p, temperature: e.target.value }))}
          />
        </div>

        {(providerInfo?.fields ?? []).map((f) => (
          <div className="ag-form__row" key={f.key}>
            <label className="ag-form__label" htmlFor={`tm-set-${f.key}`}>
              {f.label}
              {f.required ? " *" : ""}
            </label>
            <input
              id={`tm-set-${f.key}`}
              className="ag-form__select"
              type={f.type === "secret" ? "password" : "text"}
              value={form[f.key] ?? ""}
              disabled={f.locked}
              placeholder={f.locked ? "由环境变量提供" : f.configured ? "已配置（留空保持不变）" : f.env ? `env: ${f.env}` : ""}
              onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
            />
            {f.locked ? <span className="ag-badge ag-badge--muted">env 锁定</span> : null}
          </div>
        ))}

        <div className="ag-form__actions">
          <button type="button" className="ag-btn ag-btn--primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="ag-page__spin" size={14} aria-hidden="true" /> : null}
            保存（热切换）
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 关于 tab ------------------------------ */

function AboutTab(): ReactNode {
  const [health, setHealth] = useState<{ status?: string; version?: string } | null>(null);
  useEffect(() => {
    void fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setHealth(j))
      .catch(() => setHealth(null));
  }, []);
  return (
    <div className="ag-section">
      <h2 className="ag-section__title">关于</h2>
      <div className="ag-runtime-card">
        <div className="ag-runtime-card__head">
          <span className="ag-runtime-card__name">FengAgentCli</span>
          <span className={`ag-dot ${health?.status === "ok" ? "ag-dot--ok" : "ag-dot--muted"}`} />
        </div>
        <div className="ag-runtime-card__meta">
          {health ? `健康 ${health.status ?? "—"} · ${health.version ?? ""}` : "健康接口不可达（本地开发模式？）"}
        </div>
        <div className="ag-runtime-card__meta">API 基址 {window.location.origin}</div>
      </div>
    </div>
  );
}
