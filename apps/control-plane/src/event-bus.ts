import { connect, type IClientOptions, type MqttClient } from "mqtt";
import pino from "pino";
import type { DatabaseSync } from "node:sqlite";

const log = pino({ name: "event-bus" });
const DAY = 86_400_000;
const RETENTION = 7 * DAY;
const REDISPATCH_MS = 60 * 60_000;
/** A heartbeat from MQTT is judged only once the subscription has been up this long. */
const SETTLED_MS = 60_000;
/** The subscription down this long is announced once. */
const DOWN_NOTICE_MS = 5 * 60_000;
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const codePoints = (value: string): number => Array.from(value).length;

/** A v1 business message (docs/message-events-v1.zh.md) with the optional `handling` (docs/event-routing.zh.md). */
export interface BusEvent {
  v: 1; eventId: string; source: string; type: string; key: string; revision: number;
  state: "message" | "active" | "resolved"; level: "silent" | "notice" | "alert" | "critical";
  handling: "notify" | "investigate"; title: string; body?: string; url?: string;
  createdAt: number; expiresAt: number; data?: Record<string, unknown>;
}

export interface EventBusOptions {
  /** Sources read from MQTT (`uctw/messages/<source>/events` and `state/#`). */
  sources: string[];
  /** Sources accepted at `POST /events/<source>`. */
  hookSources: string[];
  mqtt?: { url: string; username?: string; password?: string };
}

export interface EventBusDeps {
  db: DatabaseSync;
  /** An accepted event, once; `false` leaves it undispatched, to be offered again. */
  dispatch(event: BusEvent): boolean;
  /** A heartbeat went stale (`stale: true`) or came back. */
  stale(source: string, stale: boolean, expiresAt: number): void;
  /** Publish a webhook-made event to MQTT under its source. */
  relay?(event: BusEvent): void;
  /** The subscription was down for a while, or is back. */
  announce?(text: string, level: "notice" | "alert"): void;
  now?: () => number;
}

type Verdict = { ok: true; event: BusEvent } | { ok: false; reason: string };

/**
 * The Control Plane as one subscriber of the shared event bus (docs/event-routing.zh.md): events from
 * MQTT and from the LAN webhook land in one table, deduplicated by (source, eventId) and ordered by
 * each key's revision, and are offered to the automations once.
 */
export class EventBus {
  private client?: MqttClient;
  private connectedAt?: number;
  private downSince?: number;
  private downAnnounced = false;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: EventBusOptions, private readonly deps: EventBusDeps) {
    this.now = deps.now ?? Date.now;
    deps.db.exec(`
      CREATE TABLE IF NOT EXISTS bus_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_id TEXT NOT NULL,
        type TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, origin TEXT NOT NULL, payload TEXT NOT NULL,
        received_at INTEGER NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, UNIQUE(source, event_id));
      CREATE INDEX IF NOT EXISTS bus_events_undispatched ON bus_events(dispatched, received_at);
      CREATE TABLE IF NOT EXISTS bus_keys (source TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(source, key));
      CREATE TABLE IF NOT EXISTS bus_heartbeats (source TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, origin TEXT NOT NULL,
        seen_at INTEGER NOT NULL, stale INTEGER NOT NULL DEFAULT 0);
    `);
  }

  get subscribing(): boolean { return Boolean(this.options.mqtt && this.options.sources.length); }

  start(): void {
    this.redispatch();
    if (this.subscribing) this.subscribe();
    this.timer = setInterval(() => { try { this.check(); } catch (error) { log.error({ error }, "Event bus check failed"); } }, 30_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.client?.end(true);
  }

  status(): Record<string, unknown> {
    return { sources: this.options.sources, hookSources: this.options.hookSources, connected: Boolean(this.connectedAt),
      heartbeats: this.deps.db.prepare("SELECT source,expires_at AS expiresAt,stale FROM bus_heartbeats ORDER BY source").all() };
  }

  // ---- intake ---------------------------------------------------------------

  /** `POST /events/<source>`: a LAN source that does not speak MQTT. The body is a v1 message; most fields can be left out. */
  hook(source: string, body: Buffer): { status: number; body: Record<string, unknown> } {
    if (!this.options.hookSources.includes(source)) return { status: 404, body: { error: "unknown_source" } };
    let raw: unknown;
    try { raw = JSON.parse(body.toString("utf8")); } catch { return { status: 400, body: { error: "invalid_json" } }; }
    const now = this.now();
    const fill = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const createdAt = typeof fill.createdAt === "number" ? fill.createdAt : now;
    const verdict = validate({ v: 1, state: "message", level: "notice", createdAt, expiresAt: createdAt + DAY, revision: 0, ...fill, source: fill.source ?? source }, source, true);
    if (!verdict.ok) return { status: 400, body: { error: "invalid_event", reason: verdict.reason } };
    const result = this.accept(verdict.event, "hook");
    return { status: result === "duplicate" ? 200 : 202, body: { [result]: true, eventId: verdict.event.eventId } };
  }

  /** One MQTT message; true once it is safely handled (then it is acknowledged). */
  receive(topic: string, payload: Buffer): boolean {
    const match = /^uctw\/messages\/([^/]+)\/(events|state\/[^/]+)$/.exec(topic);
    if (!match || !this.options.sources.includes(match[1]!)) return true;
    if (!payload.length) return true; // a cleared retained state
    let raw: unknown;
    try { raw = JSON.parse(payload.toString("utf8")); } catch { log.warn({ topic }, "Unreadable event skipped"); return true; }
    const verdict = validate(raw, match[1]!, false);
    if (!verdict.ok) { log.warn({ topic, reason: verdict.reason }, "Invalid event skipped"); return true; }
    this.accept(verdict.event, "mqtt");
    return true;
  }

  /** Store once, then offer it; a heartbeat only feeds `stale`. */
  private accept(event: BusEvent, origin: "mqtt" | "hook"): "accepted" | "duplicate" | "outdated" {
    const db = this.deps.db, now = this.now();
    let fresh = false, current = true;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (origin === "hook" && !event.revision) {
        const last = db.prepare("SELECT MAX(revision) AS n FROM bus_keys WHERE source=?").get(event.source) as { n: number | null };
        event.revision = Math.max(now, (last.n ?? 0) + 1);
      }
      const inserted = db.prepare(`INSERT OR IGNORE INTO bus_events(source,event_id,type,key,revision,origin,payload,received_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(event.source, event.eventId, event.type, event.key, event.revision, origin, JSON.stringify(event), now);
      fresh = inserted.changes > 0;
      if (fresh) {
        const known = db.prepare("SELECT revision FROM bus_keys WHERE source=? AND key=?").get(event.source, event.key) as { revision: number } | undefined;
        current = !known || event.revision > known.revision;
        if (current) db.prepare(`INSERT INTO bus_keys(source,key,revision) VALUES(?,?,?)
          ON CONFLICT(source,key) DO UPDATE SET revision=excluded.revision`).run(event.source, event.key, event.revision);
        // Out of order, expired or a heartbeat: kept for the record, never offered.
        if (!current || event.expiresAt <= now || event.type === "heartbeat")
          db.prepare("UPDATE bus_events SET dispatched=1 WHERE source=? AND event_id=?").run(event.source, event.eventId);
        if (current && event.type === "heartbeat") db.prepare(`INSERT INTO bus_heartbeats(source,expires_at,origin,seen_at) VALUES(?,?,?,?)
          ON CONFLICT(source) DO UPDATE SET expires_at=excluded.expires_at,origin=excluded.origin,seen_at=excluded.seen_at`)
          .run(event.source, event.expiresAt, origin, now);
      }
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    if (!fresh) return "duplicate";
    if (origin === "hook") try { this.deps.relay?.(event); } catch (error) { log.warn({ error, eventId: event.eventId }, "Event not queued for MQTT"); }
    if (event.type === "heartbeat") { this.check(); return "accepted"; }
    if (!current) return "outdated";
    if (event.expiresAt > now) this.offer(event);
    return "accepted";
  }

  private offer(event: BusEvent): void {
    let done = false;
    try { done = this.deps.dispatch(event); } catch (error) { log.error({ error, eventId: event.eventId }, "Event dispatch failed"); }
    if (done) this.deps.db.prepare("UPDATE bus_events SET dispatched=1 WHERE source=? AND event_id=?").run(event.source, event.eventId);
  }

  /** After a restart: what was stored but not offered within the last hour. */
  private redispatch(): void {
    const rows = this.deps.db.prepare("SELECT payload FROM bus_events WHERE dispatched=0 AND received_at>? ORDER BY seq")
      .all(this.now() - REDISPATCH_MS) as Array<{ payload: string }>;
    for (const row of rows) { const event = JSON.parse(row.payload) as BusEvent; if (event.expiresAt > this.now()) this.offer(event); }
  }

  // ---- heartbeats and the subscription ---------------------------------------

  /** Stale heartbeats, recoveries, the subscription's own health and the retention sweep. */
  check(): void {
    const now = this.now(), db = this.deps.db;
    const settled = this.connectedAt !== undefined && now - this.connectedAt >= SETTLED_MS;
    for (const row of db.prepare("SELECT source,expires_at,origin,stale FROM bus_heartbeats").all() as Array<{ source: string; expires_at: number; origin: string; stale: number }>) {
      const expired = row.expires_at <= now;
      // With the broker gone every MQTT heartbeat expires at once: say nothing about the sources then.
      if (expired && !row.stale && (row.origin === "hook" || settled)) {
        db.prepare("UPDATE bus_heartbeats SET stale=1 WHERE source=?").run(row.source);
        this.deps.stale(row.source, true, row.expires_at);
      } else if (!expired && row.stale) {
        db.prepare("UPDATE bus_heartbeats SET stale=0 WHERE source=?").run(row.source);
        this.deps.stale(row.source, false, row.expires_at);
      }
    }
    if (this.subscribing && this.downSince !== undefined && !this.downAnnounced && now - this.downSince >= DOWN_NOTICE_MS) {
      this.downAnnounced = true;
      this.deps.announce?.(`⚠️ 事件总线断开：Control Plane 已 ${Math.round((now - this.downSince) / 60_000)} 分钟没连上 MQTT，订阅的来源（${this.options.sources.join("、")}）的事件和掉线检测都暂停了。`, "alert");
    }
    db.prepare("DELETE FROM bus_events WHERE received_at<?").run(now - RETENTION);
  }

  private subscribe(): void {
    const mqtt = this.options.mqtt!;
    const options: IClientOptions = { clientId: "agent-bridge-event-consumer", clean: false, username: mqtt.username, password: mqtt.password,
      keepalive: 60, reconnectPeriod: 5_000, connectTimeout: 10_000 };
    this.downSince = this.now();
    const client = this.client = connect(mqtt.url, options);
    // QoS 1: mqtt.js acknowledges only after this callback, so a message is acknowledged once stored.
    client.handleMessage = (packet, callback) => {
      if (packet.cmd !== "publish") return callback();
      let handled = false;
      try { handled = this.receive(packet.topic, Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload)); }
      catch (error) { log.error({ error, topic: packet.topic }, "Event not stored; the broker redelivers it"); }
      if (handled) callback();
      else client.end(true, () => setTimeout(() => { if (this.client === client) this.subscribe(); }, 10_000).unref());
    };
    client.on("connect", () => {
      client.subscribe(this.options.sources.flatMap((source) => [`uctw/messages/${source}/events`, `uctw/messages/${source}/state/#`]), { qos: 1 }, (error, granted) => {
        const refused = (granted ?? []).filter((item) => item.qos >= 128).map((item) => item.topic);
        if (error || refused.length) { log.error({ error: error?.message, refused }, "Event subscription refused"); return; }
        if (this.downAnnounced) this.deps.announce?.("✅ 事件总线已恢复", "notice");
        this.connectedAt = this.now(); this.downSince = undefined; this.downAnnounced = false;
        log.info({ sources: this.options.sources }, "Event bus subscribed");
      });
    });
    client.on("close", () => { if (this.connectedAt !== undefined) { this.connectedAt = undefined; this.downSince = this.now(); } });
    client.on("error", (error) => log.warn({ error: error.message }, "Event bus connection error"));
  }
}

/** Check a v1 message; `source` is who the topic or URL says it is, whatever the payload claims. */
export function validate(raw: unknown, source: string, fromHook: boolean): Verdict {
  const fail = (reason: string): Verdict => ({ ok: false, reason });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  const value = raw as Record<string, unknown>;
  const text = (name: string, limit: number, required = true): string | undefined => {
    const item = value[name];
    if (item === undefined && !required) return undefined;
    if (typeof item !== "string" || !item || item.length > limit) throw new Error(`${name} must be a string of at most ${limit} characters`);
    return item;
  };
  try {
    if (value.v !== 1) return fail("v must be 1");
    if (!SOURCE.test(source) || value.source !== source) return fail("source does not match the topic or URL");
    const eventId = text("eventId", 160)!, type = text("type", 64)!, key = text("key", 512)!, title = value.title;
    if (typeof title !== "string" || !title.trim() || codePoints(title) > 160) return fail("title must be 1-160 characters");
    if (value.body !== undefined && (typeof value.body !== "string" || codePoints(value.body) > 600)) return fail("body is at most 600 characters");
    const url = text("url", 500, false);
    const revision = value.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < (fromHook ? 0 : 1)) return fail("revision must be a positive integer");
    if (!["message", "active", "resolved"].includes(String(value.state))) return fail("state must be message, active or resolved");
    // The watch keeps critical for HA alone (docs/personal-message-center.zh.md).
    const level = value.level === "critical" && source !== "ha" ? "alert" : value.level;
    if (!["silent", "notice", "alert", "critical"].includes(String(level))) return fail("level must be silent, notice, alert or critical");
    const handling = value.handling ?? "notify";
    if (handling !== "notify" && handling !== "investigate") return fail("handling must be notify or investigate");
    if (!Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= (value.createdAt as number))
      return fail("createdAt and expiresAt must be ms with expiresAt later");
    if (value.data !== undefined && (!value.data || typeof value.data !== "object" || Array.isArray(value.data))) return fail("data must be an object");
    const event: BusEvent = { v: 1, eventId, source, type, key, revision: revision as number, state: value.state as BusEvent["state"],
      level: level as BusEvent["level"], handling, title, ...(value.body ? { body: value.body as string } : {}), ...(url ? { url } : {}),
      createdAt: value.createdAt as number, expiresAt: value.expiresAt as number, ...(value.data ? { data: value.data as Record<string, unknown> } : {}) };
    if (Buffer.byteLength(JSON.stringify(event)) > 8192) return fail("message exceeds 8 KiB");
    return { ok: true, event };
  } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
}
