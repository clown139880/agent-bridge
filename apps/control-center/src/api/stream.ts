import { validEnvelope } from "./client";
import type { Envelope } from "./types";

export class StreamLimitError extends Error {}

/** Incremental SSE parser. A cursor is delivered only with a complete, valid frame. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private id = "";
  private event = "";
  private bytes = 0;
  constructor(private onEvent: (e: Envelope) => void, private onRetry: (ms: number) => void,
    private limit = 4 * 1024 * 1024) {}
  push(text: string, final = false) {
    this.buffer += text;
    if (this.buffer.length * 2 + this.bytes > this.limit) throw new StreamLimitError("单条流内容过大，请改用历史分页查看");
    for (;;) {
      const end = this.buffer.search(/[\r\n]/);
      if (end < 0) break;
      if (this.buffer[end] === "\r" && end === this.buffer.length - 1 && !final) break;
      const line = this.buffer.slice(0, end);
      const size = this.buffer[end] === "\r" && this.buffer[end + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(end + size);
      this.line(line);
    }
  }
  private line(line: string) {
    if (!line) {
      if (this.data.length && (!this.event || this.event === "bridge.event")) {
        const value: unknown = JSON.parse(this.data.join("\n"));
        if (!validEnvelope(value) || !this.id || value.cursor !== this.id) throw new Error("事件流格式无效");
        this.onEvent(value);
      }
      this.data = []; this.event = ""; this.id = ""; this.bytes = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") { this.data.push(value); this.bytes += line.length * 2; }
    if (field === "event") this.event = value;
    if (field === "id" && !value.includes("\0")) this.id = value;
    if (field === "retry" && /^\d+$/.test(value)) this.onRetry(Math.max(1000, Math.min(30_000, Number(value))));
    if (this.bytes > this.limit) throw new StreamLimitError("流缓冲已满，请改用历史分页查看");
  }
}

export async function consumeStream(response: Response, signal: AbortSignal, onEvent: (e: Envelope) => void,
  onRetry: (ms: number) => void) {
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const queue: Envelope[] = [];
  let queuedBytes = 0, lastByte = Date.now();
  const parser = new SseParser(e => {
    queue.push(e); queuedBytes += JSON.stringify(e).length * 2;
    if (queue.length > 500 || queuedBytes > 4 * 1024 * 1024) throw new StreamLimitError("内容更新过快，请重试或加载历史");
  }, onRetry);
  const watchdog = setInterval(() => { if (Date.now() - lastByte > 60_000) void reader.cancel(); }, 5000);
  const cancel = () => { void reader.cancel(); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastByte = Date.now();
      parser.push(decoder.decode(value, { stream: true }));
      // Bound parsing work and yield between network chunks, while applying each frame in order.
      for (const event of queue) { if (signal.aborted) return; onEvent(event); }
      queue.length = 0; queuedBytes = 0;
    }
    if (!signal.aborted) throw new Error("实时连接中断，正在恢复");
  } finally {
    clearInterval(watchdog); signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}
