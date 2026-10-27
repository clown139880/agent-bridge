import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { DesktopIpc, applyDesktopPatches, desktopError, type DesktopRecord } from "./desktop-ipc.js";

export interface DesktopState { owner: string; revision: number; state?: DesktopRecord; fresh: boolean; }
export function desktopTurns(state: DesktopRecord): DesktopRecord[] {
  const canonical = state.turnHistory?.history;
  if (canonical?.entitiesByKey) {
    const keys = (canonical.islands ?? []).flatMap((island: DesktopRecord) => (island.entries ?? []).map((entry: DesktopRecord) => entry.value));
    return keys.map((key: string) => canonical.entitiesByKey[key]).filter(Boolean);
  }
  return Array.isArray(state.turns) ? state.turns : [];
}
export class CodexDesktop {
  readonly ipc: DesktopIpc;
  readonly sessions = new Map<string, DesktopState>();
  private chains = new Map<string, Promise<void>>();
  private signatures = new Map<string, string>();
  private requests = new Map<string, Map<string, DesktopRecord>>();
  private observedTurns = new Map<string, string>();
  private following = new Map<string, Promise<boolean>>();
  private replayLatest = new Set<string>();
  constructor(private readonly options: {
    endpoint?: string;
    notify: (method: string, params: DesktopRecord) => Promise<void>;
    request: (message: DesktopRecord) => void;
    validatePath: (cwd: string) => boolean;
    onError: (error: unknown) => void;
  }) {
    this.ipc = new DesktopIpc(options.endpoint, message => this.onBroadcast(message), () => {
      for (const session of this.sessions.values()) session.fresh = false;
    });
  }
  async available(): Promise<boolean> {
    try { await this.ipc.ready(); return true; }
    catch (error) { if ((error as { code?: string }).code === "desktop_unavailable") return false; throw error; }
  }
  follow(threadId: string, replayLatest = false): Promise<boolean> {
    if (replayLatest) this.replayLatest.add(threadId);
    const pending = this.following.get(threadId); if (pending) return pending;
    const result = this.followInternal(threadId).finally(() => { if (this.following.get(threadId) === result) this.following.delete(threadId); });
    this.following.set(threadId, result); return result;
  }
  private async followInternal(threadId: string): Promise<boolean> {
    if (!await this.available()) {
      if (this.sessions.has(threadId)) throw desktopError("desktop_unavailable", "This session belongs to Codex Desktop; reopen Desktop before continuing", true);
      return false;
    }
    let response: DesktopRecord;
    try { response = await this.ipc.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, 1); }
    catch (error) {
      if ((error as { code?: string }).code !== "desktop_no_owner") throw error;
      if (this.sessions.has(threadId)) throw desktopError("desktop_no_owner", "Desktop no longer owns this session; reopen its chat before continuing", true);
      return false;
    }
    const owner = response.handledByClientId;
    const previous = this.sessions.get(threadId);
    if (!previous || previous.owner !== owner || !previous.fresh) {
      this.sessions.set(threadId, { owner, revision: -1, fresh: false });
      this.ipc.notify("thread-stream-following-changed", { hostId: "local", conversationId: threadId, following: true }, 1, [owner]);
      const deadline = Date.now() + 5000;
      while (!this.sessions.get(threadId)?.fresh && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (!this.sessions.get(threadId)?.fresh) throw desktopError("desktop_snapshot_unavailable", "Desktop did not provide a compatible session snapshot", true);
    }
    await this.chains.get(threadId);
    return true;
  }
  state(threadId: string): DesktopRecord {
    const session = this.sessions.get(threadId);
    if (!session?.fresh || !session.state) throw desktopError("desktop_state_stale", "Desktop session state is stale; refresh before sending", true);
    if (typeof session.state.cwd !== "string" || !this.options.validatePath(session.state.cwd)) throw desktopError("workspace_not_allowed", "Desktop session is outside BRIDGE_ALLOWED_ROOTS");
    return session.state;
  }
  private onBroadcast(message: DesktopRecord): void {
    if (message.method === "client-status-changed" && message.params?.status === "disconnected") {
      for (const session of this.sessions.values()) if (session.owner === message.params.clientId) session.fresh = false;
      return;
    }
    if (message.method !== "thread-stream-state-changed" || message.version !== 11 || message.params?.hostId !== "local") return;
    const threadId = message.params.conversationId, session = this.sessions.get(threadId);
    if (!session || session.owner !== message.sourceClientId) return;
    const change = message.params.change;
    try {
      const first = !session.state;
      if (change.type === "snapshot") session.state = change.conversationState;
      else if (change.type === "patches" && session.fresh && change.baseRevision === session.revision && session.state) {
        session.state = applyDesktopPatches(session.state, change.patches);
      } else { this.resnapshot(threadId, session); return; }
      session.revision = change.revision; session.fresh = true;
      const snapshot = session.state!;
      const chain = (this.chains.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => this.ingest(threadId, snapshot, first));
      this.chains.set(threadId, chain);
      void chain.catch(this.options.onError);
    } catch (error) { this.options.onError(error); this.resnapshot(threadId, session); }
  }
  private resnapshot(threadId: string, session: DesktopState): void {
    if (!session.fresh) return;
    session.fresh = false;
    this.ipc.notify("thread-stream-following-changed", { hostId: "local", conversationId: threadId, following: false }, 1, [session.owner]);
    this.ipc.notify("thread-stream-following-changed", { hostId: "local", conversationId: threadId, following: true }, 1, [session.owner]);
  }
  private async ingest(threadId: string, state: DesktopRecord, first: boolean): Promise<void> {
    if (typeof state.cwd !== "string" || !this.options.validatePath(state.cwd)) return;
    await this.options.notify("thread/updated", { thread: { id: threadId, cwd: state.cwd, name: state.title,
      model: state.latestModel, createdAt: state.createdAt / 1000, updatedAt: state.updatedAt / 1000 } });
    const turns = desktopTurns(state), replayLatest = this.replayLatest.delete(threadId);
    for (const turn of turns) {
      if (!turn.turnId) continue;
      const key = `${threadId}:${turn.turnId}`;
      const previous = this.observedTurns.get(key);
      if (first && turn.status !== "inProgress" && !previous && !(replayLatest && turn === turns.at(-1))) { this.observedTurns.set(key, turn.status); continue; }
      if (turn.status !== "inProgress" && previous === turn.status) continue;
      const normalized = { ...turn, id: turn.turnId, startedAt: turn.turnStartedAtMs, model: turn.params?.model };
      if (!previous || (turn.status === "inProgress" && previous !== "inProgress")) await this.options.notify("turn/started", { threadId, turn: normalized });
      for (const item of turn.items ?? []) {
        const itemKey = `${key}:${item.id}`, signature = createHash("sha256").update(JSON.stringify(item)).digest("hex");
        if (this.signatures.get(itemKey) === signature) continue;
        const completed = turn.completedItemIds?.[item.id] || (item.status && item.status !== "inProgress") || turn.status !== "inProgress";
        if (completed) {
          await this.options.notify("item/completed", { threadId, turnId: turn.turnId, item });
          this.signatures.set(itemKey, signature);
        } else if (!this.signatures.has(itemKey)) {
          await this.options.notify("item/started", { threadId, turnId: turn.turnId, item });
          this.signatures.set(itemKey, `started:${signature}`);
        }
      }
      if (turn.status !== "inProgress" && previous !== turn.status) await this.options.notify("turn/completed", { threadId, turn: normalized });
      this.observedTurns.set(key, turn.status);
    }
    const old = this.requests.get(threadId) ?? new Map<string, DesktopRecord>();
    const current = new Map<string, DesktopRecord>();
    for (const request of state.requests ?? []) {
      if (!request.method || request.id === undefined) continue;
      const id = String(request.id); current.set(id, request);
      if (!old.has(id)) this.options.request({ ...request, id: `desktop:${threadId}:${id}`, params: { ...request.params, threadId } });
    }
    for (const id of old.keys()) if (!current.has(id)) await this.options.notify("serverRequest/resolved", { threadId, requestId: `desktop:${threadId}:${id}` });
    this.requests.set(threadId, current);
    if (state.latestTokenUsageInfo) await this.options.notify("thread/tokenUsage/updated", { threadId, tokenUsage: state.latestTokenUsageInfo });
    // Bound fingerprints for long-running Bridges. Event ids remain stable downstream.
    if (this.signatures.size > 20_000) this.signatures.clear();
  }
  async call(threadId: string, method: string, params: DesktopRecord, version = 1): Promise<DesktopRecord> {
    this.state(threadId);
    const reply = await this.ipc.request(method, { conversationId: threadId, ...params }, version, this.sessions.get(threadId)!.owner, true);
    await this.chains.get(threadId);
    return reply.result;
  }
  async submit(threadId: string, input: DesktopRecord[], delivery: "auto" | "steer" | "start_turn", expectedTurnId?: string, model?: string, effort?: string): Promise<{ turnId?: string; resolvedAction: "steer" | "start_turn" }> {
    const state = this.state(threadId), turns = desktopTurns(state);
    const active = [...turns].reverse().find(turn => turn.status === "inProgress");
    if (state.requests?.length) throw desktopError("desktop_interaction_pending", "Resolve the pending Desktop interaction before sending");
    if (expectedTurnId && expectedTurnId !== active?.turnId) throw desktopError("turn_changed", "Desktop active turn changed");
    if (delivery === "steer" && !active) throw desktopError("no_active_turn", "Desktop session has no active turn");
    if (delivery === "start_turn" && active) throw desktopError("turn_already_active", "Desktop session already has an active turn");
    if (active && (model || effort)) throw desktopError("model_not_applicable", "Model and effort cannot change during steering");
    const clientUserMessageId = randomUUID();
    if (active) {
      await this.call(threadId, "thread-follower-steer-turn", { input, clientUserMessageId });
      return { turnId: active.turnId, resolvedAction: "steer" };
    }
    const request = { threadId, input, clientUserMessageId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    const result = await this.call(threadId, "thread-follower-start-turn", { turnStart: { request, context: {} } }, 2);
    return { turnId: result.result?.turn?.id, resolvedAction: "start_turn" };
  }
  async reply(threadId: string, requestId: string, response: DesktopRecord): Promise<void> {
    const id = requestId.slice(`desktop:${threadId}:`.length), request = this.requests.get(threadId)?.get(id);
    if (!request) throw desktopError("desktop_request_resolved", "Desktop interaction has already been resolved");
    const methods: Record<string, [string, string]> = {
      "item/commandExecution/requestApproval": ["thread-follower-command-approval-decision", "decision"],
      "item/fileChange/requestApproval": ["thread-follower-file-approval-decision", "decision"],
      "item/permissions/requestApproval": ["thread-follower-permissions-request-approval-response", "response"],
      "item/tool/requestUserInput": ["thread-follower-submit-user-input", "response"],
    };
    const mapping = methods[request.method];
    if (!mapping) throw desktopError("desktop_interaction_unsupported", "Answer this interaction in Codex Desktop");
    await this.call(threadId, mapping[0], { requestId: request.id, [mapping[1]]: mapping[1] === "decision" ? response.decision : response });
  }
  async refresh(): Promise<void> { for (const threadId of this.sessions.keys()) await this.follow(threadId); }
  close(): void { this.ipc.close(); }
}

/** App tools are used only for creation/navigation; follower IPC carries native multimodal turns. */
export async function desktopAppTool(contextThreadId: string, tool: string, args: DesktopRecord): Promise<DesktopRecord> {
  const pipes = (await readdir("\\\\.\\pipe\\")).filter(name => name.startsWith("codex-app-tools-"));
  if (pipes.length !== 1) throw desktopError("desktop_unavailable", "Expected exactly one Codex Desktop app-tools pipe", true);
  return new Promise((resolve, reject) => {
    const socket = connect(`\\\\.\\pipe\\${pipes[0]}`); let buffer = Buffer.alloc(0), dispatched = false;
    const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(desktopError(dispatched ? "desktop_outcome_unknown" : "desktop_unavailable", "Desktop app-tool response timed out")), 30_000);
    socket.on("error", () => fail(desktopError(dispatched ? "desktop_outcome_unknown" : "desktop_unavailable", "Desktop app-tools connection failed")));
    socket.on("close", () => { clearTimeout(timer); reject(desktopError(dispatched ? "desktop_outcome_unknown" : "desktop_unavailable", "Desktop app-tools connection closed")); });
    socket.on("connect", () => {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: {
        callerSource: "codex", namespace: "codex_app", hostId: "local", threadId: contextThreadId,
        turnId: randomUUID(), callId: randomUUID(), tool, arguments: args,
      } }));
      const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); dispatched = true; socket.write(Buffer.concat([header, bytes]));
    });
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, bytes]); if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(); if (size > 8 * 1024 * 1024) return fail(desktopError("desktop_protocol_error", "App tool response too large"));
      if (buffer.length < size + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, size + 4).toString());
        if (response.error || !response.result?.success) throw desktopError("desktop_request_failed", response.error?.message ?? response.result?.contentItems?.[0]?.text ?? "Desktop tool failed");
        const text = response.result.contentItems?.find((item: DesktopRecord) => item.type === "inputText")?.text;
        resolve(text ? JSON.parse(text) : {}); clearTimeout(timer); socket.end();
      } catch (error) { fail(error as Error); }
    });
  });
}
