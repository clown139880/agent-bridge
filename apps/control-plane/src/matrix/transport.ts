import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient, Method, type MatrixClient } from "matrix-js-sdk";
import type { Logger } from "matrix-js-sdk/lib/logger.js";
import type { MatrixConfig } from "./config.js";
import type { MatrixContent } from "./render.js";

export interface MatrixEvent { event_id: string; sender: string; type: string; content: MatrixContent; origin_server_ts?: number; redacts?: string }
export interface MatrixSync { next_batch: string; rooms?: { join?: Record<string, {
  timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
  state?: { events?: MatrixEvent[] };
}> } }
export interface MatrixTransport {
  open(): Promise<void>;
  sync(since?: string): Promise<MatrixSync>;
  history(roomId: string, from: string): Promise<{ chunk: MatrixEvent[]; end?: string }>;
  send(roomId: string, type: string, content: MatrixContent, transactionId: string): Promise<string>;
  download(mxc: string, maxBytes: number): Promise<Buffer>;
  close(): void;
}

// SDK request errors can include request metadata. This boundary exposes only stable error codes.
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return quiet; } };

export class SdkMatrixTransport implements MatrixTransport {
  private client?: MatrixClient;
  private readonly abort = new AbortController();
  constructor(private readonly config: MatrixConfig) {}

  async open(): Promise<void> {
    const config = this.config;
    const identity = `${config.homeserver}|${config.userId}`;
    let saved: { identity: string; accessToken: string; deviceId: string } | undefined;
    try { saved = JSON.parse(await readFile(config.stateFile, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("matrix_device_state_invalid"); }
    if (saved && saved.identity !== identity) throw new Error("matrix_account_changed: use a separate state file and database");
    if (saved && config.accessToken && config.accessToken !== saved.accessToken) throw new Error("matrix_token_changed: preserve the delivery device");
    let accessToken = saved?.accessToken ?? config.accessToken;
    let deviceId = saved?.deviceId ?? config.deviceId;
    if (!accessToken) {
      if (!config.password) throw new Error("matrix_credentials_missing");
      const anonymous = createClient({ baseUrl: config.homeserver, logger: quiet });
      const login = await anonymous.loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user: config.userId },
        password: config.password, device_id: deviceId ?? `AGENT_BRIDGE_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
        initial_device_display_name: "Agent Bridge" });
      if (login.user_id !== config.userId) throw new Error("matrix_login_identity_mismatch");
      accessToken = login.access_token; deviceId = login.device_id;
    }
    this.client = createClient({ baseUrl: config.homeserver, userId: config.userId, accessToken, deviceId, logger: quiet });
    const who = await this.client.whoami();
    if (who.user_id !== config.userId || !who.device_id || deviceId && who.device_id !== deviceId)
      throw new Error("matrix_device_identity_mismatch");
    await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 });
    await writeFile(`${config.stateFile}.tmp`, JSON.stringify({ identity, accessToken, deviceId: who.device_id }), { mode: 0o600 });
    await chmod(`${config.stateFile}.tmp`, 0o600);
    await rename(`${config.stateFile}.tmp`, config.stateFile);
    for (const room of config.rooms) await this.client.joinRoom(room.roomId);
  }

  sync(since?: string): Promise<MatrixSync> {
    return this.require().http.authedRequest(Method.Get, "/sync", {
      ...(since ? { since } : {}), timeout: since ? 25_000 : 0,
      filter: JSON.stringify({ room: { rooms: this.config.rooms.map(r => r.roomId),
        timeline: { limit: 100 }, ephemeral: { types: [] } }, presence: { types: [] } }),
      set_presence: "offline",
    }, undefined, { abortSignal: this.abort.signal, localTimeoutMs: 40_000 });
  }
  history(roomId: string, from: string): Promise<{ chunk: MatrixEvent[]; end?: string }> {
    return this.require().http.authedRequest(Method.Get, `/rooms/${encodeURIComponent(roomId)}/messages`,
      { from, dir: "b", limit: 100 }, undefined, { abortSignal: this.abort.signal, localTimeoutMs: 30_000 });
  }
  async send(roomId: string, type: string, content: MatrixContent, transactionId: string): Promise<string> {
    // No startClient / crypto: the durable inbox owns the sync checkpoint, and v1 is plaintext only.
    const result = await this.require().http.authedRequest<{ event_id: string }>(Method.Put,
      `/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(transactionId)}`,
      undefined, content, { abortSignal: this.abort.signal, localTimeoutMs: 30_000 });
    return result.event_id;
  }
  async download(mxc: string, maxBytes: number): Promise<Buffer> {
    if (!/^mxc:\/\/[^/]+\/[^/?#]+$/.test(mxc)) throw new Error("invalid_matrix_media_uri");
    const client = this.require();
    const url = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, false, true);
    if (!url || new URL(url).origin !== new URL(this.config.homeserver).origin) throw new Error("invalid_matrix_media_origin");
    const response = await fetch(url, { headers: { authorization: `Bearer ${client.getAccessToken()}` }, redirect: "error",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok || !response.body) throw new Error(`matrix_media_http_${response.status}`);
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("attachment_too_large"); }
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new Error("attachment_too_large");
      chunks.push(chunk);
    }
    if (!total) throw new Error("attachment_empty");
    return Buffer.concat(chunks);
  }
  close(): void { this.abort.abort(); this.client?.stopClient(); }
  private require(): MatrixClient { if (!this.client) throw new Error("matrix_not_connected"); return this.client; }
}
