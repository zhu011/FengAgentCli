/**
 * @fengagent/cli — `@` 文件路径补全（T2）
 *
 * 输入里出现 `@<部分路径>` 时弹路径补全（相对 workdir），↑↓ 选择、Tab/Enter
 * 补全、Esc 关闭——与 `/` 命令面板同一交互。纯函数拆出供测试。
 */

import { readdirSync } from "node:fs";
import { isAbsolute, join, dirname, basename, sep } from "node:path";

/** 路径补全可视行数 */
export const MAX_PATH_VISIBLE = 8;

/** 从输入值里提取正在编辑的 `@` 路径 token（无则 null） */
export function extractAtToken(value: string): { dir: string; prefix: string } | null {
  const at = value.lastIndexOf("@");
  if (at === -1) return null;
  // @ 必须在行首或前面是空白，否则是邮箱/普通字符
  if (at > 0 && !/\s/.test(value[at - 1]!)) return null;
  const token = value.slice(at + 1);
  // token 里出现空白 → 路径已结束，不再补全
  if (/\s/.test(token)) return null;
  // 相对 workdir 的目录前缀 + 文件名前缀（支持 a/b/c 前缀过滤）
  const dir = token.includes("/") ? token.slice(0, token.lastIndexOf("/")) : "";
  const prefix = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
  return { dir, prefix };
}

export interface PathEntry {
  /** 补全插入的名字（目录带尾 / ） */
  name: string;
  /** 是否目录 */
  isDir: boolean;
}

/** 列目录并按前缀过滤（目录带 `/` 后缀）。失败返回空（目录不存在/无权限）。 */
export function listPathEntries(workdir: string, dir: string, prefix: string): PathEntry[] {
  const base = isAbsolute(dir) ? dir : join(workdir, dir);
  let names: Array<{ name: string; isDir: boolean }>;
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.name.startsWith(prefix))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  // 目录优先 + 字典序；目录名补 `/` 后缀便于继续层级补全
  names.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return names.map((n) => ({ name: n.isDir ? `${n.name}/` : n.name, isDir: n.isDir }));
}

/** 应用补全：把 value 里最后的 `@token` 替换为 `@dir/completion` */
export function applyAtCompletion(value: string, completion: string): string {
  const at = value.lastIndexOf("@");
  if (at === -1) return value;
  const token = value.slice(at + 1);
  const dir = token.includes("/") ? token.slice(0, token.lastIndexOf("/") + 1) : "";
  return `${value.slice(0, at + 1)}${dir}${completion}`;
}

/** dirname/basename 的便捷再导出（测试用） */
export const pathUtils = { dirname, basename, sep };
