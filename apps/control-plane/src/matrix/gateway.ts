import pino from "pino";
import { streamSignal, type AgentControlStore, type PendingRow, type StreamItem } from "@agent-bridge/database";
import type { AttachmentRef } from "@agent-bridge/protocol";
import { ATTACHMENT_MIME_ALLOWLIST, MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES } from "../api/validation.js";
import type { SessionMemory } from "../session-memory.js";
import type { MatrixControl, Json } from "./api.js";
import type { MatrixConfig, MatrixRoomConfig, MatrixTarget } from "./config.js";
import { command, message, numberKeys, plainBody, threadOf, type MatrixContent } from "./render.js";
import { MatrixStore, keyHash, type Batch, type Binding, type Media, type Outgoing } from "./store.js";
import type { MatrixEvent, MatrixSync, MatrixTransport } from "./transport.js";

const log = pino({ name: "matrix" });
const pause = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms).unref(); });
const codeOf = (error: unknown): string => {
  const value = error as { code?: string; errcode?: string; message?: string };
  return value.code ?? value.errcode ?? value.message?.split(/[\n:]/)[0]?.slice(0, 160) ?? "matrix_error";
};
const enc = encodeURIComponent;
const terminal = new Set(["turn.completed", "turn.failed", "turn.interrupted"]);
interface TurnRoute { session_id: string; turn_id: string; room_id: string; thread_id: string; last_text: string | null; status_at: number; terminal: number }

/** A durable frontend: receiving, staging, dispatching and rendering have independent replay ledgers. */
export class MatrixGateway {
  readonly store: MatrixStore;
  private closed = false;
  private connected = false;
  private syncing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private drainingInbox?: Promise<void>;
  private flushing?: Promise<void>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly downloads = new Map<string, Promise<void>>();
  private lastError?: string;
  private lastSyncAt?: number;
  private readonly wake = (): void => { void this.tick(); };

  constructor(private readonly control: AgentControlStore, private readonly config: MatrixConfig,
    private readonly transport: MatrixTransport, private readonly api: MatrixControl, private readonly memory: SessionMemory) {
    this.store = new MatrixStore(control, config);
  }
  start(): void {
    streamSignal.on("change", this.wake);
    this.timer = setInterval(this.wake, 1000); this.timer.unref();
    this.syncing = this.syncLoop();
  }
  async stop(): Promise<void> {
    this.closed = true; this.transport.close(); clearInterval(this.timer); streamSignal.off("change", this.wake);
    await Promise.allSettled([this.syncing, this.drainingInbox, this.flushing, ...this.jobs.values(), ...this.downloads.values()]);
  }
  status(): Json {
    const count = (table: string, where: string): number => Number((this.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get() as { n: number }).n);
    return { enabled: true, connected: this.connected, lastSyncAt: this.lastSyncAt ?? null, error: this.lastError ?? null,
      pendingInputs: count("matrix_batches", "status!='committed' AND status!='discarded'"), pendingDeliveries: count("matrix_outbox", "status='pending'") };
  }

  private async syncLoop(): Promise<void> {
    let opened = false;
    while (!this.closed) {
      try {
        if (!opened) { await this.transport.open(); opened = true; }
        const sync = await this.transport.sync(this.store.meta("sync_token"));
        await this.ingest(sync);
        this.connected = true; this.lastError = undefined; this.lastSyncAt = Date.now();
        await this.tick();
      } catch (error) {
        if (this.closed) break;
        this.connected = false; this.lastError = codeOf(error);
        log.warn({ code: this.lastError }, "Matrix connection paused; durable input and output will retry");
        await pause(5000);
      }
    }
  }

  /** Save every event before advancing /sync. First activation establishes a baseline, never executes history. */
  async ingest(sync: MatrixSync): Promise<void> {
    const baseline = !this.store.meta("sync_token");
    const rooms: Array<{ roomId: string; events: MatrixEvent[] }> = [];
    for (const [roomId, joined] of Object.entries(sync.rooms?.join ?? {})) {
      if (!this.room(roomId)) continue;
      const timeline = joined.timeline;
      let events = timeline?.events ?? [];
      const last = this.store.db.prepare("SELECT last_event_id FROM matrix_rooms WHERE room_id=?").get(roomId) as { last_event_id: string } | undefined;
      if (!baseline && last?.last_event_id && timeline?.limited && !events.some(e => e.event_id === last.last_event_id)) {
        let from = timeline.prev_batch, found = false;
        const earlier: MatrixEvent[] = [];
        for (let pages = 0; from && pages < 100; pages++) {
          const page = await this.transport.history(roomId, from);
          for (const event of page.chunk) {
            if (event.event_id === last.last_event_id) { found = true; break; }
            earlier.push(event);
          }
          if (found || !page.end || page.end === from || !page.chunk.length) break;
          from = page.end;
        }
        if (!found) throw new Error("matrix_timeline_gap_unresolved");
        events = [...earlier.reverse(), ...events];
      }
      rooms.push({ roomId, events });
    }
    this.control.transaction(() => {
      for (const { roomId, events } of rooms) {
        const known = this.store.db.prepare("SELECT room_id FROM matrix_rooms WHERE room_id=?").get(roomId);
        if (!baseline && known) for (const event of events) {
          if (!event.event_id || !event.sender || !event.content) continue;
          this.store.db.prepare("INSERT OR IGNORE INTO matrix_inbox(event_id,room_id,event) VALUES(?,?,?)")
            .run(event.event_id, roomId, JSON.stringify(event));
        }
        this.store.db.prepare(`INSERT INTO matrix_rooms VALUES(?,?) ON CONFLICT(room_id)
          DO UPDATE SET last_event_id=COALESCE(excluded.last_event_id,matrix_rooms.last_event_id)`)
          .run(roomId, events.at(-1)?.event_id ?? null);
      }
      this.store.setMeta("sync_token", sync.next_batch);
    });
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    this.drainingInbox ??= this.drainInbox().finally(() => { this.drainingInbox = undefined; });
    await this.drainingInbox;
    try { this.capture(); } catch (error) { this.lastError = codeOf(error); }
    const media = this.connected ? this.store.db.prepare("SELECT * FROM matrix_media WHERE status='pending' ORDER BY seq LIMIT 12").all() as unknown as Media[] : [];
    for (const item of media) {
      if (this.downloads.has(item.event_id) || this.downloads.size >= 4) continue;
      this.downloads.set(item.event_id, this.download(item).finally(() => { this.downloads.delete(item.event_id); }));
    }
    const batches = this.store.db.prepare(`SELECT * FROM matrix_batches WHERE status IN ('pending','stopping','preparing','submitting','held')
      ORDER BY created_at,rowid`).all() as unknown as Batch[];
    for (const batch of batches) {
      if (batch.status === "held") continue;
      const binding = this.store.getBinding(batch.binding_id);
      if (!binding) continue;
      const lane = batch.session_id ?? binding.session_id ?? batch.binding_id;
      if (this.jobs.has(lane)) continue;
      const earlier = batches.find(b => (b.session_id ?? this.store.getBinding(b.binding_id)?.session_id ?? b.binding_id) === lane);
      if (earlier?.id !== batch.id) continue;
      this.jobs.set(lane, this.submit(batch.id).catch(error => this.hold(batch.id, codeOf(error))).finally(() => this.jobs.delete(lane)));
    }
    if (this.connected) this.flushing ??= this.flush().finally(() => { this.flushing = undefined; });
  }

  private async drainInbox(): Promise<void> {
    for (let count = 0; count < 200 && !this.closed; count++) {
      const row = this.store.db.prepare("SELECT * FROM matrix_inbox WHERE status='pending' ORDER BY seq LIMIT 1").get() as
        { event_id: string; room_id: string; event: string } | undefined;
      if (!row) return;
      try { await this.receive(row.room_id, JSON.parse(row.event) as MatrixEvent); }
      catch (error) {
        this.store.say(`input-error:${row.event_id}`, row.room_id, threadOf(JSON.parse(row.event).content), `未执行：${codeOf(error)}`);
      }
      this.store.db.prepare("UPDATE matrix_inbox SET status='done' WHERE event_id=?").run(row.event_id);
    }
  }

  private room(roomId: string): MatrixRoomConfig | undefined { return this.config.rooms.find(room => room.roomId === roomId); }
  private async receive(roomId: string, event: MatrixEvent): Promise<void> {
    const room = this.room(roomId);
    if (!room || event.sender === this.config.userId || !room.users.includes(event.sender)) return;
    const content = event.content, relation = content["m.relates_to"];
    if (relation?.rel_type === "m.replace") return;
    const replyId = event.type === "m.reaction" ? relation?.event_id : relation?.["m.in_reply_to"]?.event_id;
    const interaction = event.type === "m.reaction" && relation?.rel_type === "m.annotation"
      || event.type === "m.room.message" && content.msgtype === "m.text";
    if (interaction && typeof replyId === "string") {
      const prompt = this.store.db.prepare("SELECT * FROM matrix_outbox WHERE event_id=? AND pending_id IS NOT NULL AND room_id=?")
        .get(replyId, roomId) as unknown as Outgoing | undefined;
      if (prompt) { await this.answer(event, prompt); return; }
    }
    if (event.type === "m.reaction") return;
    if (event.type === "m.room.redaction") {
      const redacts = event.redacts ?? content.redacts;
      if (typeof redacts === "string") this.store.db.prepare(`UPDATE matrix_media SET status='failed',error='attachment_redacted'
        WHERE event_id=? AND sender=? AND (batch_id IS NULL OR batch_id IN (SELECT id FROM matrix_batches WHERE submit_body IS NULL))`)
        .run(redacts, event.sender);
      return;
    }
    if (event.type === "m.room.encrypted") {
      this.store.say(`encrypted:${event.event_id}`, roomId, "", "当前 Matrix 接入不支持加密消息，请使用未加密房间。"); return;
    }
    if (event.type !== "m.room.message") return;
    const threadId = threadOf(content), binding = this.store.binding(room, threadId);
    if (["m.image", "m.file", "m.audio", "m.video"].includes(content.msgtype)) {
      this.store.db.prepare(`INSERT OR IGNORE INTO matrix_media(event_id,binding_id,generation,sender,content) VALUES(?,?,?,?,?)`)
        .run(event.event_id, binding.id, binding.generation, event.sender, JSON.stringify(content));
      this.store.enqueue(`receipt:${event.event_id}`, roomId, threadId,
        { "m.relates_to": { rel_type: "m.annotation", event_id: event.event_id, key: "📎" } }, { type: "m.reaction" });
      return; // Captions and filenames NEVER submit or interrupt a turn.
    }
    if (content.msgtype !== "m.text") return;
    let text = plainBody(content);
    if (!text) return;
    const mentioned = content["m.mentions"]?.user_ids?.includes(this.config.userId) || text.includes(this.config.userId)
      || String(content.formatted_body ?? "").includes(`https://matrix.to/#/${this.config.userId}`);
    if (room.requireMention && !binding.session_id && threadId && !mentioned) return;
    if (room.requireMention && !threadId && !mentioned) return;
    text = text.replaceAll(this.config.userId, "").replace(/^\s*[:,，：]\s*/, "").trim();
    if (!text) return;
    const cmd = command(text);
    if (cmd) { await this.runCommand(event, binding, room, cmd); return; }
    this.control.transaction(() => {
      // Replay after a process crash cannot append the same text twice.
      if (this.store.meta(`text:${event.event_id}`)) return;
      const merging = this.store.db.prepare(`SELECT * FROM matrix_batches WHERE binding_id=? AND generation=? AND sender=?
        AND status IN ('pending','stopping','preparing') AND submit_body IS NULL ORDER BY created_at DESC LIMIT 1`)
        .get(binding.id, binding.generation, event.sender) as unknown as Batch | undefined;
      const id = merging?.id ?? event.event_id;
      if (merging) this.store.db.prepare("UPDATE matrix_batches SET text=text||char(10)||char(10)||? WHERE id=?").run(text, id);
      else this.store.db.prepare(`INSERT INTO matrix_batches(id,binding_id,generation,sender,text,session_id,target,scope_id,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',?)`).run(id, binding.id, binding.generation, event.sender, text, binding.session_id,
          binding.target, binding.scope_id, Date.now());
      this.store.db.prepare(`UPDATE matrix_media SET batch_id=? WHERE binding_id=? AND generation=? AND sender=? AND batch_id IS NULL AND status!='discarded'`)
        .run(id, binding.id, binding.generation, event.sender);
      this.store.setMeta(`text:${event.event_id}`, id);
    });
  }

  private async runCommand(event: MatrixEvent, binding: Binding, room: MatrixRoomConfig, cmd: { name: string; argument: string }): Promise<void> {
    const notice = (text: string): void => this.store.notice(`command:${event.event_id}`, binding, text);
    if (this.store.meta(`command:${event.event_id}`)) return;
    if (cmd.name === "help") notice("支持 ! 和 /：new [agent]、use <sessionId>、status、stop、help、retry、discard、drafts、restore <编号>。\n先连续上传附件，再单独发文字提交；最多 8 个，每个 15 MB。审批/问题请回复对应提示或使用提示中的反应。retry 重试保留的输入；discard 放弃未提交附件和输入；drafts 查看保留草稿，restore 返回草稿原来的会话绑定。");
    else if (cmd.name === "status") {
      const session = binding.session_id ? this.control.session(binding.session_id) : undefined;
      const target = JSON.parse(binding.target) as MatrixTarget;
      notice(`作用域：${binding.scope_id}\nWorker：${session?.workerId ?? target.workerId}\n会话：${binding.session_id ?? "将在提交时创建"}\n状态：${session?.status ?? "空闲"}\n模型：${(session?.context as Json)?.model ?? target.model ?? "worker 默认"}${binding.session_id ? `\n${this.link(binding.session_id)}` : ""}`);
    } else if (cmd.name === "drafts") {
      const rows = this.store.db.prepare(`SELECT generation,COUNT(*) n FROM matrix_media WHERE binding_id=? AND sender=?
        AND status!='discarded' AND (batch_id IS NULL OR batch_id IN (SELECT id FROM matrix_batches WHERE status='held')) GROUP BY generation`)
        .all(binding.id, event.sender) as Array<{ generation: number; n: number }>;
      notice(rows.length ? rows.map(row => `草稿 ${row.generation}：${row.n} 个附件${row.generation === binding.generation ? "（当前）" : `，!restore ${row.generation} 返回原绑定`}`).join("\n") : "没有附件草稿。");
    } else if (cmd.name === "new" || cmd.name === "use" || cmd.name === "restore") {
      if (this.store.db.prepare(`SELECT id FROM matrix_batches WHERE binding_id=? AND generation=? AND status IN ('pending','stopping','preparing','submitting')`)
        .get(binding.id, binding.generation)) throw new Error("已有提交正在处理，完成后再切换会话");
      this.capture(); // Pin any old turn's destination before changing the binding.
      if (cmd.name === "restore") {
        if (!/^\d+$/.test(cmd.argument)) throw new Error("请提供 drafts 列出的草稿编号");
        this.control.transaction(() => {
          this.store.restoreBinding(binding, Number(cmd.argument));
          this.store.setMeta(`command:${event.event_id}`, "done");
          notice(`已返回草稿 ${cmd.argument} 的原会话绑定。发文字提交未封批附件，或 !retry 重试已保留输入。`);
        });
        return;
      }
      let sessionId: string | undefined, target: MatrixTarget;
      if (cmd.name === "new") {
        target = room.targets[cmd.argument || room.defaultTarget]!;
        if (!target) throw new Error(`未知 agent，可用：${Object.keys(room.targets).join("、")}`);
      } else {
        sessionId = cmd.argument;
        const session = sessionId && this.control.session(sessionId);
        if (!session) throw new Error("session_not_found");
        if (this.store.db.prepare("SELECT id FROM matrix_bindings WHERE session_id=? AND id!=?").get(sessionId, binding.id))
          throw new Error("这个会话已绑定到另一个 Matrix 房间或线程，请在原位置继续");
        this.memory.bindExisting(sessionId, room.scopeId, room.roomId);
        target = { workerId: String(session.workerId), workspace: String(session.workspace) };
      }
      this.control.transaction(() => {
        this.store.switchBinding(binding, room.scopeId, target, sessionId);
        this.store.setMeta(`command:${event.event_id}`, "done");
        notice(`已切换到 ${sessionId ?? target.workerId}。原草稿保留在绑定 ${binding.generation}；用 !drafts 查看，!restore ${binding.generation} 返回。`);
      });
      if (sessionId) this.reconcilePending(sessionId);
      return;
    } else if (cmd.name === "stop") {
      const session = binding.session_id && this.control.session(binding.session_id);
      if (session && typeof session.activeTurnId === "string") {
        const receipt = await this.api.call(event.sender, `/sessions/${enc(binding.session_id!)}/interrupt`, { expectedTurnId: session.activeTurnId }, `matrix:stop:${keyHash(event.event_id)}`);
        const jobId = `stop:${event.event_id}`;
        this.jobs.set(jobId, this.settle(event.sender, receipt).then(() => {
          this.store.notice(`${jobId}:settled`, binding, "停止动作已确认；turn 的最终状态会更新在原消息上。");
        }, error => { this.store.notice(`${jobId}:failed`, binding, `停止未确认：${codeOf(error)}`); }).finally(() => { this.jobs.delete(jobId); }));
        notice("已请求停止当前 turn，等待结束确认。已经执行的操作不会撤销。");
      } else notice("当前没有运行中的 turn。");
    } else if (cmd.name === "retry") {
      const batch = this.store.db.prepare(`SELECT * FROM matrix_batches WHERE binding_id=? AND sender=? AND status='held'
        ORDER BY created_at LIMIT 1`).get(binding.id, event.sender) as unknown as Batch | undefined;
      if (!batch) notice("没有需要重试的输入。");
      else {
        const safeFailures = new Set(["worker_offline", "memory_context_unsupported", "update_required", "capability_unavailable", "image_unsupported"]);
        if (safeFailures.has(batch.error ?? "")) {
          const phase = batch.submit_body ? "turn" : batch.session_id ? "interrupt" : "create";
          const counter = `attempt:${phase}:${batch.id}`;
          this.store.setMeta(counter, String(Number(this.store.meta(counter) ?? 0) + 1));
          if (phase === "turn") this.store.db.prepare("UPDATE matrix_batches SET submit_body=NULL,action_id=NULL WHERE id=?").run(batch.id);
        }
        // The immutable action body/key is retained. An uncertain submission can only reconcile its original receipt.
        this.store.db.prepare("UPDATE matrix_batches SET status='pending',error=NULL WHERE id=?").run(batch.id);
        this.store.db.prepare("UPDATE matrix_media SET status='pending',error=NULL WHERE batch_id=? AND status='failed'").run(batch.id);
        notice("正在重试原输入；会先核对原动作结果，不会盲目重复发送。");
      }
    } else if (cmd.name === "discard") {
      const running = this.store.db.prepare("SELECT id FROM matrix_batches WHERE binding_id=? AND sender=? AND status IN ('stopping','preparing','submitting')")
        .get(binding.id, event.sender);
      if (running) throw new Error("提交正在处理，不能放弃；可先 stop");
      this.store.db.prepare("UPDATE matrix_batches SET status='discarded' WHERE binding_id=? AND sender=? AND status IN ('pending','held') AND submit_body IS NULL")
        .run(binding.id, event.sender);
      this.store.db.prepare("UPDATE matrix_media SET status='discarded' WHERE binding_id=? AND sender=? AND batch_id IS NULL")
        .run(binding.id, event.sender);
      notice("已放弃尚未发送的附件草稿和输入；结果不明的已发送动作仍保留以便核对。");
    }
    this.store.setMeta(`command:${event.event_id}`, "done");
  }

  private async download(media: Media): Promise<void> {
    try {
      const content = JSON.parse(media.content) as MatrixContent;
      const mime = String(content.info?.mimetype ?? (content.msgtype === "m.file" ? "application/octet-stream" : ""));
      if (content.file) throw new Error("encrypted_attachment_unsupported");
      if (content.msgtype === "m.audio" || content.msgtype === "m.video" || !(ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(mime))
        throw new Error("unsupported_attachment_type");
      if (Number(content.info?.size) > MAX_IMAGE_BYTES) throw new Error("attachment_too_large");
      const bytes = await this.transport.download(String(content.url ?? ""), MAX_IMAGE_BYTES);
      const filename = String(content.filename ?? content.body ?? "attachment").slice(0, 255);
      const ref = this.control.putAttachment(bytes, mime, filename);
      this.store.db.prepare("UPDATE matrix_media SET status='ready',attachment_id=?,error=NULL WHERE event_id=? AND status='pending'")
        .run(ref.id, media.event_id);
    } catch (error) {
      this.store.db.prepare("UPDATE matrix_media SET status='failed',error=? WHERE event_id=? AND status='pending'").run(codeOf(error), media.event_id);
      const binding = this.store.getBinding(media.binding_id);
      if (binding) this.store.notice(`media-error:${media.event_id}`, binding, `附件未就绪：${codeOf(error)}。整批输入会保留，不会只发送部分附件。`);
    }
  }

  private hold(id: string, error: string): void {
    this.store.db.prepare("UPDATE matrix_batches SET status='held',error=? WHERE id=? AND status!='committed'").run(error, id);
    const batch = this.store.batch(id), binding = this.store.getBinding(batch.binding_id);
    if (binding) this.store.notice(`held:${id}:${keyHash(error)}`, binding, `输入已保留，尚未确认提交成功：${error}。修复后发 !retry；不要重复粘贴原输入。`);
  }

  private async settle(sender: string, action: Json): Promise<Json> {
    const deadline = Date.now() + 135_000;
    while (action.status === "accepted" && !this.closed) {
      if (Date.now() > deadline) throw new Error("action_outcome_unknown");
      await pause(250);
      action = await this.api.call(sender, `/actions/${enc(action.actionId)}`);
    }
    if (this.closed) throw new Error("gateway_stopped");
    if (action.status !== "succeeded") throw new Error(action.error?.error?.code ?? action.error?.code ?? "action_failed");
    return action;
  }

  private async submit(id: string): Promise<void> {
    let batch = this.store.batch(id);
    const binding = this.store.getBinding(batch.binding_id)!;
    const target = JSON.parse(batch.target) as MatrixTarget;
    if (batch.scope_id !== this.room(binding.room_id)?.scopeId) throw new Error("room_scope_changed_original_input_retained");
    // A body that was sent is immutable. On restart reconcile that exact action before any interrupt.
    if (batch.submit_body) { await this.dispatch(batch, JSON.parse(batch.submit_body)); return; }
    let sessionId = batch.session_id ?? (batch.generation === binding.generation ? binding.session_id : null);
    if (!sessionId) {
      if (batch.generation !== binding.generation) throw new Error("binding_changed_original_input_retained");
      const body = batch.create_body ? JSON.parse(batch.create_body) as Json : {
        workerId: target.workerId, workspace: target.workspace, ...(target.model ? { model: target.model } : {}),
        memoryScopeId: batch.scope_id, originRoomId: binding.room_id,
      };
      this.store.db.prepare("UPDATE matrix_batches SET create_body=?,status='preparing' WHERE id=?").run(JSON.stringify(body), id);
      const created = await this.settle(batch.sender, await this.api.call(batch.sender, "/sessions", body, this.actionKey("create", id)));
      sessionId = String(created.sessionId);
      this.control.transaction(() => {
        this.store.db.prepare("UPDATE matrix_batches SET session_id=? WHERE id=?").run(sessionId!, id);
        this.store.db.prepare("UPDATE matrix_bindings SET session_id=? WHERE id=? AND generation=?").run(sessionId!, binding.id, batch.generation);
      });
    }
    this.store.db.prepare("UPDATE matrix_batches SET session_id=? WHERE id=?").run(sessionId, id);
    const session = this.control.session(sessionId);
    if (!session) throw new Error("session_not_found");
    const active = typeof session.activeTurnId === "string" ? session.activeTurnId : undefined;
    batch = this.store.batch(id);
    if (batch.interrupt_turn && active && batch.interrupt_turn !== active) throw new Error("turn_changed_during_interrupt");
    if (active) {
      this.store.db.prepare("UPDATE matrix_batches SET status='stopping',interrupt_turn=? WHERE id=?").run(active, id);
      const result = await this.api.call(batch.sender, `/sessions/${enc(sessionId)}/interrupt`, { expectedTurnId: active }, this.actionKey("interrupt", id));
      await this.settle(batch.sender, result);
      const deadline = Date.now() + 30_000;
      while (this.control.session(sessionId)?.activeTurnId === active && !this.closed) {
        if (Date.now() > deadline) throw new Error("interrupt_unconfirmed");
        await pause(100);
      }
      if (this.control.session(sessionId)?.activeTurnId) throw new Error("turn_changed_during_interrupt");
    }
    if (this.closed) return;
    this.store.db.prepare("UPDATE matrix_batches SET status='preparing' WHERE id=?").run(id);
    // Materialization runs independently; texts received during cancellation can join until dispatch freezes the body.
    let media = this.store.media(id);
    if (media.some(m => m.status === "pending")) return;
    if (media.some(m => m.status !== "ready")) throw new Error("attachment_batch_incomplete");
    if (media.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`附件超过 ${MAX_ATTACHMENTS_PER_MESSAGE} 个，请 discard 后分批重发`);
    const attachments: AttachmentRef[] = media.map(item => {
      const ref = this.control.getAttachment(item.attachment_id!);
      if (!ref) {
        this.store.db.prepare("UPDATE matrix_media SET status='pending',attachment_id=NULL WHERE event_id=?").run(item.event_id);
        throw new Error("attachment_expired_reloading");
      }
      const content = JSON.parse(item.content) as MatrixContent;
      return { id: ref.id, filename: String(content.filename ?? content.body ?? ref.filename).slice(0, 255), mimeType: ref.mimeType, size: ref.size };
    });
    if (!target.workerId.startsWith("codex@") && attachments.some(ref => !ref.mimeType.startsWith("image/")))
      throw new Error("当前 worker 只支持图片附件；整批输入未发送");
    batch = this.store.batch(id);
    this.memory.prepare({ sessionId, input: batch.text }); // Fail before freezing a submission if core context is unavailable.
    const body = { input: batch.text, delivery: "start_turn", ...(attachments.length ? { attachments } : {}) };
    this.store.db.prepare("UPDATE matrix_batches SET submit_body=?,status='submitting' WHERE id=?").run(JSON.stringify(body), id);
    await this.dispatch(this.store.batch(id), body);
  }
  private async dispatch(batch: Batch, body: Json): Promise<void> {
    const receipt = await this.api.call(batch.sender, `/sessions/${enc(batch.session_id!)}/turns`, body, this.actionKey("turn", batch.id));
    this.store.db.prepare("UPDATE matrix_batches SET action_id=? WHERE id=?").run(receipt.actionId, batch.id);
    await this.settle(batch.sender, receipt);
    this.store.db.prepare("UPDATE matrix_batches SET status='committed',error=NULL WHERE id=?").run(batch.id);
  }
  private actionKey(phase: string, id: string): string {
    return `matrix:${phase}:${keyHash(id)}:${this.store.meta(`attempt:${phase}:${id}`) ?? "0"}`;
  }

  private async answer(event: MatrixEvent, prompt: Outgoing): Promise<void> {
    const pending = this.control.pending(prompt.pending_id!);
    const binding = this.store.binding(this.room(prompt.room_id)!, prompt.thread_id);
    if (!pending || pending.status !== "pending") {
      this.store.notice(`answered:${event.event_id}`, binding, "这条审批或问题已经处理，本条回复不会作为新任务发送。"); return;
    }
    const key = event.type === "m.reaction" ? String(event.content["m.relates_to"]?.key ?? "") : plainBody(event.content);
    const numeric = numberKeys.indexOf(key) >= 0 ? numberKeys.indexOf(key) : /^\d+$/.test(key) ? Number(key) - 1 : -1;
    let path: string, body: Json;
    if (pending.kind === "approval") {
      const choices = pending.request.choices as string[];
      const aliases: Record<string, string> = { "✅": "allow", "❌": "deny", "允许": "allow", "拒绝": "deny", "本会话允许": "allow-session", "永久允许": "allow-always" };
      const choice = numeric >= 0 ? choices[numeric] : aliases[key] ?? key;
      if (!choice || !choices.includes(choice)) throw new Error("请使用这条审批实际提供的选项");
      path = `/approvals/${enc(pending.id)}/decision`; body = { choice };
    } else {
      const questions = pending.request.questions as Json[];
      if (questions.some(q => q.isSecret)) throw new Error("secret_input_must_be_answered_locally");
      const answers: Record<string, { answers: string[] }> = {};
      for (const [index, question] of questions.entries()) {
        const raw = questions.length === 1 ? key : key.split("\n").find(line => line.startsWith(`${index + 1}:`) || line.startsWith(`${index + 1}：`))?.slice(String(index + 1).length + 1).trim();
        if (!raw) throw new Error("多问题请逐行回复：1: 答案，2: 答案");
        const optionIndex = questions.length === 1 ? numeric : /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
        const values = question.options?.length && /^\d+(?:\s*[,，]\s*\d+)+$/.test(raw)
          ? raw.split(/[,，]/).map(s => s.trim()) : [raw];
        answers[String(question.id)] = { answers: optionIndex >= 0 && question.options?.[optionIndex]
          ? [String(question.options[optionIndex].label)] : values.map(value => /^\d+$/.test(value) && question.options?.[Number(value) - 1]
            ? String(question.options[Number(value) - 1].label) : value) };
      }
      path = `/user-input/${enc(pending.id)}/response`; body = { answers };
    }
    await this.api.call(event.sender, path, body, `matrix:answer:${keyHash(event.event_id)}`);
  }

  capture(): void {
    this.control.transaction(() => {
      const cursor = JSON.parse(this.store.meta("output_cursor")!) as { events: number; changes: number };
      const page = this.control.streamAfter(cursor, 500);
      for (const item of page.items) this.project(item);
      this.store.setMeta("output_cursor", JSON.stringify(page.position));
    });
  }
  private route(sessionId: string, turnId: string, sequence = Number.MAX_SAFE_INTEGER): TurnRoute | undefined {
    let route = this.store.db.prepare("SELECT * FROM matrix_turns WHERE session_id=? AND turn_id=?").get(sessionId, turnId) as unknown as TurnRoute | undefined;
    if (route) return route;
    let binding = this.store.db.prepare("SELECT * FROM matrix_bindings WHERE session_id=? AND after_event<? ORDER BY after_event DESC,rowid DESC LIMIT 1")
      .get(sessionId, sequence) as unknown as Binding | undefined;
    if (!binding) {
      const old = this.store.db.prepare(`SELECT binding FROM matrix_binding_history
        WHERE json_extract(binding,'$.session_id')=? AND json_extract(binding,'$.after_event')<?
        AND json_extract(binding,'$.untilEvent')>=? ORDER BY generation DESC LIMIT 1`)
        .get(sessionId, sequence, sequence) as { binding: string } | undefined;
      if (old) binding = JSON.parse(old.binding) as Binding;
    }
    if (!binding) return undefined;
    this.store.db.prepare("INSERT OR IGNORE INTO matrix_turns(session_id,turn_id,room_id,thread_id) VALUES(?,?,?,?)")
      .run(sessionId, turnId, binding.room_id, binding.thread_id);
    return this.store.db.prepare("SELECT * FROM matrix_turns WHERE session_id=? AND turn_id=?").get(sessionId, turnId) as unknown as TurnRoute;
  }
  private project(item: StreamItem): void {
    if (item.type === "approval.upserted" || item.type === "user_input.upserted") {
      const pending = this.control.pending(item.resourceId);
      if (pending) this.pending(pending);
      return;
    }
    if (item.type !== "session.event.appended" || !item.sessionId) return;
    const event = item.payload as { type: string; turnId?: string; payload: Json };
    if (!event.turnId) return;
    const route = this.route(item.sessionId, event.turnId, Number(item.eventId.split(":")[1]));
    if (!route || route.terminal) return;
    if (event.type === "message.completed" && event.payload.role === "assistant") {
      this.store.db.prepare("UPDATE matrix_turns SET last_text=? WHERE session_id=? AND turn_id=?")
        .run(String(event.payload.text ?? ""), item.sessionId, event.turnId);
    }
    const key = `turn:${item.sessionId}:${event.turnId}`;
    this.store.enqueue(`${key}:status`, route.room_id, route.thread_id, message(`正在处理…\n${this.link(item.sessionId)}`, route.thread_id));
    if (terminal.has(event.type)) {
      const current = this.store.db.prepare("SELECT last_text FROM matrix_turns WHERE session_id=? AND turn_id=?")
        .get(item.sessionId, event.turnId) as { last_text: string | null };
      const label = event.type === "turn.completed" ? "已完成" : event.type === "turn.interrupted" ? "已停止" : "执行失败";
      this.store.enqueue(`${key}:terminal`, route.room_id, route.thread_id, message(`${label}\n${this.link(item.sessionId)}`, route.thread_id), { replaceKey: `${key}:status` });
      const summary = event.payload.summary ?? event.payload.error?.message;
      const text = current.last_text || (typeof summary === "string" ? summary : "");
      if (text) this.store.say(`${key}:answer`, route.room_id, route.thread_id, event.type === "turn.interrupted" ? `（停止前的输出）\n\n${text}` : text);
      this.store.db.prepare("UPDATE matrix_turns SET terminal=1 WHERE session_id=? AND turn_id=?").run(item.sessionId, event.turnId);
    } else if (Date.now() - route.status_at > 3000) {
      const summary = String(event.payload.summary ?? (event.type === "message.completed" ? event.payload.text ?? "" : event.type)).slice(0, 1200);
      this.store.enqueue(`${key}:progress:${item.eventId}`, route.room_id, route.thread_id,
        message(`正在处理：${summary}\n${this.link(item.sessionId)}`, route.thread_id), { replaceKey: `${key}:status` });
      this.store.db.prepare("UPDATE matrix_turns SET status_at=? WHERE session_id=? AND turn_id=?").run(Date.now(), item.sessionId, event.turnId);
    }
  }
  private reconcilePending(sessionId: string): void {
    for (const kind of ["approval", "user_input"] as const) for (const item of this.control.listPending(kind, { sessionId, statuses: ["pending"], limit: 200 }).data) this.pending(item);
  }
  private pending(pending: PendingRow): void {
    const route = this.route(pending.sessionId, pending.turnId ?? `pending:${pending.id}`);
    if (!route) return;
    const key = `pending:${pending.id}`;
    if (pending.status !== "pending") {
      if (this.store.db.prepare("SELECT key FROM matrix_outbox WHERE key=?").get(`${key}:0`)) this.store.enqueue(`${key}:resolved`, route.room_id, route.thread_id,
        message(`已处理（${pending.status}）`, route.thread_id), { replaceKey: `${key}:0`, pendingId: pending.id });
      return;
    }
    let text: string;
    if (pending.kind === "approval") {
      const choices = pending.request.choices as string[];
      const names: Record<string, string> = { allow: "允许", deny: "拒绝", "allow-session": "本会话允许整个工具", "allow-always": "永久允许整个工具" };
      text = `需要审批：${String(pending.request.summary ?? "")}\n\n${choices.map((choice, i) => `${numberKeys[i] ?? i + 1} ${names[choice] ?? choice} (${choice})`).join("\n")}\n回复对应选项或对本消息添加相应反应。`;
    } else {
      const questions = pending.request.questions as Json[];
      text = questions.some(q => q.isSecret) ? "这条问题包含秘密输入，请在本地客户端回答。" : questions.map((q, i) =>
        `${i + 1}. ${q.question}\n${(q.options ?? []).map((o: Json, j: number) => `${numberKeys[j] ?? j + 1} ${o.label}${o.description ? `：${o.description}` : ""}`).join("\n")}`).join("\n\n")
        + (questions.length > 1 ? "\n逐行回复，例如：1: 答案\n2: 答案" : "\n请回复本消息；有选项时也可使用对应反应。");
    }
    this.store.say(key, route.room_id, route.thread_id, `${text}\n${this.link(pending.sessionId)}`, pending.id);
  }
  private link(sessionId: string): string { return `${this.config.controlCenterUrl?.replace(/\/$/, "") ?? ""}/control/sessions/${enc(sessionId)}`; }

  async flush(): Promise<void> {
    for (let i = 0; i < 100 && !this.closed; i++) {
      const row = this.store.db.prepare("SELECT * FROM matrix_outbox WHERE status='pending' AND next_at<=? ORDER BY seq LIMIT 1")
        .get(Date.now()) as unknown as Outgoing | undefined;
      if (!row) return;
      if (!this.room(row.room_id)) { this.store.db.prepare("UPDATE matrix_outbox SET status='disabled' WHERE seq=?").run(row.seq); continue; }
      let content = JSON.parse(row.content) as MatrixContent;
      if (row.replace_key) {
        const original = this.store.db.prepare("SELECT event_id FROM matrix_outbox WHERE key=?").get(row.replace_key) as { event_id: string | null } | undefined;
        if (!original?.event_id) { this.store.db.prepare("UPDATE matrix_outbox SET next_at=? WHERE seq=?").run(Date.now() + 1000, row.seq); continue; }
        content = { ...content, body: `* ${content.body}`, "m.new_content": content,
          "m.relates_to": { rel_type: "m.replace", event_id: original.event_id } };
      }
      try {
        const id = await this.transport.send(row.room_id, row.type, content, `ab_${keyHash(row.key)}`);
        this.store.db.prepare("UPDATE matrix_outbox SET status='sent',event_id=? WHERE seq=?").run(id, row.seq);
      } catch (error) {
        this.lastError = codeOf(error);
        const retryAfter = Number((error as { retry_after_ms?: number }).retry_after_ms) || 0;
        this.store.db.prepare("UPDATE matrix_outbox SET attempts=attempts+1,next_at=? WHERE seq=?")
          .run(Date.now() + Math.max(retryAfter, Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6))), row.seq);
        return;
      }
    }
  }
}
