export type Json = Record<string, any>;

export class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** One envelope of GET /api/v1/stream. */
export interface StreamItem { cursor: string; type: string; sessionId: string | null; data: Json }

/** Agent Bridge's public API with the connector's own agent token; nothing privileged. */
export class ControlClient {
  constructor(private readonly base: string, private readonly token: string) {}

  async call(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Json> {
    const response = await fetch(`${this.base}/api/v1${path}`, { method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    const value = text ? JSON.parse(text) as Json : {};
    if (!response.ok) throw new ControlError(response.status, value.error?.code ?? `http_${response.status}`, value.error?.message ?? response.statusText);
    return value;
  }

  /** An accepted action's final result; failed actions throw their error code. */
  async settle(action: Json, timeoutMs = 60_000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    while (action.status === "accepted") {
      if (Date.now() > deadline) throw new ControlError(504, "action_outcome_unknown", "动作仍在处理中，结果未知");
      await new Promise((resolve) => setTimeout(resolve, 300));
      action = await this.call("GET", `/actions/${encodeURIComponent(action.actionId)}`);
    }
    if (action.status !== "succeeded") {
      const error = action.error?.error ?? action.error ?? {};
      throw new ControlError(409, error.code ?? "action_failed", error.message ?? "action failed");
    }
    return action;
  }

  /** Follow the stream from `cursor` until `signal` aborts; resolves when the connection ends. */
  async stream(cursor: string | undefined, signal: AbortSignal, onItem: (item: StreamItem) => void): Promise<void> {
    const url = `${this.base}/api/v1/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) {
      const value = await response.json().catch(() => ({})) as Json;
      throw new ControlError(response.status, value.error?.code ?? `http_${response.status}`, value.error?.message ?? "stream failed");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data) onItem(JSON.parse(data) as StreamItem);
      }
    }
  }
}
