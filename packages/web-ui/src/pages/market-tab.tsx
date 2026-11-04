/**
 * @fengagent/web-ui — Settings「市场」tab（插件市场接入 · C）
 *
 * 浏览/搜索市场目录（消费 `/api/plugins/market`，服务端搜索分页），按三档兼容
 * 徽标展示：A（fengagent.webui）即装即渲染、B（dsh host 侧 tools/services）装后
 * 需重启、C（dsh.client 界面插件）装得上但界面不渲染——C 档默认折叠成独立分区。
 * 安装走 POST /api/plugins/install 的 `{market:{name,version}}` 通道（spec 由
 * 服务端从 catalog 策展解析，前端不自由拼 npm spec）。
 *
 * 后端市场 API 未装配（404 / 无后端）时回退 fixture 目录（market-mock.ts），
 * `?mock=1` 强制 fixture；已装态与 `/api/plugins` 列表联动。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Download, Loader2, RefreshCw, Store } from "lucide-react";
import { ApiError, type ApiClient } from "../api/client.ts";
import { queryMarketMock } from "../api/market-mock.ts";
import type { MarketCategory, MarketEntry } from "../api/types.ts";

/** ?mock=1 强制 fixture 目录（与 teams 页同一约定） */
const FORCE_MOCK = new URLSearchParams(window.location.search).get("mock") === "1";

/** 目录分页大小 */
const PAGE_SIZE = 24;

/** 搜索防抖毫秒数 */
const SEARCH_DEBOUNCE_MS = 300;

/** 取条目描述（双语对象取中文，缺则回退英文；字符串原样） */
function entryDescription(e: MarketEntry): string {
  if (typeof e.description === "string") return e.description;
  return e.description.zh || e.description.en || "";
}

/** compat 三档徽标（A/B/C） */
function CompatBadge({ compat }: { compat: MarketEntry["compat"] }): ReactNode {
  if (compat === "webui") {
    return (
      <span className="ag-badge ag-badge--ok" title="声明 fengagent.webui，装上即渲染">
        A · 即装即用
      </span>
    );
  }
  if (compat === "dsh") {
    return (
      <span
        className="ag-badge ag-badge--pending"
        title="dsh host 侧 tools/services，经 dsh-compat 装载，装后需重启宿主"
      >
        B · 装后需重启
      </span>
    );
  }
  if (compat === "dsh-client") {
    return (
      <span
        className="ag-badge ag-badge--muted"
        title="dsh 客户端协议 UI 插件，装得上但界面不渲染（对照组）"
      >
        C · 界面不渲染
      </span>
    );
  }
  return <span className="ag-badge ag-badge--muted">未识别</span>;
}

interface MarketTabProps {
  client: ApiClient;
}

export function MarketTab({ client }: MarketTabProps): ReactNode {
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [category, setCategory] = useState("");
  const [entries, setEntries] = useState<MarketEntry[]>([]);
  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<"live" | "fixture">("live");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string[]>([]);
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(new Set());
  const [showClient, setShowClient] = useState(false);
  /** 筛选变化后让在途的过期响应失效 */
  const reloadSeq = useRef(0);

  // 搜索防抖：输入 300ms 后才触发查询
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(
    async (offset: number) => {
      const params = { q: debouncedQ || undefined, category: category || undefined, limit: PAGE_SIZE, offset };
      const seq = ++reloadSeq.current;
      try {
        let body;
        let nextMode: "live" | "fixture" = "live";
        if (FORCE_MOCK) {
          body = queryMarketMock(params);
          nextMode = "fixture";
        } else {
          try {
            body = await client.getMarketCatalog(params);
          } catch (err) {
            // 404 / 无后端（HTML 回退导致 JSON 解析失败）视为市场 API 未装配 → fixture；
            // 其余（500 等）是真实错误，原样上抛
            const absent = err instanceof ApiError ? err.status === 404 : true;
            if (!absent) throw err;
            body = queryMarketMock(params);
            nextMode = "fixture";
          }
        }
        if (!Array.isArray(body.entries)) throw new Error("市场目录响应格式异常（entries 非数组）");
        if (seq !== reloadSeq.current) return; // 过期响应（筛选已变），丢弃
        setMode(nextMode);
        setCategories(body.categories ?? []);
        setTotal(body.total);
        setEntries((prev) => (offset === 0 ? body.entries : [...prev, ...body.entries]));
        setError(null);
      } catch (err) {
        if (seq !== reloadSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === reloadSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [client, debouncedQ, category],
  );

  // 筛选/搜索变化 → 回到第一页重查
  useEffect(() => {
    setLoading(true);
    void fetchPage(0);
  }, [fetchPage]);

  /** 已装态联动：读 /api/plugins，按包名与去 scope 的 id 匹配 */
  const reloadInstalled = useCallback(async () => {
    try {
      const body = await client.listPlugins();
      const keys = new Set<string>();
      for (const p of body.plugins) {
        keys.add(p.name);
        keys.add(p.id);
      }
      setInstalledKeys(keys);
    } catch {
      // 已装态联动失败不阻塞市场页（后端未装配时只是缺「已安装」标记）
    }
  }, [client]);

  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

  const install = useCallback(
    async (entry: MarketEntry) => {
      if (installing.includes(entry.name)) return;
      setInstalling((prev) => [...prev, entry.name]);
      setError(null);
      setNotice(null);
      try {
        await client.installPluginFromMarket(entry.name, entry.version);
        const suffix =
          entry.compat === "webui"
            ? "WebUI 插件即时生效"
            : entry.compat === "dsh"
              ? "工具/服务面需重启宿主后装载"
              : "dsh.client 界面插件：装得上，但界面不渲染（对照组）";
        setNotice(`已安装 ${entry.name}@${entry.version}（${suffix}）`);
        await reloadInstalled();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInstalling((prev) => prev.filter((n) => n !== entry.name));
      }
    },
    [client, installing, reloadInstalled],
  );

  const isInstalled = useCallback(
    (e: MarketEntry) => installedKeys.has(e.name) || installedKeys.has(e.name.split("/").pop() ?? e.name),
    [installedKeys],
  );

  /** A/B 档进主列表；C 档（dsh.client）折叠到底部独立分区 */
  const mainEntries = useMemo(() => entries.filter((e) => e.compat !== "dsh-client"), [entries]);
  const clientEntries = useMemo(() => entries.filter((e) => e.compat === "dsh-client"), [entries]);
  const hasMore = entries.length < total;
  const categoryTitle = (id: string): string => categories.find((c) => c.id === id)?.title.zh ?? id;

  const renderCard = (e: MarketEntry): ReactNode => {
    const busy = installing.includes(e.name);
    const installed = isInstalled(e);
    return (
      <article
        key={e.name}
        className={`ag-runtime-card mk-card ${e.compat === "dsh-client" ? "mk-card--dim" : ""}`}
        data-testid="market-card"
        data-market-name={e.name}
      >
        <div className="ag-runtime-card__head">
          <span className="ag-runtime-card__name mk-card__name" title={e.name}>
            {e.title || e.name}
          </span>
          <CompatBadge compat={e.compat} />
        </div>
        <div className="mk-card__pkg">
          <code>{e.name}</code> · v{e.version} · {categoryTitle(e.category)}
        </div>
        <p className="mk-card__desc">{entryDescription(e)}</p>
        <div className="mk-card__actions">
          {installed ? (
            <span className="ag-badge ag-badge--ok">已安装</span>
          ) : (
            <button
              type="button"
              className="ag-btn ag-btn--mini ag-btn--primary"
              disabled={busy}
              onClick={() => void install(e)}
            >
              {busy ? (
                <Loader2 className="ag-page__spin" size={12} aria-hidden="true" />
              ) : (
                <Download size={12} aria-hidden="true" />
              )}
              安装
            </button>
          )}
          {e.homepage ? (
            <a className="ag-btn ag-btn--mini ag-btn--ghost" href={e.homepage} target="_blank" rel="noreferrer">
              主页
            </a>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <div className="ag-section">
      <div className="tm-libhead">
        <h2 className="ag-section__title">
          <Store size={14} aria-hidden="true" /> 市场
        </h2>
        {mode === "fixture" ? (
          <span
            className="ag-badge ag-badge--muted"
            title="后端市场 API（/api/plugins/market）未装配，当前展示内置 fixture 目录"
          >
            离线目录（fixture）
          </span>
        ) : (
          <span className="ag-badge ag-badge--ok">已连市场</span>
        )}
        <button
          type="button"
          className="ag-btn ag-btn--ghost"
          onClick={() => {
            setLoading(true);
            void fetchPage(0);
            void reloadInstalled();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" /> 刷新
        </button>
      </div>

      {error ? <div className="ag-page__hint ag-page__hint--error">{error}</div> : null}
      {notice ? <div className="ag-page__hint">{notice}</div> : null}

      <div className="ag-form__row">
        <input
          className="ag-form__select"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索市场插件（名称 / 描述）"
          aria-label="搜索市场插件"
        />
      </div>

      <div className="ag-filter tm-subnav">
        {[{ id: "", title: { zh: "全部", en: "" } }, ...categories].map((c) => (
          <button
            key={c.id || "all"}
            type="button"
            className={`ag-filter__chip tm-subnav__chip ${category === c.id ? "ag-filter__chip--active" : ""}`}
            onClick={() => setCategory(c.id)}
          >
            {c.title.zh}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="ag-page__empty">
          <Loader2 className="ag-page__spin" size={16} aria-hidden="true" /> 加载中…
        </div>
      ) : entries.length === 0 ? (
        <div className="ag-page__empty">没有匹配的市场插件</div>
      ) : (
        <>
          <div className="mk-card__pkg">
            共 {total} 个{debouncedQ || category ? "（按当前筛选）" : ""}
          </div>
          <div className="mk-grid">{mainEntries.map(renderCard)}</div>
          {hasMore ? (
            <div className="ag-form__actions">
              <button
                type="button"
                className="ag-btn ag-btn--ghost"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void fetchPage(entries.length);
                }}
              >
                {loadingMore ? (
                  <Loader2 className="ag-page__spin" size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
                加载更多（{entries.length}/{total}）
              </button>
            </div>
          ) : null}
          {clientEntries.length > 0 ? (
            <div className="mk-clientfold">
              <button
                type="button"
                className="ag-btn ag-btn--ghost ag-btn--mini"
                onClick={() => setShowClient((v) => !v)}
              >
                {showClient ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                {showClient ? "收起" : "展开"} dsh.client 界面插件（{clientEntries.length} 个 · 装得上但界面不渲染）
              </button>
              {showClient ? <div className="mk-grid">{clientEntries.map(renderCard)}</div> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
