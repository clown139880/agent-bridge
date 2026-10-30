import type { AgentMemory, ScopeInfo, Writer } from "@agent-bridge/agent-memory";
import type { AgentControlStore } from "@agent-bridge/database";
import type { BridgeRegistry } from "./bridge-registry.js";

/** Agents a chat room can run, by worker-id prefix. */
export const CONVERSATION_AGENTS = ["pi", "codex", "claude", "grok"] as const;
export type ConversationAgent = typeof CONVERSATION_AGENTS[number];
const DEFAULT_AGENT: ConversationAgent = "pi";
const AGENT_TYPES: Record<string, ConversationAgent> = { pi: "pi", "codex-cli": "codex", "claude-code": "claude", grok: "grok" };

export interface Conversation {
  connector: string;
  roomId: string;
  /** "" is the room's main timeline; otherwise the id of the thread's root message. */
  threadId: string;
  /** The session this conversation continues; null until its next message starts one. */
  sessionId: string | null;
  /** Agent for the room's next new session: the last one used, pi at first. */
  agent: ConversationAgent;
  scope: { id: string; title: string } | null;
  /** Where a new session runs, from the scope's bound locations or its repository's sessions. */
  target: { workerId: string; workspace: string } | null;
  problem?: "room_unbound" | "scope_has_no_workspace" | "memory_unavailable";
}

/**
 * Chat connectors (Matrix, WeChat, …) keep no project state of their own. A room's project is
 * its central memory scope (`rooms: [matrix:!id]`); this records which session each room and
 * thread continues, so a `new` session takes over the room and the old one stops reporting there.
 */
export class Conversations {
  constructor(private readonly store: AgentControlStore, private readonly registry: BridgeRegistry,
    private readonly memory?: AgentMemory) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_rooms (connector TEXT NOT NULL, room_id TEXT NOT NULL,
        agent TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(connector, room_id));
      CREATE TABLE IF NOT EXISTS conversation_threads (connector TEXT NOT NULL, room_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, session_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(connector, room_id, thread_id));
      CREATE INDEX IF NOT EXISTS conversation_threads_session ON conversation_threads(session_id);
    `);
  }

  list(connector: string): Array<{ roomId: string; threadId: string; sessionId: string }> {
    return (this.store.db.prepare(`SELECT room_id,thread_id,session_id FROM conversation_threads
      WHERE connector=? AND session_id IS NOT NULL ORDER BY updated_at`).all(connector) as Array<Record<string, string>>)
      .map((row) => ({ roomId: row.room_id!, threadId: row.thread_id!, sessionId: row.session_id! }));
  }

  get(connector: string, roomId: string, threadId = ""): Conversation {
    const thread = this.store.db.prepare("SELECT session_id FROM conversation_threads WHERE connector=? AND room_id=? AND thread_id=?")
      .get(connector, roomId, threadId) as { session_id: string | null } | undefined;
    const room = this.store.db.prepare("SELECT agent FROM conversation_rooms WHERE connector=? AND room_id=?")
      .get(connector, roomId) as { agent: ConversationAgent } | undefined;
    const agent = room?.agent ?? DEFAULT_AGENT;
    let sessionId = thread?.session_id ?? null;
    const session = sessionId ? this.store.session(sessionId) : undefined;
    if (sessionId && !session) sessionId = null; // deleted elsewhere: the next message starts a new one
    const base = { connector, roomId, threadId, sessionId, agent };
    if (!this.memory) return { ...base, scope: null, target: null, problem: "memory_unavailable" };
    const scope = this.scopeOf(connector, roomId);
    if (!scope) return { ...base, scope: null, target: null, problem: "room_unbound" };
    const target = session ? { workerId: String(session.workerId), workspace: String(session.workspace) } : this.target(scope, agent);
    return { ...base, scope: { id: scope.id, title: scope.title }, target, ...(target ? {} : { problem: "scope_has_no_workspace" as const }) };
  }

  /** `sessionId: null` is `new`: the room's next message starts a session with `agent`. */
  set(connector: string, roomId: string, threadId: string, change: { sessionId?: string | null; agent?: ConversationAgent }): Conversation {
    const now = Date.now();
    this.store.transaction(() => {
      if (change.agent) this.store.db.prepare(`INSERT INTO conversation_rooms VALUES(?,?,?,?)
        ON CONFLICT(connector,room_id) DO UPDATE SET agent=excluded.agent,updated_at=excluded.updated_at`).run(connector, roomId, change.agent, now);
      if (change.sessionId !== undefined) {
        // A session reports to one conversation: binding it here detaches it from any other.
        if (change.sessionId) this.store.db.prepare("UPDATE conversation_threads SET session_id=NULL,updated_at=? WHERE session_id=?").run(now, change.sessionId);
        this.store.db.prepare(`INSERT INTO conversation_threads VALUES(?,?,?,?,?)
          ON CONFLICT(connector,room_id,thread_id) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at`)
          .run(connector, roomId, threadId, change.sessionId, now);
        const agent = change.sessionId ? AGENT_TYPES[String(this.store.session(change.sessionId)?.agent)] : undefined;
        if (agent && !change.agent) this.store.db.prepare(`INSERT INTO conversation_rooms VALUES(?,?,?,?)
          ON CONFLICT(connector,room_id) DO UPDATE SET agent=excluded.agent,updated_at=excluded.updated_at`).run(connector, roomId, agent, now);
      }
    });
    return this.get(connector, roomId, threadId);
  }

  /** Bind the room (and optionally a machine path) to a scope in central memory. */
  bind(writer: Writer, connector: string, roomId: string, scopeId: string, location?: { machine: string; path: string }): Conversation {
    if (!this.memory) throw new Error("memory_unavailable");
    this.memory.bind(writer, scopeId, { room: `${connector}:${roomId}`, location });
    return this.get(connector, roomId);
  }

  /** The memory scope a session started from a room belongs to, for its bootstrap on resume. */
  scopeForSession(sessionId: string): string | undefined {
    const row = this.store.db.prepare("SELECT connector,room_id FROM conversation_threads WHERE session_id=? LIMIT 1")
      .get(sessionId) as { connector: string; room_id: string } | undefined;
    return row && this.memory ? this.scopeOf(row.connector, row.room_id)?.id : undefined;
  }

  validScope(scopeId: string): boolean {
    return Boolean(this.memory?.scopes().some((scope) => scope.id === scopeId && scope.status !== "archived"));
  }

  private scopeOf(connector: string, roomId: string): ScopeInfo | undefined {
    const resolved = this.memory!.resolveScope({ roomId: `${connector}:${roomId}` });
    return resolved.matched === "room" ? this.memory!.scope(resolved.scope) : undefined;
  }

  /** A bound location on an online machine first; otherwise the latest session of the scope's repository. */
  private target(scope: ScopeInfo, agent: ConversationAgent): Conversation["target"] {
    const online = (machine: string) => Boolean(this.registry.get(machine));
    const location = scope.locations.find((item) => online(item.machine)) ?? scope.locations[0];
    if (location) return { workerId: `${agent}@${location.machine}`, workspace: location.path };
    if (!scope.repositories.length) return null;
    const rows = this.store.db.prepare(`SELECT machine_id,project_path FROM sessions WHERE project_identity IN
      (${scope.repositories.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 50`).all(...scope.repositories) as
      Array<{ machine_id: string; project_path: string }>;
    const row = rows.find((item) => online(item.machine_id)) ?? rows[0];
    return row ? { workerId: `${agent}@${row.machine_id}`, workspace: row.project_path } : null;
  }
}
