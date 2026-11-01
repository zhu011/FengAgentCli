/**
 * @fengagent/dsh-compat — `ctx.fs` 服务面（P3 收尾 / trivial-shim）
 *
 * dsh 的 `FileSystem`（`@deepseek-ai/dsh-fs`）是一个**可替换的宿主能力缝**：
 * 工具不直接碰 `node:fs`，而是先把模型给的路径 `resolve()` 成稳定 target，
 * 再用 `stat` / `readText` / `writeText` / `editText` 操作，错误统一走
 * `FsError` 的 `FS_*` code（工具层据此给出权限/陈旧/二进制等结构化错误）。
 *
 * 本实现是该缝的**本机后端**：语义按 `@deepseek-ai/dsh-fs@0.1.0-rc.6` 的面写，
 * 并补齐 0.2.x 新增的 `readByteRange`（多实现一个方法不影响老插件）。
 * 这正是 `dsh-better-edit`、`dsh-tool-fs`、`dsh-tool-str-replace-editor`
 * `inject: ["fs"]` 要求在位的那个服务。
 *
 * 已知偏差（写进 `docs/DSH-CONTRACT-MAP.md` §10）：
 * 1. **不装沙箱**：`sandboxMode` 恒为 `undefined`（= 不限制），`sandboxPolicy`
 *    参数接受但忽略。权限/沙箱在 FengAgentCli 自己的工具层（`FENG_ALLOWED_TOOLS`
 *    等）执行；兼容层不冒充第二道沙箱。
 * 2. `version` 是 `size:mtimeMs` 的派生串，不是 inode 级身份——同尺寸同毫秒
 *    的两次写入在极端情况下会撞版本（本机写路径是 tmp+rename，概率极低）。
 * 3. `editText` 只做**字面量**替换（与 dsh 契约一致：先比版本再匹配），
 *    不做行尾归一化；`FS_STALE_VERSION` / `FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND`
 *    三个错误码按上游语义抛。
 */

import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 与 dsh 同名的错误码（工具层按 code 分支，不解析 message） */
export type FsErrorCode =
  | "FS_NOT_FOUND"
  | "FS_NOT_DIRECTORY"
  | "FS_NOT_TEXT"
  | "FS_NOT_REGULAR_FILE"
  | "FS_TOO_LARGE"
  | "FS_PERMISSION_DENIED"
  | "FS_SANDBOX_DENIED"
  | "FS_IO_ERROR"
  | "FS_STALE_VERSION"
  | "FS_NOT_OBSERVED"
  | "FS_AMBIGUOUS_EDIT"
  | "FS_EDIT_NOT_FOUND"
  | "FS_ABORTED";

/**
 * 类型化文件系统错误。
 *
 * 不 import `@deepseek-ai/dsh-fs` 的 `FsError`（它继承 `@deepseek-ai/dsh-llm` 的
 * `HarnessError`，会把兼容层钉到某个 rc 的运行时上）；结构上带 `code` 字段，
 * 消费方（`better-edit` 的 `mapFsError` 等）按 `error.code` 分支即可。
 */
export class FsShimError extends Error {
  constructor(
    message: string,
    readonly code: FsErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FsError";
  }
}

/** 稳定 target（`targetKey` 不透明，消费方不得解析） */
export interface FsTarget {
  readonly targetKey: string;
  readonly displayPath: string;
}

/** `stat` 的返回值 */
export interface FsInfo {
  readonly version: string;
  readonly type: "file" | "directory" | "other";
  readonly size?: number;
}

/** `lstat` 的返回值 */
export interface FsPathInfo {
  readonly version: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size?: number;
}

/** 目录项 */
export interface FsDirEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
  readonly target: FsTarget;
  readonly version?: string;
  readonly size?: number;
}

/** 写入意图 */
export type FsWriteIntent =
  | { readonly kind: "createIfAbsent" }
  | { readonly kind: "replaceIfVersion"; readonly version: string };

/** 写入结果 */
export interface FsWriteOutcome {
  readonly operation: "create" | "update";
  readonly version: string;
  readonly before: string | null;
  readonly after: string;
}

/** 字面量编辑请求 */
export interface FsEditRequest {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

/** 编辑结果 */
export interface FsEditOutcome {
  readonly version: string;
  readonly before: string;
  readonly after: string;
}

/** 本机文件系统后端（dsh `ctx.fs` 的兼容实现） */
export class LocalFileSystemCompat {
  /**
   * 本后端不装载沙箱：`undefined` 表示「不限制」（与 dsh 的裸本机后端一致）。
   * 工具层的沙箱来自 FengAgentCli 自己的权限栈，不在这里重复。
   */
  get sandboxMode(): undefined {
    return undefined;
  }

  /**
   * 把路径解析成稳定 target：存在的路径取 realpath，不存在的取规范化绝对路径。
   *
   * @param path - 路径（可相对）
   * @param opts - 可选 cwd 与取消信号
   * @returns 稳定 target
   */
  async resolve(
    path: string,
    opts: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<FsTarget> {
    throwIfAborted(opts.signal);
    const absolute = isAbsolute(path) ? path : resolvePath(opts.cwd ?? process.cwd(), path);
    let stable = absolute;
    try {
      stable = await realpath(absolute);
    } catch {
      // 不存在的路径：用规范化绝对路径当身份（create 场景）
    }
    return { targetKey: stable, displayPath: stable };
  }

  /** target 在本机执行世界里的绝对路径 */
  processPath(target: FsTarget): string {
    return target.targetKey;
  }

  /** target 的 `file:` URI */
  fileUrl(target: FsTarget): string {
    return pathToFileURL(target.targetKey).href;
  }

  /** 规范化包含关系（child 是否等于 parent 或在其下） */
  contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = relative(parent.targetKey, child.targetKey);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  /**
   * 元数据；不存在返回 `undefined`（与 dsh 契约一致，不抛错）。
   *
   * @param target - 已解析的 target
   * @param signal - 取消信号
   */
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    throwIfAborted(signal);
    try {
      const info = await stat(target.targetKey);
      return {
        version: versionOf(info),
        type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
        ...(info.isFile() ? { size: info.size } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw mapIoError(error, target);
    }
  }

  /**
   * 不跟随最后一段符号链接的元数据；不存在返回 `undefined`。
   *
   * @param path - 路径（可相对）
   * @param opts - 可选 cwd
   * @param signal - 取消信号
   */
  async lstat(
    path: string,
    opts: { cwd?: string } = {},
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    throwIfAborted(signal);
    const absolute = isAbsolute(path) ? path : resolvePath(opts.cwd ?? process.cwd(), path);
    try {
      const info = await lstat(absolute);
      return {
        version: versionOf(info),
        type: info.isSymbolicLink()
          ? "symlink"
          : info.isFile()
            ? "file"
            : info.isDirectory()
              ? "directory"
              : "other",
        ...(info.isFile() ? { size: info.size } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw mapIoError(error, { targetKey: absolute, displayPath: absolute });
    }
  }

  /**
   * 整文件按 UTF-8 解码读出；目录 / 二进制 / 非普通文件按错误码拒绝。
   *
   * @param target - 已解析的 target
   * @param signal - 取消信号
   */
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const info = await this.requireFile(target, signal);
    if (info.size !== undefined && info.size > MAX_TEXT_BYTES) {
      throw new FsShimError(
        `file is larger than the text read limit (${info.size} > ${MAX_TEXT_BYTES} bytes): ${target.displayPath}`,
        "FS_TOO_LARGE",
      );
    }
    const bytes = await readFile(target.targetKey);
    return decodeUtf8(bytes, target);
  }

  /**
   * 流式读出（本机实现按块切同一份解码后的文本；语义与 `readText` 一致）。
   *
   * @param target - 已解析的 target
   * @param signal - 取消信号
   */
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal);
    return (async function* stream() {
      for (let offset = 0; offset < text.length; offset += STREAM_CHUNK_CHARS) {
        throwIfAborted(signal);
        yield text.slice(offset, offset + STREAM_CHUNK_CHARS);
      }
    })();
  }

  /**
   * 原始字节读出（不做解码 / 二进制拒绝），超过 `maxBytes` 报 `FS_TOO_LARGE`。
   *
   * @param target - 已解析的 target
   * @param signal - 取消信号
   * @param maxBytes - 允许的最大字节数
   */
  async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    throwIfAborted(signal);
    const info = await this.requireFile(target, signal);
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsShimError(
        `file exceeds the requested byte cap (${info.size} > ${maxBytes} bytes): ${target.displayPath}`,
        "FS_TOO_LARGE",
      );
    }
    const bytes = await readFile(target.targetKey);
    if (bytes.byteLength > maxBytes) {
      throw new FsShimError(
        `file exceeds the requested byte cap (${bytes.byteLength} > ${maxBytes} bytes): ${target.displayPath}`,
        "FS_TOO_LARGE",
      );
    }
    return new Uint8Array(bytes);
  }

  /**
   * 读取字节区间（dsh 0.2.x 新增面）。
   *
   * @param target - 已解析的 target
   * @param range - `{ offset, length }`
   * @param signal - 取消信号
   */
  async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal);
    await this.requireFile(target, signal);
    if (!Number.isInteger(range.offset) || range.offset < 0) {
      throw new FsShimError(`invalid range offset: ${range.offset}`, "FS_IO_ERROR");
    }
    if (!Number.isInteger(range.length) || range.length < 0) {
      throw new FsShimError(`invalid range length: ${range.length}`, "FS_IO_ERROR");
    }
    const handle = await open(target.targetKey, "r");
    try {
      const buffer = Buffer.alloc(range.length);
      const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  /**
   * 列出目录直接子项（按名字排序，不读文件内容）。
   *
   * @param target - 目录 target
   * @param signal - 取消信号
   */
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    throwIfAborted(signal);
    const info = await this.stat(target, signal);
    if (!info) {
      throw new FsShimError(`directory not found: ${target.displayPath}`, "FS_NOT_FOUND");
    }
    if (info.type !== "directory") {
      throw new FsShimError(`not a directory: ${target.displayPath}`, "FS_NOT_DIRECTORY");
    }
    const dirents = await readdir(target.targetKey, { withFileTypes: true });
    const entries: FsDirEntry[] = [];
    for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childPath = resolvePath(target.targetKey, dirent.name);
      const childInfo = await this.stat({ targetKey: childPath, displayPath: childPath }, signal);
      entries.push({
        name: dirent.name,
        type: childInfo?.type ?? "other",
        target: {
          targetKey: childInfo ? childPath : childPath,
          displayPath: childPath,
        },
        ...(childInfo === undefined ? {} : { version: childInfo.version }),
        ...(childInfo?.size === undefined ? {} : { size: childInfo.size }),
      });
    }
    return entries;
  }

  /**
   * 原子写入（同目录 tmp + rename），带 `createIfAbsent` / `replaceIfVersion` 守卫。
   *
   * @param target - 已解析的 target
   * @param content - 完整新内容（UTF-8）
   * @param expected - 写入意图（省略 = 无条件覆盖）
   * @param signal - 取消信号
   * @param sandboxPolicy - 接受但忽略（见文件头偏差 1）
   */
  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: unknown,
  ): Promise<FsWriteOutcome> {
    throwIfAborted(signal);
    const current = await this.stat(target, signal);
    if (expected?.kind === "createIfAbsent" && current !== undefined) {
      throw new FsShimError(
        `file already exists (createIfAbsent): ${target.displayPath}`,
        "FS_NOT_OBSERVED",
      );
    }
    if (expected?.kind === "replaceIfVersion") {
      if (current === undefined) {
        throw new FsShimError(
          `file is absent (replaceIfVersion): ${target.displayPath}`,
          "FS_STALE_VERSION",
        );
      }
      if (current.version !== expected.version) {
        throw new FsShimError(
          `file changed since it was observed: ${target.displayPath}`,
          "FS_STALE_VERSION",
        );
      }
    }

    let before: string | null = null;
    if (current?.type === "file") {
      try {
        before = await this.readText(target, signal);
      } catch {
        before = null; // 二进制 / 过大：按契约给 null，不做偏袒式降级
      }
    }

    await mkdir(dirname(target.targetKey), { recursive: true });
    const tmpPath = `${target.targetKey}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, content, "utf8");
      await rename(tmpPath, target.targetKey);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw mapIoError(error, target);
    }

    const after = await this.stat(target, signal);
    if (!after) {
      throw new FsShimError(`write did not publish a file: ${target.displayPath}`, "FS_IO_ERROR");
    }
    return {
      operation: current === undefined ? "create" : "update",
      version: after.version,
      before,
      after: content,
    };
  }

  /**
   * 字面量编辑：先比版本（陈旧即 `FS_STALE_VERSION`），再按 `replaceAll` 决定
   * 唯一匹配（否则 `FS_AMBIGUOUS_EDIT`）或无匹配（`FS_EDIT_NOT_FOUND`）。
   *
   * @param target - 已解析的 target
   * @param edit - 字面量替换请求
   * @param expected - 版本守卫（省略 = 不校验）
   * @param signal - 取消信号
   * @param sandboxPolicy - 接受但忽略
   */
  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: string },
    signal?: AbortSignal,
    _sandboxPolicy?: unknown,
  ): Promise<FsEditOutcome> {
    throwIfAborted(signal);
    if (edit.oldString.length === 0) {
      throw new FsShimError("oldString must be non-empty", "FS_EDIT_NOT_FOUND");
    }
    const current = await this.requireFile(target, signal);
    if (expected !== undefined && current.version !== expected.version) {
      throw new FsShimError(
        `file changed since it was observed: ${target.displayPath}`,
        "FS_STALE_VERSION",
      );
    }
    const before = await this.readText(target, signal);
    const occurrences = countOccurrences(before, edit.oldString);
    if (occurrences === 0) {
      throw new FsShimError(
        `literal text not found in ${target.displayPath}`,
        "FS_EDIT_NOT_FOUND",
      );
    }
    if (!edit.replaceAll && occurrences > 1) {
      throw new FsShimError(
        `literal text appears ${occurrences} times in ${target.displayPath}; pass replaceAll or a longer anchor`,
        "FS_AMBIGUOUS_EDIT",
      );
    }
    const after = edit.replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString);
    const outcome = await this.writeText(target, after, undefined, signal);
    return { version: outcome.version, before, after };
  }

  /** 文件存在且是普通文件，返回它的元数据 */
  private async requireFile(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal);
    if (!info) {
      throw new FsShimError(`file not found: ${target.displayPath}`, "FS_NOT_FOUND");
    }
    if (info.type !== "file") {
      throw new FsShimError(
        `not a regular file (${info.type}): ${target.displayPath}`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    return info;
  }
}

/** 文本读上限（超过建议走 streamText；与 dsh 本机后端的量级一致） */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** 流式切块大小（字符） */
const STREAM_CHUNK_CHARS = 64 * 1024;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * 严格 UTF-8 解码：非法字节报 `FS_NOT_TEXT`（与 dsh 的二进制拒绝一致）。
 *
 * @param bytes - 原始字节
 * @param target - 用于错误消息的 target
 */
function decodeUtf8(bytes: Uint8Array, target: FsTarget): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new FsShimError(`not a UTF-8 text file: ${target.displayPath}`, "FS_NOT_TEXT", {
      cause: error,
    });
  }
}

/** 版本串：`size:mtimeMs`（见文件头偏差 2） */
function versionOf(info: { size: number; mtimeMs: number }): string {
  return `${info.size}:${Math.round(info.mtimeMs * 1000)}`;
}

/** 文件不存在的 ENOENT 判定 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** 把 node 的 errno 映射成 dsh 错误码 */
function mapIoError(error: unknown, target: FsTarget): FsShimError {
  const code = (error as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return new FsShimError(`path not found: ${target.displayPath}`, "FS_NOT_FOUND", {
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FsShimError(`permission denied: ${target.displayPath}`, "FS_PERMISSION_DENIED", {
      cause: error,
    });
  }
  if (code === "ENOTDIR") {
    return new FsShimError(`not a directory: ${target.displayPath}`, "FS_NOT_DIRECTORY", {
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return new FsShimError(`is a directory: ${target.displayPath}`, "FS_NOT_REGULAR_FILE", {
      cause: error,
    });
  }
  return new FsShimError(
    `filesystem error${code === undefined ? "" : ` (${code})`}: ${target.displayPath}`,
    "FS_IO_ERROR",
    { cause: error },
  );
}

/** 统计字面量出现次数（非重叠） */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 取消信号检查和 dsh 的 `FS_ABORTED` 对齐 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new FsShimError("operation aborted", "FS_ABORTED", { cause: signal.reason });
  }
}

/** 供测试/诊断：判断一个路径是否可写（不创建文件） */
export async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 供测试/诊断：把 `file:` URI 还原成本机路径 */
export function pathFromFileUrl(url: string): string {
  return fileURLToPath(url);
}

/** 目录分隔符（导出给文档示例，避免消费方各自猜） */
export const PATH_SEPARATOR = sep;
