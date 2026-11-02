/**
 * @fengagent/web-ui — WebUI 插件 primitives（S2）
 *
 * 从现有 `ag-*` 设计体系导出的可复用 UI 原语，供插件 client.mjs 经
 * `ctx.primitives` 使用（与宿主同源样式，不引新 UI 库）。react 共享单例
 * （`window.__FENG_REACT__`）——插件不自带 react。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

/** 下拉菜单（点击触发，点击外部关闭） */
export function Menu({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="webui-menu" ref={ref}>
      <button type="button" className="webui-menu__trigger" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open ? <div className="webui-menu__content">{children}</div> : null}
    </div>
  );
}

/** 悬停提示 */
export function Tooltip({ text, children }: { text: string; children: ReactNode }): ReactNode {
  return (
    <span className="webui-tooltip" data-tooltip={text}>
      {children}
    </span>
  );
}

/** 折叠行（details/summary 的受控替代） */
export function DisclosureRow({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`webui-disclosure ${open ? "webui-disclosure--open" : ""}`}>
      <button type="button" className="webui-disclosure__summary" onClick={() => setOpen((v) => !v)}>
        <span className="webui-disclosure__chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open ? <div className="webui-disclosure__body">{children}</div> : null}
    </div>
  );
}

/** primitives 清单（挂到插件 ctx.primitives） */
export const webUiPrimitives = { Menu, Tooltip, DisclosureRow };
