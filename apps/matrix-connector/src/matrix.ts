export type Content = Record<string, any>;
export interface MatrixEvent { event_id: string; sender: string; type: string; content: Content; state_key?: string }
export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
  };
}

export class MatrixError extends Error {
  constructor(readonly status: number, readonly errcode: string, message: string, readonly retryAfterMs?: number) { super(message); }
}

/** The few client-server endpoints a connector needs, over fetch; no SDK, crypto or local store. */
export class MatrixClient {
  constructor(private readonly homeserver: string, private token?: string) {}

  useToken(token: string): void { this.token = token; }

  async profileName(userId: string): Promise<string | undefined> {
    const profile = await this.request<{ displayname?: string }>("GET", `/_matrix/client/v3/profile/${enc(userId)}/displayname`);
    return profile.displayname || undefined;
  }

  async login(userId: string, password: string): Promise<{ accessToken: string; deviceId: string }> {
    const result = await this.request<{ user_id: string; access_token: string; device_id: string }>("POST", "/_matrix/client/v3/login", {
      body: { type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password,
        initial_device_display_name: "Agent Bridge Matrix connector" }, auth: false });
    if (result.user_id !== userId) throw new Error("matrix_login_identity_mismatch");
    this.token = result.access_token;
    return { accessToken: result.access_token, deviceId: result.device_id };
  }

  whoami(): Promise<{ user_id: string; device_id?: string }> { return this.request("GET", "/_matrix/client/v3/account/whoami"); }

  sync(since: string | undefined, signal: AbortSignal): Promise<SyncResponse> {
    const filter = JSON.stringify({ presence: { types: [] }, account_data: { types: [] },
      room: { timeline: { limit: 50 }, state: { lazy_load_members: true }, ephemeral: { types: [] }, account_data: { types: [] } } });
    return this.request("GET", "/_matrix/client/v3/sync", { query: { filter, set_presence: "online", timeout: since ? "30000" : "0",
      ...(since ? { since } : {}) }, signal, timeoutMs: 45_000 });
  }

  async join(roomId: string): Promise<void> { await this.request("POST", `/_matrix/client/v3/join/${enc(roomId)}`, { body: {} }); }

  async send(roomId: string, type: string, content: Content, txnId: string): Promise<string> {
    const result = await this.request<{ event_id: string }>("PUT",
      `/_matrix/client/v3/rooms/${enc(roomId)}/send/${enc(type)}/${enc(txnId)}`, { body: content });
    return result.event_id;
  }

  async typing(roomId: string, userId: string, typing: boolean): Promise<void> {
    await this.request("PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/typing/${enc(userId)}`,
      { body: typing ? { typing: true, timeout: 30_000 } : { typing: false } });
  }

  /** Authenticated media first (Matrix 1.11), then the legacy endpoint. */
  async download(mxc: string, maxBytes: number): Promise<Buffer> {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
    if (!match) throw new Error("invalid_media_uri");
    const paths = [`/_matrix/client/v1/media/download/${enc(match[1]!)}/${enc(match[2]!)}`,
      `/_matrix/media/v3/download/${enc(match[1]!)}/${enc(match[2]!)}`];
    for (const [index, path] of paths.entries()) {
      const response = await fetch(this.homeserver + path, { headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(60_000) });
      if ((response.status === 404 || response.status === 400) && index === 0) { await response.body?.cancel(); continue; }
      if (!response.ok || !response.body) throw new Error(`media_http_${response.status}`);
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) throw new Error("attachment_too_large");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new Error("media_unavailable");
  }

  private async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown;
    signal?: AbortSignal; timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
    const url = new URL(this.homeserver + path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const response = await fetch(url, { method,
      headers: { ...(options.auth === false ? {} : { authorization: `Bearer ${this.token}` }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    const text = await response.text();
    const value = text ? JSON.parse(text) : {};
    if (!response.ok) throw new MatrixError(response.status, value.errcode ?? `http_${response.status}`, value.error ?? response.statusText, value.retry_after_ms);
    return value as T;
  }
}

const enc = encodeURIComponent;
