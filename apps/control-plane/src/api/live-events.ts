import type { SessionDeltaMessage } from "@agent-bridge/protocol";

export interface LiveSessionDelta extends Omit<SessionDeltaMessage, "type"> {
  cursor: string;
}

interface Waiter {
  sessionId: string;
  after: number;
  resolve(): void;
}

export class LiveCursorError extends Error {
  constructor(readonly code: "invalid_cursor" | "cursor_expired") { super(code); }
}

/** A bounded, process-local relay for token-level output. Durable completed
 * items continue through the retained session-event store. */
export class LiveSessionEvents {
  private sequence = 0;
  private readonly rows: Array<LiveSessionDelta & { sequence: number }> = [];
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly capacity = 4096) {}

  publish(message: SessionDeltaMessage): void {
    const sequence = ++this.sequence;
    this.rows.push({ ...message, cursor: `l:${sequence}`, sequence });
    while (this.rows.length > this.capacity) this.rows.shift();
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId === message.sessionId && sequence > waiter.after) waiter.resolve();
    }
  }

  async read(sessionId: string, cursor: string | undefined, waitMs: number, signal?: AbortSignal): Promise<{
    data: LiveSessionDelta[]; nextCursor: string;
  }> {
    const after = this.parse(cursor);
    let page = this.page(sessionId, after);
    if (page.data.length || !cursor || waitMs <= 0) return page;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const waiter: Waiter = { sessionId, after, resolve: finish };
      const timer = setTimeout(finish, waitMs);
      timer.unref();
      this.waiters.add(waiter);
      signal?.addEventListener("abort", finish, { once: true });
      // Close the check/register race if a delta arrived between page() and add().
      if (this.sequence > after && this.rows.some(row => row.sessionId === sessionId && row.sequence > after)) finish();
    });
    page = this.page(sessionId, after);
    return page;
  }

  private parse(cursor?: string): number {
    if (!cursor) return this.sequence;
    const match = cursor.match(/^l:(\d+)$/);
    if (!match) throw new LiveCursorError("invalid_cursor");
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0 || value > this.sequence) throw new LiveCursorError("invalid_cursor");
    const first = this.rows[0]?.sequence;
    if (first !== undefined && value < first - 1) throw new LiveCursorError("cursor_expired");
    if (first === undefined && value < this.sequence) throw new LiveCursorError("cursor_expired");
    return value;
  }

  private page(sessionId: string, after: number): { data: LiveSessionDelta[]; nextCursor: string } {
    const data = this.rows.filter(row => row.sessionId === sessionId && row.sequence > after)
      .map(({ sequence: _sequence, ...row }) => row);
    return { data, nextCursor: `l:${this.sequence}` };
  }
}
