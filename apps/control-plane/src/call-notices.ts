import type { AgentControlStore, NoticeRow } from "@agent-bridge/database";
import pino from "pino";

const log = pino({ name: "call-notices" });
/** A notice older than this is not worth a phone call any more. */
const STALE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const SPOKEN_CHARS = 300;
/** Who is calling: the Matrix connector's account (megumi, 惠) rings from its DM, whatever agent call-bridge names. */
const PREFACE = "你好，我是惠，有一条通知：";

/** What the call service needs: ring `to` and read `message` (call-bridge's call_place, mode notify). */
export type PlaceCall = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Notices addressed `call:<who>` (an automation's deliver, CONTROL_*_NOTICE_TARGET): call-bridge rings that
 * person and reads the notice out. Fire and forget: the notice counts as delivered once the call is placed;
 * a failed placement is retried a few times, then reported to the operator instead.
 */
export class CallNotices {
  private readonly attempts = new Map<string, number>();
  private readonly placing = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: AgentControlStore, private readonly place: PlaceCall,
    private readonly failed: (text: string) => void, private readonly now = Date.now) {}

  start(): void { this.timer = setInterval(() => void this.tick(), 5_000); this.timer.unref(); void this.tick(); }
  stop(): void { clearInterval(this.timer); }

  async tick(): Promise<void> {
    for (const notice of this.store.notices({ connector: "call", undelivered: true, limit: 20 })) {
      if (this.placing.has(notice.id)) continue;
      if (this.now() - notice.createdAt > STALE_MS) { this.store.markNoticeDelivered(notice.id, "call:stale"); continue; }
      this.placing.add(notice.id);
      try {
        await this.place({ to: notice.roomId, mode: "notify", preface: PREFACE, message: spoken(notice.text), wait: "none", idempotency_key: `notice:${notice.id}` });
        this.store.markNoticeDelivered(notice.id, `call:${notice.roomId}`);
        this.attempts.delete(notice.id);
      } catch (error) {
        const attempts = (this.attempts.get(notice.id) ?? 0) + 1;
        log.warn({ noticeId: notice.id, attempts, error: error instanceof Error ? error.message : String(error) }, "Call notice not placed");
        if (attempts >= MAX_ATTEMPTS) {
          this.store.markNoticeDelivered(notice.id, "call:failed");
          this.attempts.delete(notice.id);
          this.failed(`📞 没打通给 ${notice.roomId} 的电话通知：${notice.text.split("\n", 1)[0]!.slice(0, 80)}`);
        } else this.attempts.set(notice.id, attempts);
      } finally { this.placing.delete(notice.id); }
    }
  }
}

/** A notice as read aloud: no markup or links, at most a few sentences. */
export function spoken(text: string): string {
  const plain = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[`*_#>|~]/g, "")
    .replace(/\s+/g, " ").trim();
  return Array.from(plain).length > SPOKEN_CHARS ? `${Array.from(plain).slice(0, SPOKEN_CHARS).join("")}……` : plain;
}

export type { NoticeRow };
