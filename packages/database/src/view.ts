import type { DatabaseSync } from "node:sqlite";
import { contentMark, isContent, isEntryKey, jsonBytes, PROJECTION_VERSION, projectEntry, TOOL_TYPES, viewKey, windowEntry,
  type EntryView, type PreviousContent, type WireEvent } from "@agent-bridge/transcript";
import { decodeEventBody, EVENT_COLUMNS, eventWire, type EventRow } from "./events.js";

/**
 * The conversation view's bookkeeping. Every stored or revised event bumps its
 * session's `view_revision` and records, per view entry, the revision it last
 * changed at (`view_dirty`). A revision that moves an event to another entry
 * changes the entries' order, so it also bumps `ordering_epoch`; clients then
 * reload rather than patch. Projections themselves are computed on read.
 */

/** Response budgets, in UTF-8 bytes. */
export const VIEW_BUDGET = { snapshot: 1024 * 1024, changes: 512 * 1024, entry: 256 * 1024 };

/** Only message bodies decide a view key; tool bodies (possibly compressed) are never read for it. */
function keyPayload(type: string, body: unknown): Record<string, unknown> {
  return type === "message.completed" ? decodeEventBody(body) : {};
}

function previousContent(db: DatabaseSync, sessionId: string, beforeId: number): PreviousContent | undefined {
  const types = ["message.completed", ...TOOL_TYPES];
  const rows = db.prepare(`SELECT type,view_key,body FROM events WHERE session_id=? AND id<?
    AND type IN (${types.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 20`).iterate(sessionId, beforeId, ...types) as
    Iterable<{ type: string; view_key: string | null; body: unknown }>;
  // A message without a user/assistant role is not content; look past a few of them.
  for (const row of rows) {
    const mark = contentMark({ type: row.type, payload: keyPayload(row.type, row.body) }, row.view_key);
    if (mark) return mark;
  }
  return undefined;
}

function bump(db: DatabaseSync, sessionId: string, keys: Iterable<string>, reorder = false): number {
  const row = db.prepare(`UPDATE sessions SET view_revision=view_revision+1${reorder ? ",ordering_epoch=ordering_epoch+1" : ""}
    WHERE id=? RETURNING view_revision`).get(sessionId) as { view_revision: number } | undefined;
  const revision = Number(row?.view_revision ?? 0);
  const mark = db.prepare(`INSERT INTO view_dirty(session_id,view_key,rev) VALUES (?,?,?)
    ON CONFLICT(session_id,view_key) DO UPDATE SET rev=excluded.rev`);
  for (const key of keys) mark.run(sessionId, key, revision);
  return revision;
}

const exists = (db: DatabaseSync, sessionId: string, key: string, otherThan: number) =>
  Boolean(db.prepare("SELECT 1 FROM events WHERE session_id=? AND view_key=? AND id<>? LIMIT 1").get(sessionId, key, otherThan));

/** Key a newly stored event and record the view change, in the caller's transaction. */
export function recordAppendedEvent(db: DatabaseSync, sessionId: string, id: number,
  event: { eventId: string; type: string; turnId: string | null; payload: Record<string, unknown> }): void {
  const key = viewKey(event, isContent(event.type, event.payload) && !event.turnId ? previousContent(db, sessionId, id) : undefined);
  const keys = new Set<string>();
  if (key) {
    db.prepare("UPDATE events SET view_key=? WHERE id=?").run(key, id);
    keys.add(key);
    // A new entry at the end supersedes the one that was last.
    if (isEntryKey(key) && !exists(db, sessionId, key, id)) {
      const last = db.prepare("SELECT last_entry_key FROM sessions WHERE id=?").get(sessionId) as { last_entry_key: string | null } | undefined;
      if (last?.last_entry_key) keys.add(last.last_entry_key);
      db.prepare("UPDATE sessions SET last_entry_key=? WHERE id=?").run(key, sessionId);
    }
  }
  // Even an event outside the view advances the revision: the raw counter must see it.
  bump(db, sessionId, keys);
}

/** Re-key an event revised in place. Moving it between entries reorders the view. */
export function recordRevisedEvent(db: DatabaseSync, sessionId: string, id: number,
  event: { eventId: string; type: string; turnId: string | null; payload: Record<string, unknown> }): void {
  const stored = db.prepare("SELECT view_key FROM events WHERE id=?").get(id) as { view_key: string | null };
  const key = viewKey(event, isContent(event.type, event.payload) && !event.turnId ? previousContent(db, sessionId, id) : undefined);
  if (key === stored.view_key) { bump(db, sessionId, key ? [key] : []); return; }
  db.prepare("UPDATE events SET view_key=? WHERE id=?").run(key, id);
  db.prepare(`UPDATE sessions SET last_entry_key=(SELECT view_key FROM events WHERE session_id=? AND view_key IS NOT NULL
    AND (view_key LIKE 't:%' OR view_key LIKE 'o:%') GROUP BY view_key ORDER BY MIN(id) DESC LIMIT 1) WHERE id=?`).run(sessionId, sessionId);
  bump(db, sessionId, [stored.view_key, key].filter((k): k is string => Boolean(k)), true);
}

/** Key every stored event, in order (migration). */
export function backfillViewKeys(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id,session_id,event_id,type,turn_id,body FROM events ORDER BY session_id,id").iterate() as
    Iterable<{ id: number; session_id: string; event_id: string; type: string; turn_id: string | null; body: unknown }>;
  const update = db.prepare("UPDATE events SET view_key=? WHERE id=?");
  const last = db.prepare("UPDATE sessions SET last_entry_key=? WHERE id=?");
  let session = "", previous: PreviousContent | undefined, lastEntry: string | null = null;
  const seen = new Set<string>();
  const flush = () => { if (session && lastEntry) last.run(lastEntry, session); };
  const updates: Array<[string, number]> = [];
  for (const row of rows) {
    if (row.session_id !== session) { flush(); session = row.session_id; previous = undefined; lastEntry = null; seen.clear(); }
    const event = { eventId: row.event_id, type: row.type, turnId: row.turn_id, payload: keyPayload(row.type, row.body) };
    const key = viewKey(event, previous);
    previous = contentMark(event, key) ?? previous;
    if (key) {
      updates.push([key, Number(row.id)]);
      if (isEntryKey(key) && !seen.has(key)) { seen.add(key); lastEntry = key; }
    }
  }
  flush();
  for (const [key, id] of updates) update.run(key, id);
}

interface SessionViewState { viewRevision: number; orderingEpoch: number; rawHigh: number; lastEntryAnchor: number | null }

function viewState(db: DatabaseSync, sessionId: string): SessionViewState | undefined {
  const row = db.prepare("SELECT view_revision,ordering_epoch,last_entry_key FROM sessions WHERE id=?").get(sessionId) as
    { view_revision: number; ordering_epoch: number; last_entry_key: string | null } | undefined;
  if (!row) return undefined;
  const high = db.prepare("SELECT MAX(id) AS id FROM events WHERE session_id=?").get(sessionId) as { id: number | null };
  const anchor = row.last_entry_key ? db.prepare("SELECT MIN(id) AS id FROM events WHERE session_id=? AND view_key=?")
    .get(sessionId, row.last_entry_key) as { id: number | null } : undefined;
  return { viewRevision: Number(row.view_revision), orderingEpoch: Number(row.ordering_epoch), rawHigh: Number(high.id ?? 0),
    lastEntryAnchor: anchor?.id == null ? null : Number(anchor.id) };
}

/** The current projection of one entry, or undefined when it has no events. */
export function materializeEntry(db: DatabaseSync, sessionId: string, key: string, lastEntryAnchor: number | null): EntryView | undefined {
  const rows = db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE session_id=? AND view_key=? ORDER BY id`)
    .all(sessionId, key) as unknown as EventRow[];
  if (!rows.length) return undefined;
  const events = rows.map(row => ({ ...(eventWire(row) as unknown as WireEvent), seq: Number(row.id) }));
  const anchor = events[0]!.seq;
  const entry = projectEntry({ key, events, superseded: lastEntryAnchor !== null && anchor < lastEntryAnchor });
  const dirty = db.prepare("SELECT rev FROM view_dirty WHERE session_id=? AND view_key=?").get(sessionId, key) as { rev: number } | undefined;
  return { ...entry, rev: Number(dirty?.rev ?? 0) };
}

export class ViewError extends Error {
  constructor(readonly code: "invalid_cursor" | "cursor_expired" | "session_not_found") { super(code); }
}

const pageCursor = (epoch: number, anchor: number) => `v:${epoch}:${anchor}`;
function parsePageCursor(cursor: string, epoch: number): number {
  const match = /^v:(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new ViewError("invalid_cursor");
  if (Number(match[1]) !== epoch) throw new ViewError("cursor_expired");
  return Number(match[2]);
}

/**
 * The latest entries before `before` (all, when absent), newest first until the
 * budget, returned oldest first. Call inside a read transaction.
 */
export function viewPage(db: DatabaseSync, sessionId: string, limit: number, before?: string) {
  const state = viewState(db, sessionId);
  if (!state) throw new ViewError("session_not_found");
  const upper = before ? parsePageCursor(before, state.orderingEpoch) : Number.MAX_SAFE_INTEGER;
  const keys = db.prepare(`SELECT view_key,MIN(id) AS anchor FROM events WHERE session_id=? AND view_key IS NOT NULL
    GROUP BY view_key HAVING anchor<? ORDER BY anchor DESC LIMIT ?`).all(sessionId, upper, limit + 1) as Array<{ view_key: string; anchor: number }>;
  const entries: EntryView[] = [];
  let used = 0, more = keys.length > limit;
  for (const { view_key: key } of keys.slice(0, limit)) {
    const entry = materializeEntry(db, sessionId, key, state.lastEntryAnchor);
    if (!entry) continue;
    const windowed = windowEntry(entry, VIEW_BUDGET.entry);
    const size = jsonBytes(windowed);
    if (entries.length && used + size > VIEW_BUDGET.snapshot) { more = true; break; }
    entries.unshift(windowed); used += size;
  }
  return { projectionVersion: PROJECTION_VERSION, viewRevision: state.viewRevision, orderingEpoch: state.orderingEpoch,
    rawHigh: state.rawHigh, entries, entriesBefore: more && entries.length ? pageCursor(state.orderingEpoch, entries[0]!.anchor) : null };
}

/**
 * Entries changed after revision `since`, in revision order, cut at a revision
 * boundary within the budget: when `hasMore` is false the client holds the view
 * of `toRevision`. `raw` counts the session's new events after `rawAfter`.
 */
export function viewChanges(db: DatabaseSync, sessionId: string, since: number, rawAfter: number) {
  const state = viewState(db, sessionId);
  if (!state) throw new ViewError("session_not_found");
  if (since > state.viewRevision || rawAfter > state.rawHigh) throw new ViewError("invalid_cursor");
  const dirty = db.prepare("SELECT view_key,rev FROM view_dirty WHERE session_id=? AND rev>? ORDER BY rev,view_key")
    .all(sessionId, since) as Array<{ view_key: string; rev: number }>;
  const entries: EntryView[] = [], removed: Array<{ key: string; rev: number }> = [];
  let used = 0, toRevision = state.viewRevision, hasMore = false;
  for (let i = 0; i < dirty.length;) {
    // Take whole revisions only.
    const rev = Number(dirty[i]!.rev), batch: EntryView[] = [], gone: Array<{ key: string; rev: number }> = [];
    let size = 0;
    for (; i < dirty.length && Number(dirty[i]!.rev) === rev; i++) {
      const entry = materializeEntry(db, sessionId, dirty[i]!.view_key, state.lastEntryAnchor);
      if (!entry) { gone.push({ key: dirty[i]!.view_key, rev }); continue; }
      const windowed = windowEntry(entry, VIEW_BUDGET.entry);
      batch.push(windowed); size += jsonBytes(windowed);
    }
    if ((entries.length || removed.length) && used + size > VIEW_BUDGET.changes) { hasMore = true; toRevision = rev - 1; break; }
    entries.push(...batch); removed.push(...gone); used += size;
  }
  const raw = db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=? AND id>? AND id<=?")
    .get(sessionId, rawAfter, state.rawHigh) as { n: number };
  return { projectionVersion: PROJECTION_VERSION, fromRevision: since, toRevision, hasMore, orderingEpoch: state.orderingEpoch,
    entries, removed, raw: { after: rawAfter, through: state.rawHigh, count: Number(raw.n) } };
}

/** Older items of one entry, before item sequence `before`. */
export function viewEntryItems(db: DatabaseSync, sessionId: string, key: string, before: number) {
  const state = viewState(db, sessionId);
  if (!state) throw new ViewError("session_not_found");
  const entry = materializeEntry(db, sessionId, key, state.lastEntryAnchor);
  return entry ? { viewRevision: state.viewRevision, entry: windowEntry(entry, VIEW_BUDGET.entry, before) } : undefined;
}

/** One stored event, whole. */
export function eventById(db: DatabaseSync, sessionId: string, eventId: string): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE session_id=? AND event_id=?`).get(sessionId, eventId) as unknown as EventRow | undefined;
  return row ? eventWire(row) : undefined;
}
