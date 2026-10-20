import type { Action, AttachmentRef, Envelope } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
    readonly retryable = false, readonly requestId?: string, readonly retryAfterMs?: number) { super(message); }
}

// Browser mode uses the same-origin server entrance; only direct API clients hold a token.
export class ControlClient {
  private lifetime = new AbortController();
  constructor(private token: string, private unauthorized: () => void,
    private base: "/api/v1" | "/control/api/v1" = "/api/v1") {}
  private headers(): Record<string, string> { return this.base === "/control/api/v1" ? { "X-Control-Center": "1" }
    : { Authorization: `Bearer ${this.token}` }; }
  dispose() { this.token = ""; this.lifetime.abort(); }
  async request<T>(path: string, options: { signal?: AbortSignal; body?: unknown; key?: string; timeoutMs?: number } = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: options.body === undefined ? "GET" : "POST", cache: "no-store", credentials: this.base === "/control/api/v1" ? "same-origin" : "omit",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]),
      headers: { ...this.headers(), ...(options.body === undefined ? {} : {
        "Content-Type": "application/json", ...(options.key ? { "Idempotency-Key": options.key } : {}),
      }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw await this.failure(response);
    return response.json() as Promise<T>;
  }
  post(path: string, body: unknown, key: string) { return this.request<Action>(path, { body, key }); }
  /** Uploads are content-addressed by the server, so they need no idempotency key. */
  async upload(file: Blob & { name?: string }, signal?: AbortSignal): Promise<AttachmentRef> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const content = btoa(binary);
    return this.request<AttachmentRef>("/attachments", { signal, timeoutMs: 120_000,
      body: { filename: file.name || "image", mimeType: file.type, content } });
  }
  async stream(cursor: string, signal: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.base}/stream`, {
      headers: { ...this.headers(), Accept: "text/event-stream", "Last-Event-ID": cursor },
      cache: "no-store", credentials: this.base === "/control/api/v1" ? "same-origin" : "omit", signal: AbortSignal.any([signal, this.lifetime.signal]),
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
      browser_read_only: "控制面未配置网页写入凭据，当前仅可只读查看。",
      browser_origin_required: "请求来源校验失败，请从控制中心同源页面重试。",
      browser_api_unconfigured: "控制面未配置网页 API 凭据，请联系管理员。",
      turn_changed: "当前 turn 已变化，请检查会话后重新操作。", no_active_turn: "当前 turn 已结束。",
      turn_already_active: "已有新的 turn 正在运行，请检查会话后操作。",
      approval_pending: "请先处理上方的审批。", user_input_pending: "请先回答上方的问题。",
      approval_already_resolved: "该审批已被处理。", user_input_already_resolved: "该问题已被回答。",
      secret_input_unsupported: "保密输入请在本机回答。", invalid_choice: "该选项已不可用，请刷新。",
      model_not_applicable: "Agent 运行中不能切换模型或思考程度。", model_catalog_unavailable: "暂时读不到模型目录。",
      unsupported_media_type: "仅支持 PNG、JPEG、WebP、GIF 图片。", body_too_large: "图片过大（上限 15 MB）。",
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
