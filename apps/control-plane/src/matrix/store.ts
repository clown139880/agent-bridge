import { createHash } from "node:crypto";
import type { AgentControlStore } from "@agent-bridge/database";
import type { MatrixConfig, MatrixRoomConfig, MatrixTarget } from "./config.js";
import { message, splitMessage, type MatrixContent } from "./render.js";

export const keyHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export interface Binding { id: string; room_id: string; thread_id: string; generation: number; scope_id: string;
  target: string; session_id: string | null; after_event: number }
export interface Batch { id: string; binding_id: string; generation: number; sender: string; text: string;
  session_id: string | null; target: string; scope_id: string; status: string; interrupt_turn: string | null;
  create_body: string | null; submit_body: string | null; action_id: string | null; error: string | null; created_at: number }
export interface Media { event_id: string; binding_id: string; generation: number; sender: string; batch_id: string | null;
  content: string; attachment_id: string | null; status: string; error: string | null; seq: number }
export interface Outgoing { seq: number; key: string; room_id: string; thread_id: string; type: string; content: string;
  replace_key: string | null; event_id: string | null; pending_id: string | null; attempts: number; status: string }

export class MatrixStore {
  readonly db;
  constructor(readonly control: AgentControlStore, config: MatrixConfig) {
    this.db = control.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matrix_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matrix_inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS matrix_rooms (room_id TEXT PRIMARY KEY, last_event_id TEXT);
      CREATE TABLE IF NOT EXISTS matrix_bindings (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        generation INTEGER NOT NULL, scope_id TEXT NOT NULL, target TEXT NOT NULL, session_id TEXT, after_event INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matrix_binding_history (id TEXT NOT NULL, generation INTEGER NOT NULL, binding TEXT NOT NULL,
        PRIMARY KEY(id,generation));
      CREATE TABLE IF NOT EXISTS matrix_batches (id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
        sender TEXT NOT NULL, text TEXT NOT NULL, session_id TEXT, target TEXT NOT NULL, scope_id TEXT NOT NULL,
        status TEXT NOT NULL, interrupt_turn TEXT, create_body TEXT, submit_body TEXT, action_id TEXT, error TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS matrix_batch_ready ON matrix_batches(status,created_at);
      CREATE TABLE IF NOT EXISTS matrix_media (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        binding_id TEXT NOT NULL, generation INTEGER NOT NULL, sender TEXT NOT NULL, batch_id TEXT, content TEXT NOT NULL,
        attachment_id TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT);
      CREATE TABLE IF NOT EXISTS matrix_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL, thread_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, replace_key TEXT,
        event_id TEXT, pending_id TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS matrix_turns (session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        room_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_text TEXT, status_at INTEGER NOT NULL DEFAULT 0,
        terminal INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,turn_id));
    `);
    const identity = `${config.homeserver}|${config.userId}`;
    if (this.meta("account") && this.meta("account") !== identity) throw new Error("matrix_account_database_mismatch");
    this.setMeta("account", identity);
    if (!this.meta("output_cursor")) this.setMeta("output_cursor", JSON.stringify(control.streamPosition()));
  }
  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM matrix_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO matrix_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  binding(room: MatrixRoomConfig, threadId: string): Binding {
    const id = keyHash(`${room.roomId}|${threadId}`);
    let binding = this.getBinding(id);
    if (!binding) {
      this.db.prepare("INSERT INTO matrix_bindings VALUES(?,?,?,1,?,?,NULL,?)")
        .run(id, room.roomId, threadId, room.scopeId, JSON.stringify(room.targets[room.defaultTarget]), this.control.streamPosition().events);
      binding = this.getBinding(id)!;
    }
    if (binding.scope_id !== room.scopeId) {
      // A new project always receives a new generation and session. Prior drafts retain their scope.
      this.switchBinding(binding, room.scopeId, room.targets[room.defaultTarget]!);
      binding = this.getBinding(id)!;
    }
    return binding;
  }
  getBinding(id: string): Binding | undefined { return this.db.prepare("SELECT * FROM matrix_bindings WHERE id=?").get(id) as unknown as Binding | undefined; }
  switchBinding(binding: Binding, scopeId: string, target: MatrixTarget, sessionId?: string): void {
    this.rememberBinding(binding);
    const maximum = this.db.prepare("SELECT MAX(generation) n FROM matrix_binding_history WHERE id=?").get(binding.id) as { n: number };
    this.db.prepare(`UPDATE matrix_bindings SET generation=?,scope_id=?,target=?,session_id=?,after_event=? WHERE id=?`)
      .run(Number(maximum.n) + 1, scopeId, JSON.stringify(target), sessionId ?? null, this.control.streamPosition().events, binding.id);
  }
  restoreBinding(binding: Binding, generation: number): void {
    const row = this.db.prepare("SELECT binding FROM matrix_binding_history WHERE id=? AND generation=?")
      .get(binding.id, generation) as { binding: string } | undefined;
    if (!row) throw new Error("draft_binding_not_found");
    const previous = JSON.parse(row.binding) as Binding;
    if (previous.scope_id !== binding.scope_id) throw new Error("draft_scope_mismatch");
    this.rememberBinding(binding);
    this.db.prepare("UPDATE matrix_bindings SET generation=?,target=?,session_id=?,after_event=? WHERE id=?")
      .run(generation, previous.target, previous.session_id, this.control.streamPosition().events, binding.id);
  }
  private rememberBinding(binding: Binding): void {
    if (binding.session_id) {
      const active = this.control.session(binding.session_id)?.activeTurnId;
      if (typeof active === "string") this.db.prepare(`INSERT OR IGNORE INTO matrix_turns(session_id,turn_id,room_id,thread_id)
        VALUES(?,?,?,?)`).run(binding.session_id, active, binding.room_id, binding.thread_id);
    }
    this.db.prepare("INSERT INTO matrix_binding_history VALUES(?,?,?) ON CONFLICT(id,generation) DO UPDATE SET binding=excluded.binding")
      .run(binding.id, binding.generation, JSON.stringify({ ...binding, untilEvent: this.control.streamPosition().events }));
  }
  batch(id: string): Batch { return this.db.prepare("SELECT * FROM matrix_batches WHERE id=?").get(id) as unknown as Batch; }
  media(batchId: string): Media[] { return this.db.prepare("SELECT * FROM matrix_media WHERE batch_id=? ORDER BY seq").all(batchId) as unknown as Media[]; }
  enqueue(key: string, roomId: string, threadId: string, content: MatrixContent, options: { type?: string; replaceKey?: string; pendingId?: string } = {}): void {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO matrix_outbox(key,room_id,thread_id,type,content,replace_key,pending_id)
      VALUES(?,?,?,?,?,?,?)`).run(key, roomId, threadId, options.type ?? "m.room.message", JSON.stringify(content), options.replaceKey ?? null, options.pendingId ?? null);
    if (inserted.changes && options.replaceKey) this.db.prepare(`UPDATE matrix_outbox SET status='superseded'
      WHERE replace_key=? AND key!=? AND status='pending'`).run(options.replaceKey, key);
  }
  say(key: string, roomId: string, threadId: string, text: string, pendingId?: string): void {
    splitMessage(text).forEach((part, index) => this.enqueue(`${key}:${index}`, roomId, threadId, message(part, threadId), { pendingId }));
  }
  notice(key: string, binding: Binding, text: string): void { this.say(key, binding.room_id, binding.thread_id, text); }
}
