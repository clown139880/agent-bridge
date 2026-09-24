import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";

/**
 * Wakes stream readers after a write. Readers still pull from SQLite, so a
 * missed or coalesced signal only delays delivery until the safety poll.
 */
export const streamSignal = new EventEmitter();
streamSignal.setMaxListeners(0);
let signalQueued = false;

export function signalStream(): void {
  if (signalQueued) return;
  signalQueued = true;
  // Emit after the caller's synchronous transaction has committed.
  setImmediate(() => { signalQueued = false; streamSignal.emit("change"); });
}

export type StreamKind = "session" | "worker" | "run" | "approval" | "user_input" | "action";

/**
 * Record that a resource's current state changed. The change log is compacted by
 * construction: one row per resource, whose sequence moves forward on each change.
 * Readers materialize the resource's present state when they deliver the row.
 */
export function markChanged(db: DatabaseSync, kind: StreamKind, id: string): void {
  db.prepare("INSERT OR REPLACE INTO stream_changes(kind,id) VALUES (?,?)").run(kind, id);
  signalStream();
}
