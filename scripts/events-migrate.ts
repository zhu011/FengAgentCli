/**
 * @fengagent — 事件溯源迁移 CLI（导出 / 导入 / 重建 / 对账）
 *
 * 把 `packages/events` 的 Phase 3 能力暴露成命令行，方便小白直接照抄操作。
 * 数据根默认 = `resolveDataRoot()`（`FENG_DATA_DIR` > 配置 dataDir > `<workdir>/.fengagent-cordis`）。
 *
 * 用法（Windows 与 Linux/macOS 通用，在项目根目录执行）：
 *   bun run scripts/events-migrate.ts list                      # 列出有事件日志的会话
 *   bun run scripts/events-migrate.ts export --dir ./export     # 整库导出（每会话一个 .fengevents.jsonl）
 *   bun run scripts/events-migrate.ts export --session <id> --dir ./export   # 导出单个会话
 *   bun run scripts/events-migrate.ts import ./export           # 导入可移植事件文件（幂等去重）
 *   bun run scripts/events-migrate.ts rebuild [--prune]         # 以事件为准重建读模型（SQLite）
 *   bun run scripts/events-migrate.ts verify                    # 事件链校验 + 双写对账（投影 === 读模型）
 */

import { EventStore } from "../packages/events/src/index.ts";
import {
  exportSessionEvents,
  exportStoreEvents,
  importSessionEvents,
  importStoreEvents,
  type EventExportHeader,
} from "../packages/events/src/index.ts";
import { rebuildAll, rebuildSession, type RebuildSummary } from "../packages/events/src/index.ts";
import { reconcileAll, reconcileSession, verifyEventChain } from "../packages/events/src/index.ts";
import { SessionStore } from "../packages/agent/src/session.ts";
import { resolveDataRoot } from "../packages/shared/src/data-root.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/* ------------------------------ 参数解析 ------------------------------ */

interface CliOptions {
  dir?: string;
  session?: string;
  prune?: boolean;
}

function parseArgs(argv: string[]): { command: string; options: CliOptions; positional: string[] } {
  const options: CliOptions = {};
  const positional: string[] = [];
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dir" || arg === "--dir=") {
      if (arg === "--dir") {
        options.dir = argv[++i];
      }
    } else if (arg.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
    } else if (arg === "--session" || arg === "--session=") {
      if (arg === "--session") {
        options.session = argv[++i];
      }
    } else if (arg.startsWith("--session=")) {
      options.session = arg.slice("--session=".length);
    } else if (arg === "--prune") {
      options.prune = true;
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if (arg.startsWith("-")) {
      console.error(`未知参数: ${arg}\n运行 bun run scripts/events-migrate.ts --help 查看用法。`);
      process.exit(1);
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, options, positional };
}

/* ------------------------------ 数据根 / 存储 ------------------------------ */

function openStores() {
  const dataRoot = resolveDataRoot();
  // 与生产装配一致（createRuntimeAgent）：先确保数据根存在，SQLite 才能建库
  mkdirSync(join(dataRoot, "events"), { recursive: true });
  const events = new EventStore({ dir: join(dataRoot, "events") });
  const legacy = new SessionStore(join(dataRoot, "sessions.db"));
  return { dataRoot, events, legacy };
}

function printHeader(header: EventExportHeader, filePath: string): void {
  console.log(`  导出文件: ${filePath}`);
  console.log(`    sessionId : ${header.sessionId}`);
  console.log(`    eventCount: ${header.eventCount} 条`);
  console.log(`    seq       : ${header.firstSeq} → ${header.lastSeq}`);
  console.log(`    lastHash  : ${header.lastHash.slice(0, 16)}…`);
}

/* ------------------------------ 各子命令 ------------------------------ */

function cmdList(events: EventStore): void {
  const ids = events.listSessionIds();
  if (ids.length === 0) {
    console.log("事件日志为空：还没有任何会话产生过事件（先对话一轮，或先执行 import）。");
    return;
  }
  console.log(`事件日志会话 (${ids.length}):`);
  for (const id of ids) {
    const evs = events.replay(id);
    console.log(`  ${id}  (${evs.length} 条事件, seq ${evs[0]?.seq ?? "-"}→${evs[evs.length - 1]?.seq ?? "-"})`);
  }
}

function cmdExport(events: EventStore, options: CliOptions): void {
  const outDir = resolve(options.dir ?? "./events-export");
  mkdirSync(outDir, { recursive: true });

  if (options.session) {
    const filePath = join(outDir, `${options.session}.fengevents.jsonl`);
    const header = exportSessionEvents(events, options.session, filePath);
    console.log(`已导出会话 ${options.session} 的事件:`);
    printHeader(header, filePath);
    return;
  }

  const written = exportStoreEvents(events, outDir);
  if (written.length === 0) {
    console.log("事件日志为空，没有可导出的会话。");
    return;
  }
  console.log(`已导出 ${written.length} 个会话的事件到: ${outDir}`);
  for (const file of written) {
    console.log(`  ${file}`);
  }
  console.log("\n提示: 这些 .fengevents.jsonl 是机器无关的可移植文件，");
  console.log("可复制到另一台机器 / 另一数据根，用 import 子命令导入。");
}

function cmdImport(events: EventStore, dir: string): void {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`导入目录不存在: ${absDir}`);
    process.exit(1);
  }
  const summary = importStoreEvents(events, absDir);
  console.log(`导入结果 (${absDir}):`);
  console.log(`  成功导入: ${summary.imported} 个会话`);
  console.log(`  幂等跳过: ${summary.skipped} 个会话`);
  console.log(`  失败拒绝: ${summary.failed} 个会话`);
  for (const f of summary.failures) {
    console.log(`    ✗ ${f.file}: ${f.error}`);
  }
  console.log("\n提示: 导入只写事件日志。执行 rebuild 后，SQLite 读模型才会以事件为准重建。");
}

function cmdRebuild(events: EventStore, legacy: SessionStore, options: CliOptions): void {
  if (options.session) {
    const r = rebuildSession(events, legacy, options.session);
    if (!r.ok) {
      console.error(`重建失败: 会话 ${options.session} 无事件（或缺少 session/created）。`);
      process.exit(1);
    }
    console.log(`已重建会话 ${options.session} 的读模型:`);
    console.log(`  title      : ${r.session!.title}`);
    console.log(`  model      : ${r.session!.model}`);
    console.log(`  messages   : ${r.session!.messages.length} 条`);
    console.log(`  tokenCount : ${r.session!.tokenCount}`);
    return;
  }

  const summary: RebuildSummary = rebuildAll(events, legacy, { prune: options.prune });
  console.log("以事件为准重建读模型（SQLite）:");
  console.log(`  成功重建: ${summary.rebuilt.length} 个会话`);
  console.log(`  无事件跳过: ${summary.failed.length} 个会话`);
  if (options.prune) {
    console.log(`  清理孤儿(prune): ${summary.pruned.length} 个会话`);
    for (const id of summary.pruned) console.log(`    ✂ ${id}`);
  }
  console.log("\n提示: 重建只读事件日志 + 写读模型，绝不追加事件（事件文件字节级不变）。");
}

function cmdVerify(events: EventStore, legacy: SessionStore, options: CliOptions): void {
  const ids = options.session ? [options.session] : events.listSessionIds();

  // 1) 事件链完整性（seq 连续 + #5 hash 链）
  console.log("① 事件链校验（seq 连续 + hash/prevHash 链）:");
  let chainOk = true;
  for (const id of ids) {
    const evs = events.replay(id);
    const problems = verifyEventChain(evs);
    if (problems.length > 0) {
      chainOk = false;
      console.log(`    ✗ ${id}: ${problems.join("; ")}`);
    } else {
      console.log(`    ✓ ${id}: ${evs.length} 条事件，链完整`);
    }
  }

  // 2) 双写对账（事件投影 === 旧存储逐条等价）
  console.log("\n② 双写对账（事件投影 === SQLite 读模型）:");
  if (options.session) {
    const r = reconcileSession(events, legacy, options.session);
    if (r.ok) {
      console.log(`    ✓ ${options.session}: 一致`);
    } else {
      for (const d of r.diffs) console.log(`    ✗ ${options.session} ${d.field}: ${d.detail}`);
    }
    return;
  }
  const summary = reconcileAll(events, legacy, ids);
  console.log(`    参与对账: ${summary.total} 个会话`);
  if (summary.ok) {
    console.log("    ✓ 全部一致（投影 === 读模型）");
  } else {
    for (const id of summary.failed) console.log(`    ✗ ${id}: 存在差异`);
  }
  if (!chainOk || !summary.ok) process.exitCode = 1;
}

function cmdHelp(): void {
  console.log(`事件溯源迁移 CLI — 导出 / 导入 / 重建 / 对账

用法（项目根目录）:
  bun run scripts/events-migrate.ts <命令> [选项]

命令:
  list                     列出有事件日志的会话
  export [--dir <目录>]    整库导出（每会话一个 .fengevents.jsonl）
  export --session <id>    导出单个会话
  import <目录>            导入可移植事件文件（幂等去重，只写事件日志）
  rebuild [--prune]        以事件为准重建读模型（SQLite；--prune 清理孤儿会话）
  verify [--session <id>]  事件链校验 + 双写对账（投影 === 读模型）

数据根: resolveDataRoot() — FENG_DATA_DIR > 配置 dataDir > <workdir>/.fengagent-cordis`);
}

/* ------------------------------ 入口 ------------------------------ */

async function main(): Promise<void> {
  const { command, options, positional } = parseArgs(process.argv.slice(2));

  if (command === "help" || !command) {
    cmdHelp();
    return;
  }

  const { dataRoot, events, legacy } = openStores();
  console.log(`数据根: ${dataRoot}\n`);

  switch (command) {
    case "list":
      cmdList(events);
      break;
    case "export":
      cmdExport(events, options);
      break;
    case "import": {
      const dir = options.dir ?? positional[0];
      if (!dir) {
        console.error("用法: bun run scripts/events-migrate.ts import <目录>");
        process.exit(1);
      }
      cmdImport(events, dir);
      break;
    }
    case "rebuild":
      cmdRebuild(events, legacy, options);
      break;
    case "verify":
      cmdVerify(events, legacy, options);
      break;
    default:
      console.error(`未知命令: ${command}\n运行 bun run scripts/events-migrate.ts --help 查看用法。`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("执行失败:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
