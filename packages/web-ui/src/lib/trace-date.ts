/**
 * @fengagent/web-ui — trace 日期解析工具
 *
 * 聊天页「查看调用链/评测」deep-link 只携带 sessionId + messageId，
 * 而 per-message 查询 API 需要日期。此工具从 trace 文件列表反查
 * 包含目标会话的最新日期（最新在前，最多扫描 14 个文件，本地工具足够）。
 */

import type { ApiClient } from "../api/client.ts";

/** 查找包含指定会话的最新 trace 日期；找不到返回 null */
export async function findSessionTraceDate(
  client: ApiClient,
  sessionId: string,
): Promise<string | null> {
  const traces = await client.listTraces();
  // listTraces 按日期升序，反转为最新在前
  const dates = [...traces].reverse().map((t) => t.date);
  for (const date of dates.slice(0, 14)) {
    try {
      const cc = await client.getCallChains(date);
      if (cc.sessions.some((s) => s.sessionId === sessionId)) {
        return date;
      }
    } catch {
      // 跳过损坏/不存在的文件
    }
  }
  return null;
}
