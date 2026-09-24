import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persists a snapshot to disk atomically (temp write + rename) while coalescing
 * bursts of mutations into at most one write per `delayMs`.
 *
 * The bridge's conversation archive outbox is a full-file snapshot kept in
 * memory. Rewriting the entire file on every mutation is O(n) per event, and
 * during an event burst — or while the control plane is disconnected and acks
 * stall, letting the outbox grow to its cap — the amplification becomes O(n^2)
 * and drives tens of GB of transient writes despite the on-disk file staying
 * small (it is repeatedly overwritten via rename).
 *
 * Coalescing bounds the write rate to 1/`delayMs` regardless of mutation rate.
 * The snapshot is captured lazily at flush time via the latest `serialize`
 * closure, so a coalesced write always persists the most recent state. The
 * in-memory map remains the source of truth, and every event is still sent live,
 * so at most `delayMs` of un-acked outbox entries can be lost to a hard crash —
 * and those replay idempotently (eventId-keyed acks) on reconnect.
 */
export class CoalescedFileWriter {
  private timer?: NodeJS.Timeout;
  private serialize?: () => string;
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly delayMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Mark new content pending; the latest closure wins and is serialized at flush time. */
  schedule(serialize: () => string): void {
    this.serialize = serialize;
    this.dirty = true;
    if (this.timer) return; // a flush is already scheduled within this window
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Write any pending snapshot immediately. Call on graceful shutdown. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }

  private flush(): void {
    if (!this.dirty || !this.serialize) return;
    const data = this.serialize();
    this.dirty = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, data, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) {
      this.onError(error);
    }
  }
}
