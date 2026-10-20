import { randomUUID } from "node:crypto";

/** The Control API base (http://host:port, no /api/v1) and the caller's own Bearer token. */
export interface ClientConfig { url: string; token: string }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export type Json = Record<string, any>;

/** One frame of /api/v1/stream. */
export interface StreamEnvelope {
  cursor: string; eventId: string; type: string; timestamp: number;
  resource: { kind: string; id: string }; sessionId: string | null; data: Json;
}

export class ControlClient {
  constructor(private readonly config: ClientConfig) {}

  async get(path: string, query?: Record<string, string | number | boolean | string[] | undefined>): Promise<Json> {
    const url = new URL(`${this.config.url}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    return this.request("GET", url);
  }

  /** Writes are actions: each call carries a fresh Idempotency-Key. */
  async post(path: string, body: unknown): Promise<Json> {
    return this.request("POST", new URL(`${this.config.url}/api/v1${path}`), body);
  }

  /** Wait for an action receipt to settle; failed actions throw. */
  async settle(receipt: Json, timeoutMs = 130_000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    let action = receipt;
    while (action.status === "accepted") {
      if (Date.now() > deadline) throw new ApiError(504, "action_timeout", `action ${action.actionId} did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      action = await this.get(`/actions/${encodeURIComponent(action.actionId)}`);
    }
    if (action.status === "failed") {
      const error = action.error?.error ?? {};
      throw new ApiError(409, error.code ?? "action_failed", error.message ?? "action failed", action);
    }
    return action;
  }

  /** The SSE stream from `cursor`, optionally narrowed to one session, until `signal` aborts. */
  async *stream(options: { cursor?: string; sessionId?: string; signal?: AbortSignal }): AsyncGenerator<StreamEnvelope> {
    const url = new URL(`${this.config.url}/api/v1/stream`);
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    if (options.sessionId) url.searchParams.set("sessionId", options.sessionId);
    const response = await fetch(url, { headers: this.headers({ accept: "text/event-stream" }), signal: options.signal });
    if (!response.ok || !response.body) throw await this.failure(response);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data) yield JSON.parse(data) as StreamEnvelope;
      }
    }
    throw new ApiError(503, "stream_closed", "the event stream closed");
  }

  private async request(method: string, url: URL, body?: unknown): Promise<Json> {
    const headers = this.headers(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": randomUUID() });
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw await this.failure(response);
    return await response.json() as Json;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.config.token}`, ...extra };
  }

  private async failure(response: Response): Promise<ApiError> {
    const text = await response.text().catch(() => "");
    try {
      const error = (JSON.parse(text) as Json).error;
      if (error && typeof error === "object") return new ApiError(response.status, error.code, error.message, error.details);
    } catch { /* not JSON */ }
    return new ApiError(response.status, `http_${response.status}`, text.slice(0, 200) || response.statusText);
  }
}
