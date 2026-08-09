/**
 * @fengagent/llm — 流式事件解析工具
 *
 * SSE 帧解析、provider-specific 事件统一化。
 */

import type { LLMEvent } from "./types.ts";

export interface SSEFrame {
  event: string;
  data: string;
}

export function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<SSEFrame>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  async function pump(): Promise<void> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            const frame = parseFrame(buffer.trim());
            if (frame) controller.enqueue(frame);
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType = "";
        let dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line.trim() === "") {
            if (dataLines.length > 0) {
              const frame = parseFrame(dataLines.join("\n"));
              if (frame) {
                controller.enqueue({ ...frame, event: frame.event || eventType });
              }
              eventType = "";
              dataLines = [];
            }
          }
        }
      }
    } catch (err) {
      controller.error(err);
    }
  }

  return pump();
}

function parseFrame(data: string): SSEFrame | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  if (trimmed === "[DONE]") return { event: "done", data: "[DONE]" };
  return { event: "", data: trimmed };
}

export async function* sseToEvents(
  body: ReadableStream<Uint8Array> | null,
  parser: (data: string) => LLMEvent | null,
): AsyncGenerator<LLMEvent> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        } else if (line.trim() === "" && dataLines.length > 0) {
          const dataContent = dataLines.join("\n").trim();
          if (dataContent && dataContent !== "[DONE]") {
            const event = parser(dataContent);
            if (event) yield event;
          }
          dataLines = [];
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* collectStream(
  stream: AsyncGenerator<LLMEvent>,
): AsyncGenerator<LLMEvent, LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    yield event;
  }
  return events;
}
