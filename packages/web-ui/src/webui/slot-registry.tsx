/**
 * @fengagent/web-ui — Slot 注册表 + SlotHost（S1）
 *
 * `WebUiProvider` 挂在应用根部：启动时装载 WebUI 插件（manifest → import →
 * registerSlot），把注册进来的组件按 slotId 存进注册表；`<SlotHost slotId>`
 * 在任意位置渲染该 slot 的全部插件组件（按注册序，错误边界隔离）。
 *
 * 后端未装配（manifest 不可达）时注册表为空——SlotHost 渲染 null，宿主零影响。
 */

import {
  Component,
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { loadWebUiPlugins } from "./module-loader.ts";
import type { WebUiSlotId } from "./plugin-context.ts";

/** slot → 插件组件列表（注册序） */
type SlotRegistry = Map<string, Array<{ pluginId: string; component: ComponentType }>>;

interface WebUiState {
  registry: SlotRegistry;
  /** 装载诊断（null = 尚未完成/不可用） */
  ready: boolean;
}

const WebUiContext = createContext<WebUiState>({ registry: new Map(), ready: false });

/** 极简 toast（S1；S2 的 primitives 会正式化） */
type ToastItem = { id: number; text: string; kind: "info" | "error" };
let toastSeq = 0;
let pushToast: ((item: ToastItem) => void) | null = null;

function toast(text: string, kind: "info" | "error" = "info"): void {
  pushToast?.({ id: ++toastSeq, text, kind });
}

function ToastViewport(): ReactNode {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (item) => {
      setItems((prev) => [...prev, item]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== item.id)), 4000);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="webui-toast-viewport" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`webui-toast webui-toast--${item.kind}`}>
          {item.text}
        </div>
      ))}
    </div>
  );
}

/**
 * WebUI 插件宿主：挂应用根部，装载插件并下发注册表。
 * 后端未装配时静默空转（零影响）。
 */
export function WebUiProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<WebUiState>({ registry: new Map(), ready: false });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const registry: SlotRegistry = new Map();
      await loadWebUiPlugins({
        registerSlot: (slotId, component, pluginId) => {
          if (component === null || typeof component !== "function") return;
          const list = registry.get(slotId) ?? [];
          list.push({ pluginId, component: component as ComponentType });
          registry.set(slotId, list);
        },
        toast,
      });
      if (alive) setState({ registry, ready: true });
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <WebUiContext.Provider value={state}>
      {children}
      <ToastViewport />
    </WebUiContext.Provider>
  );
}

/**
 * 渲染某个 slot 的全部插件组件（错误边界隔离：单个插件组件抛错只渲染错误占位）。
 */
export function SlotHost({ slotId }: { slotId: WebUiSlotId }): ReactNode {
  const { registry } = useContext(WebUiContext);
  const entries = registry.get(slotId);
  if (!entries || entries.length === 0) return null;
  return (
    <>
      {entries.map(({ pluginId, component: Component }) => (
        <SlotBoundary key={`${pluginId}:${slotId}`} pluginId={pluginId}>
          <Component />
        </SlotBoundary>
      ))}
    </>
  );
}

/** 单插件错误边界（class 组件——React 无 hook 版错误边界） */

interface BoundaryProps {
  pluginId: string;
  children: ReactNode;
}
interface BoundaryState {
  error: Error | null;
}

class SlotBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.warn(`[webui] slot 组件渲染失败（${this.props.pluginId}）: ${error.message}`);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <div className="webui-slot-error">插件 {this.props.pluginId} 渲染失败（已隔离）</div>;
    }
    return this.props.children;
  }
}
