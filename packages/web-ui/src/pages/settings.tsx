/**
 * @fengagent/web-ui — Settings 页（S2）
 *
 * 四 tab（通用/模型/插件/关于）的分段骨架 + 插件管理 tab（消费 `/api/plugins`
 * CRUD API，按 docs/PLUGINS.md 契约）。模型 tab 等 S3 的 `settings/model` API；
 * 通用/关于 tab 先落最小可用（主题切换 + 版本/健康）。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, Package, RefreshCw, Settings as SettingsIcon, Upload } from "lucide-react";
import type { Theme } from "../lib/theme.ts";

/* ------------------------------ 插件 API 契约 ------------------------------ */

interface PluginEntry {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  source: string;
  installedAt?: string;
  bundleUrl?: string;
  slots?: string[];
  error?: string;
}

interface PluginsResponse {
  plugins: PluginEntry[];
  errors: Array<{ id: string; error: string }>;
  pluginsRoot: string;
  revision: number;
  restartRequired: boolean;
}

/* ------------------------------ 页面 ------------------------------ */

type SettingsTab = "general" | "model" | "plugins" | "about";

interface SettingsPageProps {
  theme: Theme;
  onSelectTheme: (t: Theme) => void;
}

export function SettingsPage({ theme, onSelectTheme }: SettingsPageProps): ReactNode {
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

      {tab === "plugins" ? <PluginsTab /> : null}
      {tab === "general" ? <GeneralTab theme={theme} onSelectTheme={onSelectTheme} /> : null}
      {tab === "model" ? <ModelTabPlaceholder /> : null}
      {tab === "about" ? <AboutTab /> : null}
    </section>
  );
}

/* ------------------------------ 插件 tab ------------------------------ */

function PluginsTab(): ReactNode {
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins", { headers: { Accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}（插件管理 API 未装配？）`);
      }
      setData((await res.json()) as PluginsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const install = useCallback(async () => {
    const source = installSource.trim();
    if (source === "" || installing) return;
    setInstalling(true);
    setNotice(null);
    try {
      const res = await fetch("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof body.error === "string" ? body.error : body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setInstallSource("");
      setNotice("安装成功（WebUI 插件即时生效；工具/服务面需重启宿主）");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, [installSource, installing, reload]);

  const toggle = useCallback(
    async (id: string, action: "enable" | "disable") => {
      try {
        const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/${action}`, { method: "POST" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
          const msg = typeof body.error === "string" ? body.error : body.error?.message ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
          const msg = typeof body.error === "string" ? body.error : body.error?.message ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload],
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
                      onClick={() => void toggle(p.id, p.enabled ? "disable" : "enable")}
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

/* ------------------------------ 模型 tab（S3 占位） ------------------------------ */

function ModelTabPlaceholder(): ReactNode {
  return (
    <div className="ag-section">
      <h2 className="ag-section__title">模型</h2>
      <div className="ag-page__empty">
        模型参数 / provider 配置面在 S3 落地（`GET/PATCH /api/settings/model`），
        当前请用 TUI 的 /model、/provider 命令或 FENG_* 环境变量。
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
