import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ConnectorConfig } from "./config.js";
import { ControlError, type ControlClient, type Json, type StreamItem } from "./control.js";
import { MatrixError, type Content, type MatrixClient, type MatrixEvent, type SyncResponse } from "./matrix.js";
import { NUMBER_KEYS, command, mentions, message, plainBody, split, threadOf, withoutMention, type Command } from "./render.js";

const CONNECTOR = "matrix";
const MAX_ATTACHMENTS = 8, MAX_BYTES = 15_000_000;
const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv"];
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const log = (level: "info" | "warn" | "error", msg: string, extra: Json = {}) =>
  process.stdout.write(`${JSON.stringify({ level, msg, ...extra, time: new Date().toISOString() })}\n`);

interface Prompt { eventId: string; roomId: string; threadId: string; kind: "approval" | "user_input"; id: string; choices?: string[]; questions?: Json[] }
interface State { since?: string; cursor?: string; accessToken?: string; deviceId?: string; prompts?: Prompt[] }
interface Place { roomId: string; threadId: string }
interface Attachment { id: string; filename: string; mimeType: string; size: number }

/**
 * Matrix rooms as Agent Bridge conversations. A room's project is its central memory scope and the
 * session each room/thread continues lives in the Control Plane; this process keeps only its sync
 * position, stream cursor and open prompts. Each conversation handles its messages in order; a new
 * message stops the running turn first, since Matrix has no stop button.
 */
export class MatrixConnector {
  private state: State = {};
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly places = new Map<string, Place>();          // sessionId → where it reports
  private readonly orphans = new Map<string, StreamItem[]>();  // events of sessions not bound yet
  private readonly lastText = new Map<string, string>();       // sessionId → last assistant message
  private readonly typing = new Map<string, NodeJS.Timeout>(); // sessionId → typing refresh
  private readonly queues = new Map<string, Promise<void>>();
  private readonly drafts = new Map<string, Array<Promise<Attachment | undefined>>>();
  private outbox: Promise<void> = Promise.resolve();
  private displayName?: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(private readonly config: ConnectorConfig, private readonly matrix: MatrixClient, private readonly control: ControlClient) {}

  async start(): Promise<void> {
    try { this.state = JSON.parse(await readFile(this.config.stateFile, "utf8")) as State; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.login();
    this.displayName = await this.matrix.profileName(this.config.userId).catch(() => undefined);
    for (const row of (await this.control.call("GET", `/conversations/${CONNECTOR}`)).data as Array<Json>)
      this.places.set(row.sessionId, { roomId: row.roomId, threadId: row.threadId });
    void this.streamLoop();
    await this.syncLoop();
  }

  stop(): void { this.stopped = true; this.abort.abort(); }

  private async login(): Promise<void> {
    const token = this.config.accessToken ?? this.state.accessToken;
    if (token) this.matrix.useToken(token);
    else {
      const login = await this.matrix.login(this.config.userId, this.config.password!);
      this.state.accessToken = login.accessToken; this.state.deviceId = login.deviceId;
      await this.save();
    }
    const who = await this.matrix.whoami();
    if (who.user_id !== this.config.userId) throw new Error("matrix_token_identity_mismatch");
    log("info", "Matrix connector signed in", { userId: who.user_id, deviceId: who.device_id });
  }

  // ---- Matrix → Agent Bridge ------------------------------------------------

  private async syncLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const sync = await this.matrix.sync(this.state.since, this.abort.signal);
        // The first sync only sets a baseline: history is never replayed as new work.
        if (this.state.since) await this.ingest(sync);
        this.state.since = sync.next_batch;
        this.scheduleSave();
      } catch (error) {
        if (this.stopped) return;
        log("warn", "Matrix sync failed; retrying", { error: describe(error) });
        await pause(5_000);
      }
    }
  }

  private async ingest(sync: SyncResponse): Promise<void> {
    for (const [roomId, invite] of Object.entries(sync.rooms?.invite ?? {})) {
      const member = invite.invite_state?.events?.find((event) => event.type === "m.room.member" && event.state_key === this.config.userId);
      if (member && this.config.allowedUsers.includes(member.sender))
        await this.matrix.join(roomId).catch((error) => log("warn", "Unable to join room", { roomId, error: describe(error) }));
    }
    for (const [roomId, joined] of Object.entries(sync.rooms?.join ?? {}))
      for (const event of joined.timeline?.events ?? []) this.receive(roomId, event);
  }

  private receive(roomId: string, event: MatrixEvent): void {
    if (event.sender === this.config.userId || !this.config.allowedUsers.includes(event.sender)) return;
    const content = event.content ?? {}, relation = content["m.relates_to"];
    if (event.type === "m.reaction") {
      const prompt = this.prompt(relation?.event_id);
      if (prompt && relation?.rel_type === "m.annotation") this.enqueue(prompt, () => this.answer(prompt, String(relation.key ?? ""), event));
      return;
    }
    if (event.type !== "m.room.message" || relation?.rel_type === "m.replace") return;
    let place: Place = { roomId, threadId: threadOf(content) };
    if (["m.image", "m.file"].includes(content.msgtype)) { this.stage(place, event); return; }
    if (content.msgtype !== "m.text") return;
    const prompt = this.prompt(relation?.["m.in_reply_to"]?.event_id);
    let text = plainBody(content);
    if (prompt) { this.enqueue(prompt, () => this.answer(prompt, text, event)); return; }
    if (!place.threadId && mentions(content, this.config.userId)) {
      // @ in the main timeline opens a parallel session, answered in a thread rooted at this message.
      const drafts = this.drafts.get(key(place));
      place = { roomId, threadId: event.event_id };
      if (drafts) { this.drafts.delete(key({ roomId, threadId: "" })); this.drafts.set(key(place), drafts); }
    }
    text = withoutMention(text, this.config.userId, this.displayName);
    if (!text) return;
    const cmd = command(text);
    this.enqueue(place, () => cmd ? this.runCommand(place, cmd, event) : this.submit(place, text, event));
  }

  /** Attachments wait for the next text in their conversation and go with it. */
  private stage(place: Place, event: MatrixEvent): void {
    const content = event.content;
    const list = this.drafts.get(key(place)) ?? [];
    this.drafts.set(key(place), list);
    list.push((async () => {
      try {
        const mimeType = String(content.info?.mimetype ?? (content.msgtype === "m.file" ? "application/octet-stream" : ""));
        if (content.file) throw new Error("加密附件暂不支持");
        if (!ATTACHMENT_TYPES.includes(mimeType)) throw new Error(`不支持的附件类型 ${mimeType || "未知"}`);
        const bytes = await this.matrix.download(String(content.url ?? ""), MAX_BYTES);
        const filename = String(content.filename ?? content.body ?? "attachment").slice(0, 255);
        const ref = await this.control.call("POST", "/attachments", { filename, mimeType, content: bytes.toString("base64") });
        void this.react(place.roomId, event.event_id, "📎");
        return { id: String(ref.id), filename, mimeType, size: Number(ref.size ?? bytes.length) };
      } catch (error) {
        this.say(place, `附件未收下：${describe(error)}`, `attachment-error:${event.event_id}`);
        return undefined;
      }
    })());
  }

  private enqueue(place: Place, task: () => Promise<void>): void {
    const id = key(place);
    const next = (this.queues.get(id) ?? Promise.resolve()).then(task).catch((error) => {
      log("warn", "Matrix message not handled", { error: describe(error) });
      this.say(place, `未执行：${describe(error)}`);
    });
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); });
  }

  private conversation(place: Place): Promise<Json> {
    return this.control.call("GET", `/conversations/${CONNECTOR}/${enc(place.roomId)}?threadId=${enc(place.threadId)}`);
  }

  private async submit(place: Place, text: string, event: MatrixEvent): Promise<void> {
    const conversation = await this.conversation(place);
    if (conversation.problem) { this.say(place, problemText(conversation)); return; }
    const pending = this.drafts.get(key(place)) ?? [];
    this.drafts.delete(key(place));
    const attachments = (await Promise.all(pending)).filter((item): item is Attachment => Boolean(item)).slice(0, MAX_ATTACHMENTS);
    const extra = attachments.length ? { attachments } : {};
    if (conversation.sessionId) {
      const sessionId = String(conversation.sessionId);
      for (let attempt = 0; ; attempt++) {
        await this.stopActive(sessionId, `${event.event_id}:${attempt}`);
        try {
          await this.control.settle(await this.control.call("POST", `/sessions/${enc(sessionId)}/turns`,
            { input: text, delivery: "start_turn", ...extra }, `matrix:turn:${hash(event.event_id)}`));
          return;
        } catch (error) {
          // Another client started a turn meanwhile: stop that one too, once.
          if (!(error instanceof ControlError && error.code === "turn_already_active") || attempt > 0) throw error;
        }
      }
    }
    if (!conversation.target) { this.say(place, problemText(conversation)); return; }
    const created = await this.control.settle(await this.control.call("POST", "/sessions", {
      workerId: conversation.target.workerId, workspace: conversation.target.workspace, input: text,
      memoryScope: conversation.scope?.id, ...extra }, `matrix:create:${hash(event.event_id)}`), 180_000);
    const sessionId = String(created.sessionId);
    await this.control.call("PUT", `/conversations/${CONNECTOR}/${enc(place.roomId)}`, { threadId: place.threadId, sessionId });
    this.bindPlace(sessionId, place);
  }

  /** Interrupt the session's running turn and wait until it has really ended. */
  private async stopActive(sessionId: string, keySuffix: string): Promise<boolean> {
    const session = await this.control.call("GET", `/sessions/${enc(sessionId)}`);
    const turnId = typeof session.activeTurnId === "string" ? session.activeTurnId : undefined;
    if (!turnId) return false;
    try {
      await this.control.settle(await this.control.call("POST", `/sessions/${enc(sessionId)}/interrupt`,
        { expectedTurnId: turnId }, `matrix:stop:${hash(keySuffix)}`));
    } catch (error) {
      if (!(error instanceof ControlError && ["no_active_turn", "turn_changed"].includes(error.code))) throw error;
    }
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await pause(300)) {
      const current = await this.control.call("GET", `/sessions/${enc(sessionId)}`);
      if (current.activeTurnId !== turnId) return true;
    }
    throw new Error("停止请求已发送，但旧 turn 尚未结束；这条消息没有发送");
  }

  private async runCommand(place: Place, cmd: Command, event: MatrixEvent): Promise<void> {
    const room = `/conversations/${CONNECTOR}/${enc(place.roomId)}`;
    if (cmd.name === "help") {
      this.say(place, [
        "直接发消息就是继续当前会话；新消息会先停止正在运行的 turn。",
        "`!new [pi|codex|claude|grok]` 下一条消息开新会话（默认沿用上次的 agent）",
        "`!stop` 停止当前 turn　`!status` 查看绑定　`!bind <scope> [机器:/路径]` 把房间绑定到记忆作用域",
        "主时间线里 @我 会开一个并行会话，在线程里回复；线程里的消息只发给该线程的会话。",
        "先发图片/文件再发文字，附件会随这条文字一起提交。审批和提问：回复对应消息或添加提示中的反应。",
      ].join("\n"));
    } else if (cmd.name === "new") {
      const agent = cmd.args[0];
      const conversation = await this.control.call("PUT", room, { threadId: place.threadId, sessionId: null, ...(agent ? { agent } : {}) });
      for (const [sessionId, bound] of this.places) if (key(bound) === key(place)) this.places.delete(sessionId);
      this.say(place, `好的，下一条消息用 ${conversation.agent} 开新会话。`);
    } else if (cmd.name === "stop") {
      const conversation = await this.conversation(place);
      const stopped = conversation.sessionId ? await this.stopActive(String(conversation.sessionId), `stop:${event.event_id}`) : false;
      this.say(place, stopped ? "已停止。" : "现在没有正在运行的 turn。");
    } else if (cmd.name === "status") {
      const conversation = await this.conversation(place);
      const session = conversation.sessionId ? await this.control.call("GET", `/sessions/${enc(conversation.sessionId)}`).catch(() => undefined) : undefined;
      this.say(place, [
        `作用域：${conversation.scope ? `${conversation.scope.title}（${conversation.scope.id}）` : "未绑定"}`,
        `会话：${conversation.sessionId ?? "下一条消息时创建"}${session ? `，${session.status}` : ""}`,
        `Worker：${session?.workerId ?? conversation.target?.workerId ?? "—"}　目录：${session?.workspace ?? conversation.target?.workspace ?? "—"}`,
        `新会话 agent：${conversation.agent}`,
        ...(conversation.problem ? [problemText(conversation)] : []),
      ].join("\n"));
    } else if (cmd.name === "bind") {
      const [scopeId, location] = cmd.args;
      if (!scopeId) { this.say(place, "用法：`!bind <scope> [机器:/路径]`"); return; }
      const conversation = await this.control.call("POST", `${room}/bind`, { scopeId, ...(location ? { location } : {}) });
      this.say(place, `已绑定到 ${conversation.scope?.title ?? scopeId}（${scopeId}）。${conversation.problem ? problemText(conversation) : ""}`);
    }
  }

  // ---- Agent Bridge → Matrix ------------------------------------------------

  private async streamLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.control.stream(this.state.cursor, this.abort.signal, (item) => {
          this.state.cursor = item.cursor; this.scheduleSave();
          try { this.project(item); } catch (error) { log("warn", "Unable to forward an event", { error: describe(error) }); }
        });
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof ControlError && (error.code === "cursor_expired" || error.code === "invalid_cursor")) this.state.cursor = undefined;
        log("warn", "Agent Bridge stream ended; reconnecting", { error: describe(error) });
      }
      await pause(3_000);
    }
  }

  private project(item: StreamItem): void {
    const sessionId = item.sessionId;
    if (!sessionId) return;
    if (item.type === "session.deleted") { this.places.delete(sessionId); return; }
    const place = this.places.get(sessionId);
    if (!place) {
      if (item.type !== "session.event.appended") return;
      // A session this connector just created reports before its binding is stored.
      const buffered = this.orphans.get(sessionId) ?? [];
      buffered.push(item);
      this.orphans.delete(sessionId); this.orphans.set(sessionId, buffered.slice(-200));
      while (this.orphans.size > 50) this.orphans.delete(this.orphans.keys().next().value!);
      return;
    }
    if (item.type === "approval.upserted" || item.type === "user_input.upserted") { this.pending(place, item); return; }
    if (item.type !== "session.event.appended") return;
    const event = item.data as { type: string; turnId?: string; payload: Json };
    if (event.type === "turn.started") this.setTyping(sessionId, place, true);
    else if (event.type === "message.completed" && event.payload.role === "assistant" && typeof event.payload.text === "string")
      this.lastText.set(sessionId, event.payload.text);
    else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
      this.setTyping(sessionId, place, false);
      const text = this.lastText.get(sessionId) ?? (typeof event.payload.summary === "string" ? event.payload.summary : "");
      this.lastText.delete(sessionId);
      const id = `${sessionId}:${event.turnId ?? item.cursor}`;
      if (event.type === "turn.completed" && text) this.say(place, text, `answer:${id}`);
      if (event.type === "turn.failed") {
        const error = event.payload.error?.message ?? event.payload.error ?? event.payload.summary ?? "未知错误";
        this.say(place, `执行失败：${typeof error === "string" ? error : JSON.stringify(error)}${text && text !== error ? `\n\n${text}` : ""}`, `failed:${id}`);
      }
    }
  }

  private bindPlace(sessionId: string, place: Place): void {
    for (const [other, bound] of this.places) if (key(bound) === key(place)) this.places.delete(other);
    this.places.set(sessionId, place);
    const buffered = this.orphans.get(sessionId) ?? [];
    this.orphans.delete(sessionId);
    for (const item of buffered) this.project(item);
  }

  private setTyping(sessionId: string, place: Place, on: boolean): void {
    clearInterval(this.typing.get(sessionId));
    this.typing.delete(sessionId);
    const send = (value: boolean) => void this.matrix.typing(place.roomId, this.config.userId, value).catch(() => undefined);
    send(on);
    if (on) { const timer = setInterval(() => send(true), 25_000); timer.unref(); this.typing.set(sessionId, timer); }
  }

  private pending(place: Place, item: StreamItem): void {
    const row = item.data, id = String(row.id);
    const prompts = this.state.prompts ??= [];
    if (row.status !== "pending") {
      this.state.prompts = prompts.filter((prompt) => prompt.id !== id); this.scheduleSave(); return;
    }
    if (prompts.some((prompt) => prompt.id === id)) return;
    let text: string;
    const kind = item.type === "approval.upserted" ? "approval" : "user_input";
    if (kind === "approval") {
      const names: Record<string, string> = { allow: "允许", deny: "拒绝", "allow-session": "本会话允许整个工具", "allow-always": "永久允许整个工具" };
      const choices = (row.choices ?? []) as string[];
      text = `**需要审批**：${String(row.summary ?? "")}\n\n${choices.map((choice, i) => `${NUMBER_KEYS[i] ?? i + 1} ${names[choice] ?? choice}`).join("\n")}\n\n回复数字，或添加对应反应（✅ 允许 / ❌ 拒绝）。`;
    } else {
      const questions = (row.questions ?? []) as Json[];
      if (questions.some((question) => question.isSecret)) text = "agent 在等一个秘密输入，请到本地客户端回答。";
      else text = questions.map((question, i) => `${questions.length > 1 ? `${i + 1}. ` : ""}${question.question}\n${((question.options ?? []) as Json[])
        .map((option, j) => `${NUMBER_KEYS[j] ?? j + 1} ${option.label}${option.description ? `：${option.description}` : ""}`).join("\n")}`).join("\n\n")
        + (questions.length > 1 ? "\n\n回复本消息，逐行写：`1: 答案`、`2: 答案`" : "\n\n回复本消息作答；有选项时也可回复数字或添加对应反应。");
    }
    const prompt: Prompt = { eventId: "", roomId: place.roomId, threadId: place.threadId, kind, id,
      ...(kind === "approval" ? { choices: row.choices } : { questions: row.questions }) };
    prompts.push(prompt);
    this.state.prompts = prompts.slice(-200);
    this.say(place, text, `pending:${id}`, (eventId) => { prompt.eventId = eventId; this.scheduleSave(); });
  }

  private prompt(eventId: unknown): Prompt | undefined {
    return typeof eventId === "string" ? this.state.prompts?.find((prompt) => prompt.eventId === eventId) : undefined;
  }

  private async answer(prompt: Prompt, reply: string, event: MatrixEvent): Promise<void> {
    const value = reply.trim();
    const number = NUMBER_KEYS.indexOf(value) >= 0 ? NUMBER_KEYS.indexOf(value) : /^\d+$/.test(value) ? Number(value) - 1 : -1;
    const answerKey = `matrix:answer:${hash(event.event_id)}`;
    try {
      if (prompt.kind === "approval") {
        const aliases: Record<string, string> = { "✅": "allow", "👍": "allow", "❌": "deny", "👎": "deny", 允许: "allow", 拒绝: "deny" };
        const choices = prompt.choices ?? [];
        const choice = number >= 0 ? choices[number] : aliases[value] ?? value;
        if (!choice || !choices.includes(choice)) { this.say(prompt, "请用这条审批提供的选项回答。"); return; }
        await this.control.call("POST", `/approvals/${enc(prompt.id)}/decision`, { choice }, answerKey);
      } else {
        const questions = prompt.questions ?? [];
        if (questions.some((question) => question.isSecret)) { this.say(prompt, "秘密输入请到本地客户端回答。"); return; }
        const answers: Record<string, { answers: string[] }> = {};
        for (const [index, question] of questions.entries()) {
          const raw = questions.length === 1 ? value
            : value.split("\n").map((line) => /^(\d+)\s*[:：]\s*(.*)$/.exec(line.trim())).find((match) => match && Number(match[1]) === index + 1)?.[2]?.trim();
          if (!raw) { this.say(prompt, "多个问题请逐行回复：`1: 答案`、`2: 答案`"); return; }
          const options = (question.options ?? []) as Json[];
          const pick = (text: string) => {
            const n = NUMBER_KEYS.indexOf(text) >= 0 ? NUMBER_KEYS.indexOf(text) : /^\d+$/.test(text) ? Number(text) - 1 : -1;
            return n >= 0 && options[n] ? String(options[n]!.label) : text;
          };
          answers[String(question.id)] = { answers: options.length && /^\d+(\s*[,，]\s*\d+)+$/.test(raw) ? raw.split(/[,，]/).map((part) => pick(part.trim())) : [pick(raw)] };
        }
        await this.control.call("POST", `/user-input/${enc(prompt.id)}/response`, { answers }, answerKey);
      }
      void this.react(prompt.roomId, event.event_id, "✔️");
    } catch (error) {
      if (error instanceof ControlError && error.status === 404 || error instanceof ControlError && /already_resolved/.test(error.code))
        this.say(prompt, "这条请求已经处理过了。");
      else throw error;
    }
  }

  // ---- output ---------------------------------------------------------------

  /** Send in order; `id` makes the Matrix transaction stable, so a retried send is not duplicated. */
  private say(place: Place, text: string, id?: string, sent?: (eventId: string) => void): void {
    const base = id ?? `${Date.now()}:${Math.random()}`;
    split(text).forEach((part, index) => this.send(place.roomId, "m.room.message", message(part, place.threadId),
      `${base}:${index}`, index === 0 ? sent : undefined));
  }

  private react(roomId: string, eventId: string, emoji: string): void {
    this.send(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji } }, `react:${eventId}:${emoji}`);
  }

  private send(roomId: string, type: string, content: Content, id: string, sent?: (eventId: string) => void): void {
    this.outbox = this.outbox.then(async () => {
      for (let attempt = 0; attempt < 5 && !this.stopped; attempt++) {
        try { const eventId = await this.matrix.send(roomId, type, content, `ab-${hash(id)}`); sent?.(eventId); return; }
        catch (error) {
          const permanent = error instanceof MatrixError && error.status >= 400 && error.status < 500 && error.status !== 429;
          log("warn", "Matrix send failed", { roomId, error: describe(error), attempt });
          if (permanent) return;
          await pause(error instanceof MatrixError && error.retryAfterMs ? error.retryAfterMs : 1_000 * 2 ** attempt);
        }
      }
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1_000);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    const temporary = `${this.config.stateFile}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
      await rename(temporary, this.config.stateFile);
    } catch (error) { log("error", "Unable to save connector state", { error: describe(error) }); }
  }
}

const enc = encodeURIComponent;
const key = (place: Place) => `${place.roomId}|${place.threadId}`;

function describe(error: unknown): string {
  if (error instanceof ControlError || error instanceof MatrixError) return error.message || (error as { code?: string }).code || "error";
  return error instanceof Error ? error.message : String(error);
}

function problemText(conversation: Json): string {
  if (conversation.problem === "room_unbound") return "这个房间还没绑定项目。用 `!bind <scope>` 把它绑定到一个记忆作用域。";
  if (conversation.problem === "scope_has_no_workspace")
    return `作用域 ${conversation.scope?.id} 没有可用的工作目录。用 \`!bind ${conversation.scope?.id} <机器>:/路径\` 绑定一个。`;
  if (conversation.problem === "memory_unavailable") return "Control Plane 没有启用中央记忆，无法确定房间对应的项目。";
  return String(conversation.problem ?? "");
}
