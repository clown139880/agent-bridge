import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Sessions talking to each other through /mcp/bridge (docs/agent-dispatch-and-review.zh.md §5). When a
 * session contacts another with `create` or `turn` and names itself (`from_session_id`), the message
 * carries a reply key; the receiver answers with `reply` and that key, which needs no approval: the key
 * itself is the permission, and a reply only delivers text, whose consequences pass the sender's own
 * approvals. Each reply hands back a fresh key, so the two can go back and forth up to a limit.
 */

/** A key answers for this long. */
export const REPLY_KEY_MS = 24 * 3_600_000;
/** Messages one pair of sessions may exchange per day, both directions; the one over it goes to the human. */
export const PAIR_MESSAGES_PER_DAY = 20;

/** A message one session sent another; `to` is the session that may answer it. */
export interface Contact { key: string; from: string; to: string; createdAt: number; repliedAt: number | null }

export class SessionContacts {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_contacts (key TEXT PRIMARY KEY, from_session TEXT NOT NULL, to_session TEXT,
      created_at INTEGER NOT NULL, replied_at INTEGER);
      CREATE INDEX IF NOT EXISTS session_contacts_pair ON session_contacts(from_session, to_session, created_at);`);
  }

  /** A key for a message `from` sends; `to` is filled once a created session has its id. */
  open(from: string, to?: string): string {
    const key = `rk_${randomBytes(12).toString("base64url")}`;
    this.db.prepare("INSERT INTO session_contacts(key,from_session,to_session,created_at) VALUES(?,?,?,?)").run(key, from, to ?? null, Date.now());
    return key;
  }

  bind(key: string, to: string): void {
    this.db.prepare("UPDATE session_contacts SET to_session=? WHERE key=?").run(to, key);
  }

  /** The contact a reply key answers: unknown, expired or used keys throw with a reason the agent can act on. */
  answer(key: string): Contact {
    const row = this.db.prepare("SELECT * FROM session_contacts WHERE key=?").get(key) as Record<string, unknown> | undefined;
    if (!row || !row.to_session) throw coded("reply_key_unknown", "no message carries this reply_key; copy it from the message you answer");
    const contact = { key, from: String(row.from_session), to: String(row.to_session), createdAt: Number(row.created_at),
      repliedAt: row.replied_at == null ? null : Number(row.replied_at) };
    if (Date.now() - contact.createdAt > REPLY_KEY_MS) throw coded("reply_key_expired", "this reply_key is older than a day; contact the session with turn instead");
    if (contact.repliedAt) throw coded("reply_key_used", "this message was already answered; use the reply_key of the latest message");
    return contact;
  }

  replied(key: string): void {
    this.db.prepare("UPDATE session_contacts SET replied_at=? WHERE key=?").run(Date.now(), key);
  }

  /** Messages between two sessions in the last day, both directions. */
  exchanged(a: string, b: string): number {
    const since = Date.now() - 86_400_000;
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM session_contacts WHERE created_at>? AND
      ((from_session=? AND to_session=?) OR (from_session=? AND to_session=?))`).get(since, a, b, b, a) as { n: number }).n);
  }
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
