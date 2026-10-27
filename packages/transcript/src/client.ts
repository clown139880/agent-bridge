import { PROJECTION_VERSION, type EntryView, type ViewChanges, type ViewPage } from "./index.js";

/** What a client keeps of one conversation, enough to resume it (and to cache it). */
export interface ConversationSnapshot {
  projectionVersion: number;
  viewRevision: number;
  orderingEpoch: number;
  rawHigh: number;
  /** Entries in anchor order. */
  entries: EntryView[];
  /** Cursor for the page before the oldest entry held, or null when the start is held. */
  entriesBefore: string | null;
}

export type ApplyResult =
  | { kind: "applied"; newRawEvents: number }
  /** The response was for another position than the one held (an earlier, overtaken request). */
  | { kind: "stale" }
  /** Order or projection changed under the held entries: load a fresh snapshot. */
  | { kind: "reset" };

const MAX_ENTRIES = 300;

/**
 * A conversation view assembled from snapshot pages and changes, by the rules of
 * docs/unified-transcript-view-design.zh.md: entries merge by revision, an entry
 * reported removed is never revived by an older page, older pages never move the
 * revision or the raw counter, and the counter only advances over the contiguous
 * range a changes response reports.
 */
export class ConversationModel {
  private entries = new Map<string, EntryView>();
  private removed = new Map<string, number>();
  private state: Omit<ConversationSnapshot, "entries">;

  constructor(snapshot: ConversationSnapshot) {
    this.state = { ...snapshot };
    for (const entry of snapshot.entries) this.entries.set(entry.key, entry);
  }

  static fromPage(page: Omit<ViewPage, "streamCursor">): ConversationModel {
    return new ConversationModel({ projectionVersion: page.projectionVersion, viewRevision: page.viewRevision,
      orderingEpoch: page.orderingEpoch, rawHigh: page.rawHigh, entries: page.entries, entriesBefore: page.entriesBefore });
  }

  /** A cached snapshot is usable only from the same projection. */
  static restore(snapshot: ConversationSnapshot | undefined): ConversationModel | undefined {
    return snapshot?.projectionVersion === PROJECTION_VERSION && Array.isArray(snapshot.entries) ? new ConversationModel(snapshot) : undefined;
  }

  get viewRevision() { return this.state.viewRevision; }
  get rawHigh() { return this.state.rawHigh; }
  get entriesBefore() { return this.state.entriesBefore; }

  /** The oldest anchor held: entries before it belong to pages not loaded. */
  private get floor() {
    if (this.state.entriesBefore === null) return 0;
    let floor = Number.MAX_SAFE_INTEGER;
    for (const entry of this.entries.values()) floor = Math.min(floor, entry.anchor);
    return floor;
  }

  list(): EntryView[] { return [...this.entries.values()].sort((a, b) => a.anchor - b.anchor); }

  snapshot(): ConversationSnapshot { return { ...this.state, entries: this.list() }; }

  private keep(entry: EntryView) {
    const held = this.entries.get(entry.key);
    if (held && held.rev > entry.rev) return;
    if ((this.removed.get(entry.key) ?? -1) >= entry.rev) return;
    // Older items a reader loaded stay while the entry has not changed.
    this.entries.set(entry.key, held && held.rev === entry.rev && held.items.length > entry.items.length ? held : entry);
  }

  applyChanges(changes: Omit<ViewChanges, "streamCursor">): ApplyResult {
    if (changes.projectionVersion !== this.state.projectionVersion || changes.orderingEpoch !== this.state.orderingEpoch) return { kind: "reset" };
    if (changes.fromRevision !== this.state.viewRevision) return { kind: "stale" };
    const floor = this.floor;
    for (const entry of changes.entries) {
      if (entry.anchor < floor) this.entries.delete(entry.key);
      else this.keep(entry);
    }
    for (const gone of changes.removed) { this.entries.delete(gone.key); this.removed.set(gone.key, gone.rev); }
    this.state.viewRevision = changes.toRevision;
    let newRawEvents = 0;
    const raw = changes.raw;
    if (raw.after === this.state.rawHigh && raw.through >= raw.after) { newRawEvents = raw.count; this.state.rawHigh = raw.through; }
    this.trim();
    return { kind: "applied", newRawEvents };
  }

  /** An older page: merged by revision, without moving the revision or the raw counter. */
  applyOlder(page: Omit<ViewPage, "streamCursor">): ApplyResult {
    if (page.projectionVersion !== this.state.projectionVersion || page.orderingEpoch !== this.state.orderingEpoch) return { kind: "reset" };
    for (const entry of page.entries) this.keep(entry);
    this.state.entriesBefore = page.entriesBefore;
    return { kind: "applied", newRawEvents: 0 };
  }

  /** Older items of one entry, from the entry endpoint. */
  applyEntryItems(entry: EntryView): void {
    const held = this.entries.get(entry.key);
    if (!held || held.rev !== entry.rev) { this.keep(entry); return; }
    const known = new Set(held.items.map(i => i.itemId));
    const older = entry.items.filter(i => !known.has(i.itemId));
    this.entries.set(entry.key, { ...held, items: [...older, ...held.items], itemsBefore: entry.itemsBefore });
  }

  /** A long open conversation keeps its latest entries; the rest can be paged in again. */
  private trim() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const list = this.list(), dropped = list.slice(0, list.length - MAX_ENTRIES);
    for (const entry of dropped) this.entries.delete(entry.key);
    const first = list[dropped.length]!;
    this.state.entriesBefore = `v:${this.state.orderingEpoch}:${first.anchor}`;
  }
}
