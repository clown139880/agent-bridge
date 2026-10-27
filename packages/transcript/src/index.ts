/**
 * The conversation view: one deterministic projection of a session's stored
 * events into turns and their items, shared by the Control Plane (which serves
 * it) and the clients (which render it). See docs/unified-transcript-view-design.zh.md.
 *
 * A view entry is keyed by the `view_key` stored with each event (see viewKey):
 *   t:<turnId>   every event of one remote turn, wherever it arrived;
 *   o:<eventId>  a run of content without a turn id, split at each new prompt;
 *   n:<eventId>  one visible notice without a turn id (approval, question, error).
 * Events that show nothing and name no turn have no key and stay out of the view.
 */

/** Bump when the projection of the same events changes; clients then reload. */
export const PROJECTION_VERSION = 1;

/** A stored session event as `/events` delivers it, plus its row sequence. */
export interface WireEvent {
  eventId: string; cursor: string; sessionId: string; type: string; turnId: string | null; itemId?: string | null;
  timestamp: number; payload: Record<string, unknown>; runId?: string | null;
}

export const TOOL_TYPES = new Set(["tool.started", "tool.completed", "command.completed", "file_change.completed",
  "task.started", "task.progress", "task.completed"]);
const NOTE_TYPES = new Set(["approval.requested", "approval.resolved", "user_input.requested", "user_input.resolved", "error"]);
const TERMINALS = new Set(["turn.completed", "turn.failed", "turn.interrupted"]);
/** A later started/progress event never takes a tool back from its result. */
const TOOL_RANK: Record<string, number> = { "tool.started": 0, "task.started": 0, "task.progress": 1 };

const isMessage = (type: string, payload: Record<string, unknown>) =>
  type === "message.completed" && (payload.role === "user" || payload.role === "assistant");
/** Whether an event is conversation content: a prompt, a reply or a tool call. */
export const isContent = (type: string, payload: Record<string, unknown>) => isMessage(type, payload) || TOOL_TYPES.has(type);
const isPrompt = (type: string, payload: Record<string, unknown>) => type === "message.completed" && payload.role === "user";

/** The previous content event of the same session, as viewKey needs it. */
export interface PreviousContent { viewKey: string | null; prompt: boolean }

/**
 * The view entry an event belongs to, decided once when it is stored. A run of
 * content without a turn id continues the previous run, except that a prompt
 * after other content opens a new one; metadata never breaks a run.
 */
export function viewKey(event: { eventId: string; type: string; turnId: string | null; payload: Record<string, unknown> },
  previous: PreviousContent | undefined): string | null {
  if (event.turnId) return `t:${event.turnId}`;
  if (!isContent(event.type, event.payload)) return NOTE_TYPES.has(event.type) ? `n:${event.eventId}` : null;
  if (previous?.viewKey?.startsWith("o:") && !(isPrompt(event.type, event.payload) && !previous.prompt)) return previous.viewKey;
  return `o:${event.eventId}`;
}

/** What a stored event tells the next one's viewKey: content only. */
export function contentMark(event: { type: string; payload: Record<string, unknown> }, key: string | null): PreviousContent | undefined {
  return isContent(event.type, event.payload) ? { viewKey: key, prompt: isPrompt(event.type, event.payload) } : undefined;
}

/** Content and notices form the view; a key's first event orders it. */
export const isEntryKey = (key: string) => key.startsWith("t:") || key.startsWith("o:");

/** Live and history events of one App Server item carry different ids; both name the same item. */
export function canonicalItem(event: Pick<WireEvent, "eventId" | "itemId">): string | null {
  const match = /^app-server:[^:]+:(?:[^:]+:)?([^:]+):(?:history-)?(?:message|command|file-change)$/.exec(event.eventId);
  return match?.[1] ?? event.itemId ?? null;
}

export type TurnStatus = "running" | "completed" | "failed" | "interrupted" | "unknown";
export interface Closure { kind: "terminal" | "superseded" | "none"; terminalEventId?: string; terminalType?: string; terminalAt?: number }

export interface ViewItem {
  /** `step:<eventId of the item's first event>`: stable while the item keeps its first event. */
  itemId: string;
  kind: "message" | "tool" | "note";
  role: "prompt" | "process" | "final";
  /** A user prompt after other output starts a new segment; segments keep the original order. */
  segment: number;
  seq: number;
  parentItemId: string | null;
  /** The event to show: a tool's most advanced state, a message's latest revision. Bulky payloads are trimmed. */
  event: WireEvent;
  truncated?: boolean;
}

export interface EntryView {
  key: string;
  kind: "turn" | "orphan" | "notice";
  turnId: string | null;
  /** Sequence of the entry's first event: its position in the conversation. */
  anchor: number;
  /** The session view revision when this entry last changed (set by the server). */
  rev: number;
  status: TurnStatus;
  closure: Closure;
  /** Output recorded after the terminal event: the turn went on although it had ended. */
  eventsAfterTerminal: number;
  /** The latest progress phase after the latest output; shown only while the turn is live. */
  lastPhase: "thinking" | "writing" | null;
  startedAt: number;
  lastEventAt: number;
  durationMs?: number;
  /** No turn.started was recorded, so the start of the turn may be missing. */
  partial: boolean;
  itemCount: number;
  items: ViewItem[];
  /** Earlier items not included here: pass as `itemsBefore` to read them. */
  itemsBefore: number | null;
}

export interface ProjectionInput { key: string; events: Array<WireEvent & { seq: number }>; superseded: boolean }

/** One view entry from all of its events (in sequence order). */
export function projectEntry({ key, events, superseded }: ProjectionInput): EntryView {
  const kind = key.startsWith("t:") ? "turn" : key.startsWith("o:") ? "orphan" : "notice";
  const items: ViewItem[] = [];
  const merged = new Map<string, ViewItem>();
  let terminal: (WireEvent & { seq: number }) | undefined, started: (WireEvent & { seq: number }) | undefined;
  let lastPhase: EntryView["lastPhase"] = null;
  for (const event of events) {
    if (event.type === "turn.started") { started ??= event; continue; }
    if (TERMINALS.has(event.type)) { terminal = event; continue; }
    if (event.type === "progress") {
      const phase = event.payload.phase;
      lastPhase = phase === "thinking" || phase === "writing" ? phase : lastPhase;
      continue;
    }
    const content = isContent(event.type, event.payload);
    if (!content && !NOTE_TYPES.has(event.type)) continue;
    lastPhase = null;
    const tool = TOOL_TYPES.has(event.type);
    const item = canonicalItem(event);
    const parent = typeof event.payload.parentItemId === "string" ? event.payload.parentItemId : null;
    const mergeKey = tool && item ? `tool:${parent ?? "-"}:${item}` : event.type === "message.completed" && item ? `msg:${item}` : `event:${event.eventId}`;
    const existing = merged.get(mergeKey);
    if (existing) {
      const better = !tool || (TOOL_RANK[event.type] ?? 2) >= (TOOL_RANK[existing.event.type] ?? 2);
      if (better) existing.event = event;
      continue;
    }
    const entry: ViewItem = { itemId: `step:${event.eventId}`, kind: tool ? "tool" : content ? "message" : "note",
      role: "process", segment: 0, seq: event.seq, parentItemId: parent, event };
    merged.set(mergeKey, entry); items.push(entry);
  }
  // Child tool calls point at their task's item when the task is in this entry.
  const taskItems = new Map(items.filter(i => i.event.type.startsWith("task.")).map(i => [canonicalItem(i.event), i.itemId]));
  let segment = 0, segmentHasOutput = false;
  for (const item of items) {
    if (item.parentItemId) item.parentItemId = taskItems.get(item.parentItemId) ?? null;
    if (isPrompt(item.event.type, item.event.payload)) {
      if (segmentHasOutput) { segment++; segmentHasOutput = false; }
      item.role = "prompt";
    } else segmentHasOutput = true;
    item.segment = segment;
  }
  // Only a reply that nothing followed in its segment is final; later work keeps it in the process.
  for (let s = 0; s <= segment; s++) {
    // (no findLast: the DSH client targets ES2022)
    const last = [...items].reverse().find(i => i.segment === s && i.role !== "prompt");
    if (last && last.event.type === "message.completed" && last.event.payload.role === "assistant") last.role = "final";
  }
  const first = events[0]!, last = events.at(-1)!;
  let status: TurnStatus = "unknown", closure: Closure = { kind: "none" };
  if (terminal) {
    status = terminal.type.slice(5) as TurnStatus;
    closure = { kind: "terminal", terminalEventId: terminal.eventId, terminalType: terminal.type, terminalAt: terminal.timestamp };
  } else if (superseded && kind !== "notice") closure = { kind: "superseded" };
  else if (started) status = "running";
  const after = terminal ? events.filter(e => e.seq > terminal!.seq && (isContent(e.type, e.payload) || NOTE_TYPES.has(e.type))).length : 0;
  const duration = terminal && typeof terminal.payload.durationMs === "number" ? terminal.payload.durationMs
    : terminal && started ? terminal.timestamp - started.timestamp : undefined;
  return { key, kind, turnId: kind === "turn" ? key.slice(2) : null, anchor: first.seq, rev: 0, status, closure,
    eventsAfterTerminal: after, lastPhase, startedAt: (started ?? first).timestamp, lastEventAt: last.timestamp,
    ...(duration !== undefined && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    partial: kind === "turn" && !started, itemCount: items.length, items, itemsBefore: null };
}

const MESSAGE_LIMIT = 64 * 1024, FIELD_LIMIT = 2 * 1024, ARRAY_LIMIT = 50;

/**
 * An event small enough for the view. Message text is kept whole up to a generous
 * limit; tool output, diffs and arguments keep a preview. `truncated` tells the
 * client to read the whole event by id before showing it in full.
 */
export function trimEvent(event: WireEvent): { event: WireEvent; truncated: boolean } {
  let truncated = false;
  const limit = event.type === "message.completed" ? MESSAGE_LIMIT : FIELD_LIMIT;
  const trim = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.length <= limit) return value;
      truncated = true; return value.slice(0, limit);
    }
    if (Array.isArray(value)) {
      if (value.length > ARRAY_LIMIT) truncated = true;
      return value.slice(0, ARRAY_LIMIT).map(v => trim(v, depth + 1));
    }
    if (value && typeof value === "object") {
      if (depth > 6) { truncated = true; return {}; }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, depth + 1)]));
    }
    return value;
  };
  const payload = trim(event.payload, 0) as Record<string, unknown>;
  return { event: truncated ? { ...event, payload } : event, truncated };
}

/** UTF-8 size of a value as JSON, which is what a response budget counts. */
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The entry's latest items within `budget` bytes (all items before `before`, when
 * given). At least one item is always kept, so a huge entry still advances; its
 * payload is already trimmed.
 */
export function windowEntry(entry: EntryView, budget: number, before?: number): EntryView {
  const candidates = before === undefined ? entry.items : entry.items.filter(i => i.seq < before);
  const kept: ViewItem[] = [];
  let used = jsonBytes({ ...entry, items: [] });
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { event, truncated } = trimEvent(candidates[i]!.event);
    const item = { ...candidates[i]!, event, ...(truncated ? { truncated } : {}) };
    const size = jsonBytes(item);
    if (kept.length && used + size > budget) break;
    kept.unshift(item); used += size;
  }
  const omitted = candidates.length - kept.length;
  return { ...entry, items: kept, itemsBefore: omitted > 0 ? kept[0]!.seq : null };
}

/** Whether a turn is running now; session state comes from the session resource, not the view. */
export function entryLive(entry: Pick<EntryView, "turnId">, session: { activeTurnId?: string | null; status?: string } | undefined) {
  return Boolean(entry.turnId && session?.activeTurnId === entry.turnId
    && ["creating", "active", "waiting_for_approval", "waiting_for_input"].includes(String(session.status)));
}

/**
 * What a turn shows, from evidence only: running while the session says so, its
 * terminal event's status otherwise. A start without an end is just a record.
 */
export function entryStatus(entry: Pick<EntryView, "turnId" | "status">, session: { activeTurnId?: string | null; status?: string } | undefined): TurnStatus {
  if (entryLive(entry, session)) return "running";
  return entry.status === "running" ? "unknown" : entry.status;
}

/** A snapshot or changes response, as the Control Plane serves it. */
export interface ViewPage {
  projectionVersion: number;
  viewRevision: number;
  orderingEpoch: number;
  /** Highest event sequence of the session included in this response. */
  rawHigh: number;
  entries: EntryView[];
  /** Older entries exist before this anchor (snapshot pages). */
  entriesBefore: string | null;
  streamCursor: string;
}

export interface ViewChanges {
  projectionVersion: number;
  fromRevision: number;
  toRevision: number;
  hasMore: boolean;
  orderingEpoch: number;
  entries: EntryView[];
  /** Entries that lost every event; drop them if shown. */
  removed: Array<{ key: string; rev: number }>;
  /** New events in (after, through]: what the "new content" counter adds. */
  raw: { after: number; through: number; count: number };
  streamCursor: string;
}

export { ConversationModel, type ApplyResult, type ConversationSnapshot } from "./client.js";
