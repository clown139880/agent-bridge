import type { Action, Envelope } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
    readonly retryable = false, readonly requestId?: string, readonly retryAfterMs?: number) { super(message); }
}

// The credential exists only in this instance; never serialize it or put it in a URL.
export class ControlClient {
  private lifetime = new AbortController();
  constructor(private token: string, private unauthorized: () => void) {}
  dispose() { this.token = ""; this.lifetime.abort(); }
  async request<T>(path: string, options: { signal?: AbortSignal; body?: unknown; key?: string } = {}): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      method: options.body === undefined ? "GET" : "POST", cache: "no-store", credentials: "omit",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
      headers: { Authorization: `Bearer ${this.token}`, ...(options.body === undefined ? {} : {
        "Content-Type": "application/json", "Idempotency-Key": options.key!,
      }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw await this.failure(response);
    return response.json() as Promise<T>;
  }
  post(path: string, body: unknown, key: string) { return this.request<Action>(path, { body, key }); }
  async stream(cursor: string, signal: AbortSignal): Promise<Response> {
    const response = await fetch("/api/v1/stream", {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream", "Last-Event-ID": cursor },
      cache: "no-store", credentials: "omit", signal: AbortSignal.any([signal, this.lifetime.signal]),
    });
    if (!response.ok) throw await this.failure(response);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new ApiError(502, "invalid_stream", "服务器没有返回事件流");
    }
    return response;
  }
  private async failure(response: Response) {
    const body = await response.json().catch(() => ({}));
    const e = body?.error;
    if (response.status === 401) this.unauthorized();
    const retry = response.headers.get("retry-after");
    const retryAfterMs = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : undefined;
    return new ApiError(response.status, typeof e?.code === "string" ? e.code : `http_${response.status}`,
      typeof e?.message === "string" ? e.message : response.status === 404 ? "API 或资源不存在，请确认控制面已启用 API" : `请求失败 (${response.status})`,
      e?.retryable === true, e?.requestId, retryAfterMs);
  }
}

export function explain(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      forbidden: "此操作需要 write token，请更换凭据。已加载的内容仍可只读查看。",
      turn_changed: "当前 turn 已变化，请检查会话后重新操作。", no_active_turn: "当前 turn 已结束。",
      turn_already_active: "已有新的 turn 正在运行，请检查会话后操作。",
      approval_pending: "请先在原客户端处理审批。", user_input_pending: "请先在原客户端回答待办问题。",
      capability_unavailable: "此 worker 不支持这项操作。", worker_offline: "Worker 已离线，请稍后刷新。",
    };
    return `${messages[error.code] ?? error.message}${error.requestId ? ` · ${error.requestId}` : ""}`;
  }
  return error instanceof Error ? error.message : "请求失败，请重试";
}

export function validEnvelope(value: unknown): value is Envelope {
  const e = value as Envelope | null;
  return Boolean(e && typeof e.cursor === "string" && typeof e.eventId === "string" && typeof e.type === "string"
    && e.resource && typeof e.resource.id === "string");
}
