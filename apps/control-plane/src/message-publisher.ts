import { createHash } from "node:crypto";
import { connectAsync, type MqttClient } from "mqtt";
import pino from "pino";
import { AgentControlStore, Store, streamSignal, type PendingRow, type StreamItem } from "@agent-bridge/database";

const log = pino({ name: "message-publisher" });
const DAY = 86_400_000;
const RETENTION = 7 * DAY;
const short = (value: string, limit: number): string => Array.from(value).slice(0, limit).join("");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface MessageMqttOptions {
  url: string;
  username?: string;
  password?: string;
}

/** Shared v1 business envelope. Device-specific rendering stays outside the producer. */
export interface BusinessMessage {
  v: 1;
  eventId: string;
  source: "agent-bridge";
  type: string;
  key: string;
  revision: number;
  state: "message" | "active" | "resolved";
  level: "silent" | "notice" | "alert";
  title: string;
  body?: string;
  url: string;
  createdAt: number;
  expiresAt: number;
  data: { sessionId: string; machineId: string; agent: string; turnId?: string; requestId?: string };
}

type Draft = Omit<BusinessMessage, "v" | "source" | "revision">;
interface QueueRow {
  seq: number; event_id: string; message_key: string; topic: string; payload: string;
  retain: number; expires_at: number; attempts: number;
}
interface KeyRow { message_key: string; payload: string; revision: number; topic: string; expires_at: number }
type Publish = (topic: string, payload: string, retain: boolean) => Promise<void>;

/**
 * Projects the durable control feed into a transactional outbox. A crash between
 * an upstream write and this projection is recovered from the saved cursors;
 * a crash after PUBACK can repeat a stable eventId, which consumers deduplicate.
 */
export class AgentMessagePublisher {
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private client?: MqttClient;
  private closed = false;
  private readonly now: () => number;
  private readonly wake = (): void => {
    if (this.closed) return;
    try { this.capture(); void this.flush(); }
    catch { log.error("Message projection failed; its durable cursor will retry"); }
  };

  constructor(private readonly store: Store, private readonly control: AgentControlStore,
    private readonly options: MessageMqttOptions,
    private readonly dependencies: {
      now?: () => number; publish?: Publish;
      /** A chat room (Matrix) already reports this session, so the phone gets its completions and requests quietly. */
      relayed?: (sessionId: string) => boolean;
    } = {}) {
    const url = new URL(options.url);
    if (!["mqtt:", "mqtts:"].includes(url.protocol)) throw new Error("MESSAGE_MQTT_URL must use mqtt or mqtts");
    this.now = dependencies.now ?? Date.now;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS message_publisher_cursor (
        id INTEGER PRIMARY KEY CHECK(id=1), events INTEGER NOT NULL, changes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        message_key TEXT NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL,
        retain INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, accepted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS message_outbox_due ON message_outbox(status,next_at,seq);
      CREATE TABLE IF NOT EXISTS message_publisher_keys (
        message_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL, state TEXT NOT NULL, topic TEXT NOT NULL,
        payload TEXT NOT NULL, expires_at INTEGER NOT NULL, clear_queued INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Start from now on first activation, rather than notifying historical turn
    // completions. Outstanding requests are reconciled once, within their TTL.
    control.transaction(() => {
      if (store.db.prepare("SELECT id FROM message_publisher_cursor WHERE id=1").get()) return;
      const position = control.streamPosition();
      store.db.prepare("INSERT INTO message_publisher_cursor VALUES(1,?,?)").run(position.events, position.changes);
      for (const kind of ["approval", "user_input"] as const) {
        let cursor: string | undefined;
        do {
          const page = control.listPending(kind, { statuses: ["pending"], limit: 200, cursor });
          for (const pending of page.data) this.pending(pending, `bootstrap:${hash(`${kind}:${pending.id}`).slice(0, 40)}`);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
    });
  }

  start(): void {
    if (this.timer || this.closed) return;
    streamSignal.on("change", this.wake);
    this.timer = setInterval(this.wake, 5_000);
    this.timer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    streamSignal.off("change", this.wake);
    this.client?.end(true);
    await this.draining;
  }

  status(): { pending: number; accepted: number } {
    const count = (status: string): number => Number((this.store.db.prepare(
      "SELECT COUNT(*) AS n FROM message_outbox WHERE status=?").get(status) as { n: number }).n);
    return { pending: count("pending"), accepted: count("accepted") };
  }

  /** Capture a bounded batch without doing network I/O or losing the replay position. */
  capture(): void {
    this.control.transaction(() => {
      const cursor = this.store.db.prepare("SELECT events,changes FROM message_publisher_cursor WHERE id=1").get() as
        { events: number; changes: number };
      const batch = this.control.streamAfter(cursor, 500);
      for (const item of batch.items) this.project(item);
      this.store.db.prepare("UPDATE message_publisher_cursor SET events=?,changes=? WHERE id=1")
        .run(batch.position.events, batch.position.changes);
      const now = this.now();
      this.store.db.prepare("UPDATE message_outbox SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);
      const expired = this.store.db.prepare(`SELECT * FROM message_publisher_keys
        WHERE state!='message' AND expires_at<=? AND clear_queued=0`).all(now) as unknown as KeyRow[];
      for (const row of expired) {
        this.store.db.prepare(`INSERT OR IGNORE INTO message_outbox
          (event_id,message_key,topic,payload,retain,expires_at,created_at,next_at)
          VALUES(?,?,?,'',1,?,?,?)`).run(`ab:clear:${row.revision}`, row.message_key, row.topic,
            Number.MAX_SAFE_INTEGER, now, now);
        this.store.db.prepare("UPDATE message_publisher_keys SET clear_queued=1 WHERE message_key=?").run(row.message_key);
      }
      this.store.db.prepare("DELETE FROM message_outbox WHERE status!='pending' AND created_at<?").run(now - RETENTION);
      this.store.db.prepare(`DELETE FROM message_publisher_keys WHERE expires_at<? AND NOT EXISTS
        (SELECT 1 FROM message_outbox o WHERE o.message_key=message_publisher_keys.message_key AND o.status='pending')`)
        .run(now - RETENTION);
    });
  }

  private project(item: StreamItem): void {
    if (item.type === "session.event.appended") {
      const event = item.payload as { type: string; turnId?: string; timestamp: number; payload: Record<string, unknown> };
      if (event.type !== "turn.completed" && event.type !== "turn.failed") return;
      const session = item.sessionId && this.store.getSession(item.sessionId);
      if (!session) return;
      const completed = event.type === "turn.completed";
      const detail = event.payload.summary ?? event.payload.error;
      const summary = typeof detail === "string" ? detail
        : detail && typeof detail === "object" && "message" in detail ? String(detail.message) : "";
      this.enqueue({ eventId: `ab:${item.eventId}`, type: `agent.${event.type}`,
        key: `agent:${session.id}:turn:${event.turnId ?? item.eventId}`, state: "message",
        level: completed ? this.quiet(session.id, "notice") : "alert", title: `${completed ? "任务完成" : "任务失败"} · ${this.title(session.id)}`,
        body: summary, url: `/control/sessions/${encodeURIComponent(session.id)}`, createdAt: event.timestamp,
        expiresAt: event.timestamp + (completed ? 600_000 : 1_800_000),
        data: { sessionId: session.id, machineId: session.machineId, agent: session.agentType,
          ...(event.turnId ? { turnId: event.turnId } : {}) } });
    } else if (item.type === "approval.upserted" || item.type === "user_input.upserted") {
      const pending = this.control.pending(item.resourceId);
      if (pending) this.pending(pending, item.eventId);
    } else if (item.type === "session.deleted") {
      const rows = this.store.db.prepare("SELECT * FROM message_publisher_keys WHERE session_id=? AND state='active'")
        .all(item.resourceId) as unknown as KeyRow[];
      for (const row of rows) {
        const previous = JSON.parse(row.payload) as BusinessMessage;
        this.enqueue({ ...previous, eventId: `ab:${item.eventId}:${hash(row.message_key).slice(0, 16)}`,
          type: previous.type.replace(/requested$/, "resolved"), state: "resolved",
          createdAt: this.now(), expiresAt: this.now() + DAY });
      }
    }
  }

  private pending(pending: PendingRow, eventId: string): void {
    const session = this.store.getSession(pending.sessionId);
    if (!session) return;
    const active = pending.status === "pending", approval = pending.kind === "approval";
    const questions = pending.request.questions as Array<{ question?: string }> | undefined;
    const createdAt = active ? pending.requestedAt : pending.resolvedAt ?? this.now();
    this.enqueue({ eventId: `ab:${eventId}`, type: `agent.${approval ? "approval" : "input"}.${active ? "requested" : "resolved"}`,
      key: `agent:${session.id}:${approval ? "approval" : "input"}:${pending.id}`, state: active ? "active" : "resolved",
      level: this.quiet(session.id, "alert"), title: `${active ? approval ? "需要审批" : "需要回答" : "已处理"} · ${this.title(session.id)}`,
      body: approval ? String(pending.request.summary ?? "") : (questions ?? []).map(q => q.question ?? "").join("\n"),
      url: `/control/sessions/${encodeURIComponent(session.id)}`, createdAt, expiresAt: createdAt + DAY,
      data: { sessionId: session.id, machineId: session.machineId, agent: session.agentType,
        requestId: pending.id, ...(pending.turnId ? { turnId: pending.turnId } : {}) } });
  }

  // Failures still alert on every channel; they are rare and matter.
  private quiet(sessionId: string, level: "notice" | "alert"): BusinessMessage["level"] {
    return this.dependencies.relayed?.(sessionId) ? "silent" : level;
  }

  private title(sessionId: string): string {
    return String(this.control.session(sessionId)?.title ?? this.store.getSession(sessionId)?.projectName ?? "Agent");
  }

  private enqueue(draft: Draft): void {
    if (draft.expiresAt <= this.now()) return;
    if (!Number.isSafeInteger(draft.createdAt) || !Number.isSafeInteger(draft.expiresAt)
      || draft.key.length > 512 || draft.url.length > 500) {
      log.warn({ eventId: draft.eventId }, "Skipped invalid notification metadata; the source event remains archived");
      return;
    }
    const message: BusinessMessage = { ...draft, v: 1, source: "agent-bridge", revision: 0,
      title: short(draft.title, 160), body: short(draft.body ?? "", 600) };
    if (Buffer.byteLength(JSON.stringify({ ...message, revision: Number.MAX_SAFE_INTEGER })) > 8192) {
      log.warn({ eventId: draft.eventId }, "Skipped oversized notification metadata; the source event remains archived");
      return;
    }
    // Reconnecting Bridges can restate a pending request with a new timestamp.
    // Its same content must not renew the TTL or create another interruption.
    const fingerprint = hash(JSON.stringify([message.type, message.state, message.title, message.body, message.url, message.data]));
    const previous = this.store.db.prepare("SELECT fingerprint FROM message_publisher_keys WHERE message_key=?")
      .get(message.key) as { fingerprint: string } | undefined;
    if (previous?.fingerprint === fingerprint) return;
    const retain = message.state !== "message";
    const topic = retain ? `uctw/messages/agent-bridge/state/${hash(message.key).slice(0, 32)}`
      : "uctw/messages/agent-bridge/events";
    const now = this.now();
    const inserted = this.store.db.prepare(`INSERT OR IGNORE INTO message_outbox
      (event_id,message_key,topic,payload,retain,expires_at,created_at,next_at) VALUES(?,?,?,'',?,?,?,?)`)
      .run(message.eventId, message.key, topic, Number(retain), message.expiresAt, now, now);
    if (!inserted.changes) return;
    message.revision = Number(inserted.lastInsertRowid);
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > 8192) throw new Error("Business message exceeds 8 KiB");
    this.store.db.prepare("UPDATE message_outbox SET payload=? WHERE seq=?").run(payload, message.revision);
    this.store.db.prepare("UPDATE message_outbox SET status='superseded' WHERE message_key=? AND seq!=? AND status='pending'")
      .run(message.key, message.revision);
    this.store.db.prepare(`INSERT INTO message_publisher_keys
      (message_key,session_id,fingerprint,revision,state,topic,payload,expires_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(message_key) DO UPDATE SET fingerprint=excluded.fingerprint,revision=excluded.revision,
      state=excluded.state,topic=excluded.topic,payload=excluded.payload,expires_at=excluded.expires_at,clear_queued=0`)
      .run(message.key, message.data.sessionId, fingerprint, message.revision, message.state, topic, payload, message.expiresAt);
  }

  /** Drain only due deliveries; broker failures never reject the Agent's turn. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.draining ??= this.drain().finally(() => { this.draining = undefined; });
  }

  private async drain(): Promise<void> {
    try {
      for (let count = 0; count < 100 && !this.closed; count++) {
        const row = this.store.db.prepare(`SELECT * FROM message_outbox WHERE status='pending' AND next_at<=?
          ORDER BY seq LIMIT 1`).get(this.now()) as unknown as QueueRow | undefined;
        if (!row) break;
        if (row.expires_at <= this.now()) {
          this.store.db.prepare("UPDATE message_outbox SET status='expired' WHERE seq=?").run(row.seq);
          continue;
        }
        try {
          await (this.dependencies.publish ?? this.publish.bind(this))(row.topic, row.payload, Boolean(row.retain));
          this.store.db.prepare("UPDATE message_outbox SET status='accepted',accepted_at=? WHERE seq=? AND status='pending'")
            .run(this.now(), row.seq);
        } catch {
          if (!this.closed) {
            this.store.db.prepare("UPDATE message_outbox SET attempts=attempts+1,next_at=? WHERE seq=? AND status='pending'")
              .run(this.now() + Math.min(600_000, 10_000 * 2 ** Math.min(row.attempts, 6)), row.seq);
            log.warn({ eventId: row.event_id }, "MQTT unavailable; notification remains in the durable outbox");
          }
          break;
        }
      }
    } finally {
      this.client?.end(true);
      this.client = undefined;
    }
  }

  private async publish(topic: string, payload: string, retain: boolean): Promise<void> {
    if (!this.client) {
      this.client = await connectAsync(this.options.url, {
        username: this.options.username, password: this.options.password,
        clientId: "agent-bridge-message-publisher", clean: true, reconnectPeriod: 0,
        connectTimeout: 10_000, keepalive: 0,
      });
      // A later socket failure must not become an unhandled EventEmitter error.
      // The publish callback/timeout keeps the delivery pending for retry.
      this.client.on("error", () => {});
    }
    const client = this.client;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { client.end(true); reject(new Error("MQTT publish timeout")); }, 10_000);
      timer.unref();
      client.publish(topic, payload, { qos: 1, retain }, error => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      });
    });
  }
}
