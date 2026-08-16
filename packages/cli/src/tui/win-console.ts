/**
 * @fengagent/cli — Windows 控制台 UTF-8 适配
 *
 * Windows 中文系统默认控制台代码页为 936（GBK）。Ink TUI 以 UTF-8 向 stdout
 * 输出，若控制台输出代码页不是 65001，ConPTY 会把 UTF-8 字节按 GBK 解码，
 * 导致中文/emoji 乱码。启动时把控制台输入/输出代码页切到 65001 即可修复。
 *
 * 仅影响控制台显示，不改变任何文件读写编码。
 */

import { dlopen } from "bun:ffi";

/** 是否已尝试过（避免重复 dlopen） */
let attempted = false;

/**
 * 确保 Windows 控制台使用 UTF-8 代码页（65001）。
 *
 * 通过 bun:ffi 调用 kernel32 的 SetConsoleOutputCP / SetConsoleCP。
 * 非 Windows 平台直接返回；失败静默忽略（不影响主流程）。
 */
export function ensureWindowsConsoleUtf8(): void {
  if (process.platform !== "win32" || attempted) return;
  attempted = true;
  try {
    const kernel32 = dlopen("kernel32.dll", {
      SetConsoleOutputCP: { args: ["u32"], returns: "bool" },
      SetConsoleCP: { args: ["u32"], returns: "bool" },
    });
    kernel32.symbols.SetConsoleOutputCP(65001);
    kernel32.symbols.SetConsoleCP(65001);
  } catch {
    // 非关键路径：失败仅影响 Windows 控制台中文回显，不影响主流程
  }
}
