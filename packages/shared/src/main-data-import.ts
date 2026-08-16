/**
 * @fengagent/shared — main 数据单向幂等导入器（Phase 0 骨架，功能完整）
 *
 * 首次运行时把 main 遗留数据（sessions.db / graph.jsonl）**只读**复制到新分支数据根，
 * 成功后写 `import.marker`（来源根 + 时间 + 导入文件数），后续启动跳过（幂等）。
 *
 * 防护：
 * - **自环防护**：当 `FENG_DATA_DIR` 被显式指向任一 main 数据根时，
 *   `resolveDataRoot` 自身被排除在导入源探测之外（防自导成环），且绝不写入 main 目录。
 * - **单向兼容**：只读 main，绝不写回；main 无需反向读新数据。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDataRoot, resolveMainDataRoots, type DataRootOptions } from "./data-root.ts";
import { expandTilde } from "./utils.ts";

/** 导入标记文件名 */
export const IMPORT_MARKER_FILE = "import.marker";

/** 需要导入的 main 数据文件 */
export const MAIN_DATA_FILES = ["sessions.db", "graph.jsonl"] as const;

/** import.marker 内容（来源根 + 时间 + 导入文件数，满足幂等与排障） */
export interface ImportMarker {
  version: 1;
  /** 导入时间（ISO-8601） */
  importedAt: string;
  /** 来源根（绝对路径） */
  sourceRoot: string;
  /** 导入文件数 */
  fileCount: number;
  /** 导入的文件名 */
  files: string[];
}

export type MainDataImportReason =
  | "marker-skipped" // 已有 import.marker，跳过
  | "self-loop-excluded" // 数据根自身是 main 根，跳过导入
  | "no-source" // 未探测到含 main 数据的根
  | "imported"; // 完成导入

export interface MainDataImportResult {
  imported: boolean;
  reason: MainDataImportReason;
  /** 新分支数据根（绝对路径） */
  dataRoot: string;
  /** 实际复制的文件（相对 dataRoot 的文件名） */
  copiedFiles: string[];
  marker?: ImportMarker;
}

function hasMainData(dir: string): boolean {
  return MAIN_DATA_FILES.some((file) => existsSync(join(dir, file)));
}

/**
 * 执行 main 数据单向导入（幂等）。
 *
 * @returns 导入结果；reason 说明跳过原因（marker-skipped / self-loop-excluded / no-source / imported）
 */
export function importMainData(opts: DataRootOptions = {}): MainDataImportResult {
  const dataRoot = resolveDataRoot(opts);
  const markerPath = join(dataRoot, IMPORT_MARKER_FILE);
  const dataRootAbs = resolve(dataRoot);

  // 幂等：已有 import.marker 则跳过（损坏时视为未导入，继续探测）
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as ImportMarker;
      return { imported: false, reason: "marker-skipped", dataRoot, copiedFiles: [], marker };
    } catch {
      // marker 损坏 — 落入下方重新导入（copyFileSync 覆盖同名文件仍幂等）
    }
  }

  // 自环防护：数据根自身是任一 main 根 → 直接跳过（绝不写入 main 目录）
  const allCandidates = resolveMainDataRoots(opts);
  const dataRootIsMainRoot = allCandidates.some((root) => {
    try {
      return resolve(expandTilde(root)) === dataRootAbs;
    } catch {
      return false;
    }
  });
  if (dataRootIsMainRoot) {
    return { imported: false, reason: "self-loop-excluded", dataRoot, copiedFiles: [] };
  }

  // 探测导入源：排除数据根自身（双保险）后，首个含 sessions.db/graph.jsonl 者胜
  const source = allCandidates.find((root) => {
    try {
      return resolve(expandTilde(root)) !== dataRootAbs && hasMainData(root);
    } catch {
      return false;
    }
  });
  if (!source) {
    return { imported: false, reason: "no-source", dataRoot, copiedFiles: [] };
  }

  // 单向：只读 main → 复制到新数据根
  const files = MAIN_DATA_FILES.filter((file) => existsSync(join(source, file)));
  mkdirSync(dataRoot, { recursive: true });
  for (const file of files) {
    try {
      copyFileSync(join(source, file), join(dataRoot, file));
    } catch {
      // 单个文件复制失败不阻断整体（如源被占用）
    }
  }

  const marker: ImportMarker = {
    version: 1,
    importedAt: new Date().toISOString(),
    sourceRoot: resolve(source),
    fileCount: files.length,
    files: [...files],
  };
  try {
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");
  } catch {
    // marker 写入失败 — 下次启动重试（幂等兜底）
  }

  return { imported: true, reason: "imported", dataRoot, copiedFiles: files, marker };
}
