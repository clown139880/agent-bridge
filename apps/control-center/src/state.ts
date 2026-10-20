import { ApiError, ControlClient, explain } from "./api/client";
import { consumeStream, delay, StreamLimitError } from "./api/stream";
import { isLive, pendingId, segment, type Action, type Envelope, type Page, type Pending,
  type Session, type SessionEvent, type Snapshot, type Worker } from "./api/types";

export type Route = { page: "sessions" | "new" | "detail"; id?: string };
export interface Intent {
  path: string; body: Record<string, unknown>; key: string; receipt?: Action;
  submitting: boolean; uncertain: boolean; error?: string; navigateTo?: string;
}
export interface ViewState {
  route: Route; sessions: Session[]; workers: Worker[]; session?: Session; events: SessionEvent[];
  approvals: Pending[]; inputs: Pending[]; loading: boolean; moreLoading: boolean; hasMore: boolean;
  historyMore: boolean; error: string; connection: string; updatedAt: number; query: string;
  workerFilter: string; intent?: Intent; drafts: Record<string, string>; writable: boolean;
}
export const mergeEvents = (first: SessionEvent[], second: SessionEvent[]) => {
  const seen = new Set<string>();
  return [...first, ...second].filter(e => !seen.has(e.eventId) && Boolean(seen.add(e.eventId)));
};
// Merge a fresh tail without moving previously loaded older history below it.
export function mergeTail(existing: SessionEvent[], tail: SessionEvent[]) {
  const result = [...existing], known = new Set(existing.map(e => e.eventId));
  tail.forEach((event, i) => {
    if (known.has(event.eventId)) return;
    const next = tail.slice(i + 1).find(e => known.has(e.eventId));
    const index = next ? result.findIndex(e => e.eventId === next.eventId) : result.length;
    result.splice(index, 0, event); known.add(event.eventId);
  });
  return result;
}
const upsert = <T,>(rows: T[], item: T, id: (v: T) => string) => [...rows.filter(v => id(v) !== id(item)), item];

// Unlike randomUUID(), getRandomValues() is available on ordinary HTTP origins too.
// The API accepts opaque keys; 128 random bits keep independent actions distinct.
const newIdempotencyKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, "0")).join("");

/** One in-memory authenticated browser tab, one stream, no background polling. */
export class ControlState {
  readonly api: ControlClient;
  private listeners = new Set<() => void>();
  private scope = new AbortController();
  private streamAbort?: AbortController;
  private streamTask?: Promise<void>;
  private cursor: string;
  private listCursor: string | null = null;
  private listQueryKey = "";
  private before: string | null = null;
  private generation = 0;
  private revision = 0;
  private deleted = false;
  private approvalUpdates = new Map<string, Pending>();
  private inputUpdates = new Map<string, Pending>();
  private visible = true;
  private disposed = false;
  private bootstrap = false;
  private finalizing = false;
  private projectionHold = false;
  private streamStopped = false;
  private seen = new Set<string>();
  private pendingNotifications = false;
  private state: ViewState;

  constructor(token: string, writable: boolean, snapshot: Snapshot, unauthorized: () => void,
    private navigate: (path: string) => void, base: "/api/v1" | "/control/api/v1" = "/api/v1") {
    this.api = new ControlClient(token, unauthorized, base);
    this.cursor = snapshot.streamCursor;
    this.state = { route: { page: "sessions" }, sessions: snapshot.sessions, workers: snapshot.workers,
      events: [], approvals: [], inputs: [], loading: false, moreLoading: false,
      hasMore: snapshot.truncated.sessions, historyMore: false, error: "", connection: "按需更新",
      updatedAt: Date.now(), query: "", workerFilter: "", writable, drafts: {} };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private patch(value: Partial<ViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    if (!this.pendingNotifications) {
      this.pendingNotifications = true;
      queueMicrotask(() => { this.pendingNotifications = false; if (!this.disposed) this.listeners.forEach(f => f()); });
    }
  }
  dispose() {
    this.disposed = true; this.scope.abort(); this.streamAbort?.abort(); this.api.dispose();
    this.state = { ...this.state, sessions: [], workers: [], events: [], drafts: {}, intent: undefined, session: undefined, approvals: [], inputs: [] };
    this.seen.clear(); this.listeners.clear();
  }
  setDraft(id: string, text: string) { this.patch({ drafts: { ...this.state.drafts, [id]: text } }); }
  setFilters(query: string, workerFilter: string) { this.patch({ query, workerFilter }); }
  private needsStream() {
    const i = this.state.intent;
    return this.visible && !this.streamStopped && (this.bootstrap || this.finalizing || this.projectionHold && this.state.route.page === "detail" ||
      this.state.route.page === "detail" && isLive(this.state.session) || Boolean(i && (i.submitting || i.uncertain || i.receipt?.status === "accepted")));
  }
  private syncStream() {
    if (this.disposed) return;
    if (!this.needsStream()) {
      this.streamAbort?.abort();
      this.patch({ connection: this.visible ? "按需更新" : "后台已暂停" });
      return;
    }
    if (this.streamTask) return;
    const abort = new AbortController(); this.streamAbort = abort;
    this.streamTask = this.runStream(abort.signal).finally(() => {
      this.streamTask = undefined;
      if (this.streamAbort === abort) this.streamAbort = undefined;
      this.syncStream();
    });
  }
  private async runStream(signal: AbortSignal) {
    let failures = 0, retryMs = 3000, limitFailures = 0;
    while (!signal.aborted && this.needsStream()) {
      this.patch({ connection: failures ? "连接中断，正在恢复…" : "正在连接…" });
      let openedAt = 0;
      try {
        const response = await this.api.stream(this.cursor, signal);
        openedAt = Date.now(); this.patch({ connection: "实时已连接" });
        await consumeStream(response, signal, e => {
          if (this.seen.has(e.eventId)) return;
          this.apply(e); this.cursor = e.cursor;
        }, ms => { retryMs = ms; });
      } catch (error) {
        if (signal.aborted || this.disposed) return;
        if (error instanceof ApiError && [400, 410].includes(error.status) && ["invalid_cursor", "cursor_expired"].includes(error.code)) {
          try {
            const snap = await this.api.request<Snapshot>("/snapshot?sessionLimit=50", { signal });
            this.cursor = snap.streamCursor; this.seen.clear();
            this.approvalUpdates.clear(); this.inputUpdates.clear(); this.before = null;
            this.patch({ workers: snap.workers, sessions: snap.sessions, events: [], approvals: [], inputs: [], historyMore: false });
            if (this.state.route.page === "detail") await this.loadDetail(this.state.route.id!, this.generation, true);
          } catch (e) { if (!signal.aborted) this.patch({ error: explain(e) }); }
        } else if (error instanceof ApiError && [401, 403].includes(error.status)) {
          this.streamStopped = true; this.patch({ error: explain(error) }); return;
        } else if (error instanceof StreamLimitError && ++limitFailures >= 2) {
          this.streamStopped = true;
          this.patch({ error: "实时内容超过移动端预算，已暂停。请加载历史，或点击刷新后重试。", connection: "实时已暂停" }); return;
        } else this.patch({ connection: "连接中断，内容可能尚未更新" });
        if (!this.needsStream()) return;
        if (openedAt && Date.now() - openedAt > 30_000) { failures = 0; limitFailures = 0; }
        const wait = error instanceof ApiError && error.retryAfterMs !== undefined ? error.retryAfterMs
          : Math.min(30_000, retryMs * 2 ** Math.min(failures++, 4)) * (0.8 + Math.random() * 0.4);
        try { await delay(wait, signal); } catch { return; }
      }
    }
  }
  private apply(e: Envelope) {
    if (this.seen.has(e.eventId)) return;
    this.seen.add(e.eventId);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    const selected = this.state.route.page === "detail" && e.sessionId === this.state.route.id;
    if (e.type === "session.updated") {
      const s = e.data as Session;
      if (selected) { this.revision++; this.patch({ session: { ...this.state.session, ...s } }); }
      // Do not accumulate unrelated transcript/resources from the global stream.
      if (this.state.sessions.some(v => v.sessionId === s.sessionId)) this.patch({ sessions: this.state.sessions.map(v => v.sessionId === s.sessionId ? { ...v, ...s } : v) });
    } else if (e.type === "session.deleted") {
      this.patch({ sessions: this.state.sessions.filter(s => s.sessionId !== e.sessionId) });
      if (selected) { this.deleted = true; this.projectionHold = false; this.revision++; this.patch({ session: undefined, error: "此会话已被删除" }); }
    } else if (e.type === "session.event.appended" && selected) {
      let events = mergeEvents(this.state.events, [e.data as SessionEvent]);
      if (events.length > 1000) {
        events = events.slice(-1000); this.before = events[0].cursor;
        this.patch({ historyMore: true });
      }
      this.patch({ events });
    } else if (e.type === "approval.upserted" && selected) {
      const pending = e.data as Pending; this.approvalUpdates.set(pendingId(pending), pending);
      this.patch({ approvals: upsert(this.state.approvals, pending, pendingId).filter(p => p.status === "pending") });
    } else if (e.type === "user_input.upserted" && selected) {
      const pending = e.data as Pending; this.inputUpdates.set(pendingId(pending), pending);
      this.patch({ inputs: upsert(this.state.inputs, pending, pendingId).filter(p => p.status === "pending") });
    } else if (e.type === "worker.upserted") {
      this.patch({ workers: upsert(this.state.workers, e.data as Worker, w => w.id) });
    } else if (e.type === "worker.offline") {
      this.patch({ workers: this.state.workers.map(w => w.id === e.resource.id ? { ...w, status: "offline" } : w) });
    } else if (e.type === "action.updated") {
      const action = e.data as Action, intent = this.state.intent;
      // The key isn't on the wire: until the POST returns actionId, reconcile by replaying that same POST.
      if (intent?.receipt?.actionId === action.actionId) this.receiveAction(action);
    }
    this.releaseProjection();
    if (selected && !this.bootstrap && !isLive(this.state.session) && this.state.route.page === "detail"
      && (e.type === "session.updated" || e.type === "session.event.appended")) void this.finalize();
    else this.syncStream();
  }
  private async finalize() {
    if (this.finalizing || this.bootstrap || this.deleted || !this.streamAbort || isLive(this.state.session)) { this.syncStream(); return; }
    this.finalizing = true;
    try { await this.loadDetail(this.state.route.id!, this.generation, false); }
    catch (e) { if (!this.scope.signal.aborted) this.patch({ error: explain(e) }); }
    finally { this.finalizing = false; this.syncStream(); }
  }
  async open(route: Route, freshStream = true) {
    this.scope.abort(); this.scope = new AbortController();
    const generation = ++this.generation;
    this.deleted = false; this.approvalUpdates.clear(); this.inputUpdates.clear();
    this.streamStopped = false; this.bootstrap = route.page === "detail";
    this.before = null; this.listCursor = null;
    this.patch({ route, loading: true, error: "", events: [], session: undefined,
      approvals: [], inputs: [], historyMore: false, moreLoading: false });
    if (route.page !== "detail") this.syncStream();
    if (!this.visible) { this.bootstrap = false; this.patch({ loading: false }); this.syncStream(); return; }
    try {
      if (route.page === "detail") {
        if (freshStream && !this.streamTask && !this.state.intent?.uncertain && !this.state.intent?.submitting && this.state.intent?.receipt?.status !== "accepted" && !this.projectionHold) {
          const snap = await this.api.request<Snapshot>("/snapshot?sessionLimit=50", { signal: this.scope.signal });
          if (generation !== this.generation) return;
          this.cursor = snap.streamCursor; this.seen.clear(); this.patch({ workers: snap.workers });
        }
        this.syncStream();
        await this.loadDetail(route.id!, generation, true);
      } else if (route.page === "new") {
        const result = await this.api.request<{ workers: Worker[] }>("/workers", { signal: this.scope.signal });
        if (generation === this.generation) this.patch({ workers: result.workers });
      } else await this.loadList(false, generation);
      await this.reconcileAction();
    } catch (e) { if (generation === this.generation && !this.scope.signal.aborted) this.patch({ error: explain(e) }); }
    finally {
      if (generation === this.generation) {
        this.bootstrap = false; this.patch({ loading: false });
        // Read the final tail before closing a stream whose resource became idle during initialization.
        if (route.page === "detail" && !isLive(this.state.session)) void this.finalize();
        else this.syncStream();
      }
    }
  }
  private async allPending(path: string, signal: AbortSignal) {
    const items: Pending[] = []; let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: Page<Pending> = await this.api.request(`${path}${cursor ? `&cursor=${segment(cursor)}` : ""}`, { signal });
      items.push(...page.data);
      if (!page.hasMore) break;
      if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("待办分页没有推进，请刷新");
      cursor = page.nextCursor; seen.add(cursor);
    } while (!signal.aborted);
    return items;
  }
  private async loadDetail(id: string, generation: number, reset: boolean) {
    const revision = this.revision, signal = this.scope.signal, path = `/sessions/${segment(id)}`;
    const [session, history, approvals, inputs] = await Promise.all([
      this.api.request<Session>(path, { signal }),
      this.api.request<Page<SessionEvent>>(`${path}/events?tail=true&limit=100`, { signal }),
      this.allPending(`/approvals?sessionId=${segment(id)}&status=pending&limit=200`, signal),
      this.allPending(`/user-input?sessionId=${segment(id)}&status=pending&limit=200`, signal),
    ]);
    if (generation !== this.generation || signal.aborted || this.deleted) return;
    const mergePending = (base: Pending[], updates: Map<string, Pending>) => {
      const rows = new Map(base.map(p => [pendingId(p), p]));
      updates.forEach((p, id) => rows.set(id, p));
      return [...rows.values()].filter(p => p.status === "pending");
    };
    // SSE received while GETs were pending wins for mutable resources.
    this.patch({ session: revision === this.revision ? session : { ...session, ...this.state.session, capabilities: session.capabilities },
      approvals: mergePending(approvals, this.approvalUpdates),
      inputs: mergePending(inputs, this.inputUpdates),
      events: reset ? mergeEvents(history.data, this.state.events) : mergeTail(this.state.events, history.data),
      updatedAt: Date.now() });
    if (reset) { this.before = history.nextCursor; this.patch({ historyMore: history.hasMore }); }
    this.releaseProjection();
  }
  async moreHistory() {
    if (this.state.moreLoading || !this.before) return;
    const generation = this.generation, id = this.state.route.id!, before = this.before;
    this.patch({ moreLoading: true, error: "" });
    try {
      const page = await this.api.request<Page<SessionEvent>>(`/sessions/${segment(id)}/events?tail=true&limit=100&before=${segment(before)}`, { signal: this.scope.signal });
      if (generation !== this.generation) return;
      this.before = page.nextCursor;
      this.patch({ events: mergeEvents(page.data, this.state.events), historyMore: page.hasMore });
    } catch (e) { if (generation === this.generation && !this.scope.signal.aborted) this.patch({ error: explain(e) }); }
    finally { if (generation === this.generation) this.patch({ moreLoading: false }); }
  }
  async loadList(more: boolean, generation = this.generation) {
    if (more && this.state.moreLoading) return;
    const queryKey = JSON.stringify([this.state.query, this.state.workerFilter]);
    more = more && Boolean(this.listCursor) && queryKey === this.listQueryKey;
    this.patch({ moreLoading: more, error: "" });
    const signal = this.scope.signal;
    try {
      const { query, workerFilter } = this.state;
      const params = new URLSearchParams({ sort: "updatedAt", order: "desc", limit: "50" });
      if (query) params.set("q", query);
      if (workerFilter) params.set("workerId", workerFilter);
      if (more && this.listCursor) params.set("cursor", this.listCursor);
      const [page, workers] = await Promise.all([
        this.api.request<Page<Session>>(`/sessions?${params}`, { signal }),
        more ? Promise.resolve(null) : this.api.request<{ workers: Worker[] }>("/workers", { signal }),
      ]);
      if (generation !== this.generation) return;
      this.listCursor = page.nextCursor;
      this.listQueryKey = queryKey;
      const ids = new Set(this.state.sessions.map(s => s.sessionId));
      this.patch({ sessions: more ? [...this.state.sessions, ...page.data.filter(s => !ids.has(s.sessionId))] : page.data,
        hasMore: page.hasMore, updatedAt: Date.now(), ...(workers ? { workers: workers.workers } : {}) });
    } catch (e) { if (generation === this.generation && !signal.aborted) this.patch({ error: explain(e) }); }
    finally { if (generation === this.generation) this.patch({ moreLoading: false }); }
  }
  async refresh() { await this.open(this.state.route); }
  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) { this.scope.abort(); this.syncStream(); }
    else void this.open(this.state.route, false);
  }
  async submit(path: string, body: Record<string, unknown>, draftId?: string) {
    const old = this.state.intent;
    if (!this.state.writable || old && (old.submitting || old.uncertain || old.receipt?.status === "accepted")) return;
    this.projectionHold = false;
    this.patch({ intent: { path, body, key: newIdempotencyKey(), submitting: true, uncertain: false }, error: "" });
    await this.transmit(draftId);
  }
  async retry() {
    const i = this.state.intent;
    if (!i || i.submitting || i.receipt?.status === "accepted") return;
    if (i.receipt?.status === "failed") {
      if (!i.receipt.error?.error.retryable) return;
      this.patch({ intent: { ...i, key: newIdempotencyKey(), receipt: undefined, error: undefined } });
    }
    await this.transmit();
  }
  private async transmit(draftId?: string) {
    const intent = this.state.intent!;
    this.patch({ intent: { ...intent, submitting: true, error: undefined } }); this.syncStream();
    try {
      const receipt = await this.api.post(intent.path, intent.body, intent.key);
      if (this.disposed || this.state.intent?.key !== intent.key) return;
      this.receiveAction(receipt);
      // An action may have finished before the POST response installed its actionId.
      if (receipt.status === "accepted") await this.reconcileAction();
    } catch (e) {
      if (this.disposed || this.state.intent?.key !== intent.key) return;
      const uncertain = !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
      this.patch({ intent: { ...this.state.intent!, submitting: false, uncertain, error: explain(e) } });
      if (e instanceof ApiError && e.status === 403) this.patch({ writable: false });
      if (e instanceof ApiError && e.status === 409 && this.state.route.page === "detail") {
        await this.loadDetail(this.state.route.id!, this.generation, false).catch(() => {});
      }
    } finally { this.syncStream(); }
  }
  private receiveAction(receipt: Action) {
    const intent = this.state.intent;
    if (!intent) return;
    const newlySucceeded = receipt.status === "succeeded" && intent.receipt?.status !== "succeeded";
    this.patch({ intent: { ...intent, receipt, submitting: false, uncertain: false,
      error: receipt.status === "failed" ? receipt.error?.error.message ?? "操作失败" : undefined } });
    if (receipt.status === "succeeded") {
      if (receipt.kind === "submit_turn" || receipt.kind === "create_session") this.projectionHold = true;
      if (intent.path.endsWith("/turns")) {
        const id = decodeURIComponent(intent.path.split("/")[2]);
        if (this.state.drafts[id] === intent.body.input) this.setDraft(id, "");
      }
      if (receipt.kind === "create_session" && receipt.sessionId && intent.navigateTo !== receipt.sessionId) {
        this.patch({ intent: { ...this.state.intent!, navigateTo: receipt.sessionId } });
        this.navigate(`/control/sessions/${segment(receipt.sessionId)}`);
      } else if (receipt.sessionId === this.state.route.id && this.state.route.page === "detail" && newlySucceeded) {
        void this.loadDetail(receipt.sessionId!, this.generation, false).catch(e => {
          if (!this.scope.signal.aborted) this.patch({ error: explain(e) });
        }).finally(() => this.syncStream());
      }
    }
    this.releaseProjection();
  }
  private releaseProjection() {
    const receipt = this.state.intent?.receipt;
    if (!this.projectionHold || !receipt) return;
    if (receipt.sessionId === this.state.session?.sessionId && (
      isLive(this.state.session) || ["offline", "error", "unknown"].includes(this.state.session.status) || this.state.events.some(e =>
        ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type) && Boolean(receipt.turnId) && e.turnId === receipt.turnId)
      || receipt.kind === "create_session" && !this.state.intent?.body.input)) this.projectionHold = false;
  }
  private async reconcileAction() {
    const i = this.state.intent;
    if (!i?.receipt || i.receipt.status !== "accepted") return;
    try {
      const receipt = await this.api.request<Action>(`/actions/${segment(i.receipt.actionId)}`);
      if (this.state.intent?.key === i.key) this.receiveAction(receipt);
    } catch (e) {
      if (this.state.intent?.key === i.key) this.patch({ intent: { ...this.state.intent!, error: explain(e) } });
    }
  }
  checkAction = () => this.reconcileAction();
}
