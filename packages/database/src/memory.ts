import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { decodeEventBody, EVENT_COLUMNS, searchText, type EventRow } from "./events.js";

export type ConversationRole = "user" | "assistant" | "tool" | "system";

export interface ConversationSearchInput {
  query: string;
  cwd?: string;
  machineId?: string;
  repository?: string;
  projectAlias?: string;
  sourceSessionId?: string;
  scope?: "auto" | "session" | "project" | "all";
  since?: number;
  until?: number;
  agents?: string[];
  cursor?: string;
  limit?: number;
}

function normalizeRepository(value: string): string {
  const remote = value.trim();
  const scp = remote.match(/^(?:[^@/:]+@)?([^:]+):(.+)$/);
  if (scp && !remote.includes("://")) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  try {
    const url = new URL(remote.includes("://") ? remote : `https://${remote}`);
    return `${url.host}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  } catch { return remote.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase(); }
}

function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { sequence?: unknown };
    if (!Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) <= 0) throw new Error();
    return Number(parsed.sequence);
  } catch { throw new Error("invalid_cursor"); }
}

function textSentences(text: string): string[] {
  return text.split(/(?<=[。！？.!?])\s*|\n+/u).map((item) => item.trim()).filter(Boolean);
}

/** Message pointers are event pointers: `e:<events.id>`, the same cursor the session event API uses. */
function eventPointer(value: string): number {
  const match = value.match(/^e:(\d+)$/);
  if (!match) throw new Error("message_not_found");
  return Number(match[1]);
}

const TRIGRAM = 3;

/** A turn summary that repeats the turn's closing assistant message is the same message, shown once. */
const DISTINCT_SUMMARY = `NOT (e.type='turn.completed' AND EXISTS (SELECT 1 FROM events a WHERE a.session_id=e.session_id
  AND a.turn_id=e.turn_id AND a.type='message.completed' AND typeof(a.body)='text' AND typeof(e.body)='text'
  AND json_extract(a.body,'$.role')='assistant' AND json_extract(a.body,'$.text')=json_extract(e.body,'$.summary')))`;

/**
 * Conversation memory is a read view over the permanent session event history.
 * It stores nothing of its own except repository identity and collection gaps.
 */
export class ConversationMemoryStore {
  constructor(readonly db: DatabaseSync) {}

  upsertSessionProject(sessionId: string, projectIdentity?: string): void {
    if (projectIdentity) this.db.prepare("UPDATE sessions SET project_identity=? WHERE id=?")
      .run(normalizeRepository(projectIdentity), sessionId);
  }

  recordGap(gapId: string, sourceInstance: string, firstEventId: string | undefined, lastEventId: string | undefined,
    droppedCount: number, reason: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO conversation_collection_gaps
      (gap_id,source_instance,first_event_id,last_event_id,dropped_count,reason,reported_at) VALUES (?,?,?,?,?,?,?)`)
      .run(gapId, sourceInstance, firstEventId ?? null, lastEventId ?? null, droppedCount, reason, Date.now());
  }

  search(input: ConversationSearchInput): Record<string, unknown> {
    const query = input.query.normalize("NFKC").trim();
    if (!query) throw new Error("query_required");
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const before = decodeCursor(input.cursor);
    const where: string[] = [];
    const params: Array<string | number> = [];
    const resolution: Record<string, unknown> = { requestedScope: input.scope ?? "auto" };

    if (input.sourceSessionId) {
      const row = this.db.prepare("SELECT id FROM sessions WHERE id=? OR native_session_id=? ORDER BY updated_at DESC LIMIT 1")
        .get(input.sourceSessionId, input.sourceSessionId) as { id: string } | undefined;
      if (row) { where.push("s.id=?"); params.push(row.id); resolution.kind = "source_session"; resolution.sessionId = row.id; }
      else { where.push("0=1"); resolution.kind = "unresolved_source_session"; }
    } else if (input.scope !== "all" && input.machineId && input.cwd) {
      where.push("s.machine_id=? AND s.project_path=?"); params.push(input.machineId, input.cwd);
      resolution.kind = "machine_cwd"; resolution.machineId = input.machineId; resolution.cwd = input.cwd;
    } else if (input.scope !== "all" && input.repository) {
      const repository = normalizeRepository(input.repository);
      where.push("s.project_identity=?"); params.push(repository);
      resolution.kind = "repository"; resolution.repository = repository;
    } else if (input.scope !== "all" && input.projectAlias) {
      where.push("s.project_name=?"); params.push(input.projectAlias);
      resolution.kind = "project_alias"; resolution.projectAlias = input.projectAlias;
    } else {
      resolution.kind = "keyword_global";
      resolution.note = "No trusted project locator resolved; results are global candidates.";
    }
    if (input.since !== undefined) { where.push("e.created_at>=?"); params.push(input.since); }
    if (input.until !== undefined) { where.push("e.created_at<=?"); params.push(input.until); }
    if (input.agents?.length) {
      where.push(`s.agent_type IN (${input.agents.map(() => "?").join(",")})`); params.push(...input.agents);
    }
    if (before !== undefined) { where.push("e.id<?"); params.push(before); }

    const terms = query.match(/[^\s"]+/gu) ?? [];
    const columns = `${EVENT_COLUMNS.split(",").map((name) => `e.${name}`).join(",")},
      s.title,s.project_name,s.project_path,s.project_identity,s.agent_type,s.machine_id,s.native_session_id`;
    let rows: Array<Record<string, unknown>>;
    if (terms.length && terms.every((term) => Array.from(term).length >= TRIGRAM)) {
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      rows = this.db.prepare(`SELECT ${columns} FROM event_search f JOIN events e ON e.id=f.rowid
        JOIN sessions s ON s.id=e.session_id WHERE event_search MATCH ? ${where.map((item) => `AND ${item}`).join(" ")}
        ORDER BY e.id DESC LIMIT ?`).all(match, ...params, limit + 1) as Array<Record<string, unknown>>;
    } else {
      // A term shorter than one trigram cannot use the index; scan conversation text directly.
      const like = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      rows = this.db.prepare(`SELECT ${columns} FROM events e JOIN sessions s ON s.id=e.session_id
        WHERE e.type='message.completed' AND typeof(e.body)='text' AND json_extract(e.body,'$.text') LIKE ? ESCAPE '\\'
        ${where.map((item) => `AND ${item}`).join(" ")} ORDER BY e.id DESC LIMIT ?`)
        .all(like, ...params, limit + 1) as Array<Record<string, unknown>>;
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const results = rows.map((row) => {
      const payload = decodeEventBody(row.body);
      return {
        sessionId: String(row.session_id), title: row.title ? String(row.title) : null,
        project: { name: String(row.project_name), path: String(row.project_path),
          identity: row.project_identity ? String(row.project_identity) : null },
        agent: String(row.agent_type), messageId: `e:${Number(row.id)}`, role: roleOf(String(row.type), payload),
        occurredAt: Number(row.created_at), snippet: snippet(searchText(String(row.type), payload) ?? "", terms.length ? terms : [query]),
        source: { instance: String(row.machine_id), sessionId: String(row.native_session_id ?? row.session_id),
          eventId: String(row.event_id) },
        completeness: completenessOf(payload),
      };
    });
    return { query, resolvedScope: resolution,
      searchCoverage: "conversation text, turn summaries, command lines and changed file paths (not tool output)",
      results, nextCursor: hasMore && rows.length ? encodeCursor(Number(rows.at(-1)!.id)) : null };
  }

  read(input: { sessionId: string; messageId?: string; cursor?: string; direction?: "before" | "after";
    limit?: number; messageOffset?: number; maxChars?: number }): Record<string, unknown> {
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    let anchor: number | undefined = decodeCursor(input.cursor);
    if (input.messageId) {
      const id = eventPointer(input.messageId);
      if (!this.db.prepare("SELECT 1 FROM events WHERE id=? AND session_id=?").get(id, input.sessionId)) throw new Error("message_not_found");
      anchor = id;
    }
    const direction = input.direction ?? "after";
    const compare = anchor === undefined ? "" : direction === "after" ? "AND e.id>=?" : "AND e.id<=?";
    const rows = this.db.prepare(`SELECT ${EVENT_COLUMNS.split(",").map((name) => `e.${name}`).join(",")} FROM events e
      WHERE e.session_id=? AND e.type<>'context.updated' AND ${DISTINCT_SUMMARY} ${compare}
      ORDER BY e.id ${direction === "after" ? "ASC" : "DESC"} LIMIT ?`)
      .all(input.sessionId, ...(anchor === undefined ? [] : [anchor]), limit + 1) as unknown as EventRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    if (direction === "before") rows.reverse();
    const messages = rows.map((row) => shapeMessage(row,
      input.messageId && `e:${row.id}` === input.messageId ? input.messageOffset ?? 0 : 0, input.maxChars ?? 12_000));
    const first = rows.at(0), last = rows.at(-1);
    const gaps = this.sessionGaps(input.sessionId);
    return { sessionId: input.sessionId, messages,
      previousCursor: first ? encodeCursor(first.id) : null,
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      completeness: gaps.length ? { status: "incomplete", gaps } : { status: "complete" } };
  }

  review(sessionId: string, focus?: string, outputBudget = 4_000): Record<string, unknown> {
    const session = this.db.prepare(`SELECT id,title,project_name,project_path,project_identity,agent_type,source,
      history_completeness FROM sessions WHERE id=?`).get(sessionId) as Record<string, unknown> | undefined;
    if (!session) throw new Error("session_not_found");
    const conversation = (this.db.prepare(`SELECT ${EVENT_COLUMNS.split(",").map((name) => `e.${name}`).join(",")} FROM events e
      WHERE e.session_id=? AND e.type IN ('message.completed','turn.completed') AND ${DISTINCT_SUMMARY} ORDER BY e.id`)
      .all(sessionId) as unknown as EventRow[])
      .map((row) => ({ row, payload: decodeEventBody(row.body) }))
      .map(({ row, payload }) => ({ row, role: roleOf(row.type, payload), text: contentOf(row.type, payload) }))
      .filter((item) => item.text.trim() && (item.role === "user" || item.role === "assistant"));
    const user = conversation.filter((item) => item.role === "user");
    const assistant = conversation.filter((item) => item.role === "assistant");
    const select = (source: typeof conversation, pattern: RegExp, count: number) => source.flatMap((item) =>
      textSentences(item.text).filter((sentence) => pattern.test(sentence))
        .map((text) => ({ text, messageId: `e:${item.row.id}` }))).slice(0, count);
    const summary = conversation.length ? {
      goal: user.length ? { text: textSentences(user[0]!.text)[0] ?? user[0]!.text, messageId: `e:${user[0]!.row.id}` } : null,
      constraints: select(user, /必须|不要|不能|不作为|不依赖|约束|only|must|do not|without/i, 12),
      confirmedDecisions: select(user, /决定|确认|采用|提供|不持有|不作为|纳入|必须|MCP|projectId|Obsidian|容量/i, 16),
      assistantSuggestions: select(assistant, /建议|可以|应该|方案|recommend|could|should/i, 12),
      openQuestions: [...select(user, /[？?]|未决|待确认|是否/u, 8), ...select(assistant, /[？?]|未决|待确认/u, 4)],
      generator: "extractive-v1",
      note: "Extractive navigation only. Verify decisions against the pointed original messages and current repository state.",
    } : null;
    const boundedRecent: unknown[] = [];
    let used = JSON.stringify(summary).length;
    for (const { row } of conversation.slice(-12)) {
      const item = shapeMessage(row);
      const size = JSON.stringify(item).length;
      if (used + size > Math.max(1_000, outputBudget)) break;
      boundedRecent.push(item); used += size;
    }
    return { sessionId, focus: focus ?? null, session: {
      title: session.title ?? null, projectName: session.project_name, projectPath: session.project_path,
      repository: session.project_identity ?? null, agent: session.agent_type, source: session.source,
    }, summary, summaryStatus: summary ? "ready" : "unavailable",
      summaryThrough: conversation.length ? `e:${conversation.at(-1)!.row.id}` : null,
      recentMessages: boundedRecent, originalPointers: boundedRecent.map((item) => (item as { messageId: string }).messageId),
      completeness: { source: session.history_completeness, collectionGaps: this.sessionGaps(sessionId) } };
  }

  audit(): Record<string, unknown> {
    const tables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'event_search_%' ORDER BY name`).all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(name) || name === "event_search") continue;
      counts[name] = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n);
    }
    const page = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const events = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(length(body)),0) AS bodyBytes,
      SUM(CASE WHEN typeof(body)='blob' THEN 1 ELSE 0 END) AS compressed,MIN(created_at) AS oldest,MAX(created_at) AS newest
      FROM events`).get() as Record<string, unknown>;
    const byType = this.db.prepare(`SELECT type,COUNT(*) AS count,COALESCE(SUM(length(body)),0) AS bodyBytes
      FROM events GROUP BY type ORDER BY bodyBytes DESC`).all();
    const databaseFile = (this.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>)
      .find((item) => item.name === "main")?.file;
    const walFile = databaseFile ? `${databaseFile}-wal` : undefined;
    return { generatedAt: Date.now(), databaseFile,
      sqliteBytes: databaseFile && existsSync(databaseFile) ? statSync(databaseFile).size
        : Number(page.page_count) * Number(pageSize.page_size),
      walBytes: walFile && existsSync(walFile) ? statSync(walFile).size : 0,
      tables: counts, events, eventsByType: byType };
  }

  private sessionGaps(sessionId: string): unknown[] {
    return this.db.prepare(`SELECT g.first_event_id AS firstEventId,g.last_event_id AS lastEventId,
      g.dropped_count AS droppedCount,g.reason,g.reported_at AS reportedAt FROM conversation_collection_gaps g
      JOIN sessions s ON s.machine_id=g.source_instance WHERE s.id=? ORDER BY g.reported_at`).all(sessionId);
  }
}

function roleOf(type: string, payload: Record<string, unknown>): ConversationRole {
  if (type === "message.completed") return payload.role === "user" ? "user" : "assistant";
  if (type === "turn.completed") return "assistant";
  if (type === "command.completed" || type === "file_change.completed") return "tool";
  return "system";
}

function contentOf(type: string, payload: Record<string, unknown>): string {
  const text = (value: unknown) => typeof value === "string" ? value : "";
  if (type === "message.completed") return text(payload.text);
  if (type === "turn.completed") return text(payload.summary) || `[turn ${text(payload.status) || "completed"}]`;
  if (type === "command.completed") {
    const exit = typeof payload.exitCode === "number" ? `; exit=${payload.exitCode}` : "";
    const output = text(payload.output);
    return `$ ${text(payload.command)}\n[status=${text(payload.status) || "unknown"}${exit}]${output ? `\n${output}` : ""}`;
  }
  if (type === "file_change.completed" && Array.isArray(payload.changes)) {
    return payload.changes.map((change) => {
      const item = change && typeof change === "object" ? change as Record<string, unknown> : {};
      return `${text(item.kind) || "change"} ${text(item.path)}${text(item.diff) ? `\n${text(item.diff)}` : ""}`;
    }).join("\n");
  }
  return `[${type}] ${JSON.stringify(payload)}`;
}

function completenessOf(payload: Record<string, unknown>): string {
  if (payload.restored === true) return "restored-from-memory";
  if (payload.historyCompleteness === "terminal-only") return "terminal-only-source";
  if (payload.truncated === true || payload.contentTruncated === true) return "source-truncated";
  return "complete";
}

function shapeMessage(row: EventRow, messageOffset = 0, maxChars = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
  const payload = decodeEventBody(row.body);
  const points = Array.from(contentOf(row.type, payload));
  const boundedOffset = Math.min(points.length, Math.max(0, messageOffset));
  const segment = points.slice(boundedOffset, boundedOffset + Math.max(1, maxChars));
  const nextOffset = boundedOffset + segment.length;
  return { messageId: `e:${row.id}`, role: roleOf(row.type, payload), type: row.type, content: segment.join(""),
    occurredAt: Number(row.created_at), sourcePosition: { eventId: row.event_id, turnId: row.turn_id, itemId: row.item_id,
      messageOffset: boundedOffset }, completeness: completenessOf(payload),
    contentTruncated: boundedOffset > 0 || nextOffset < points.length,
    originalContentChars: points.length, nextMessageOffset: nextOffset < points.length ? nextOffset : null };
}

/** A short window around the first matched term, computed from the stored body rather than a second copy. */
function snippet(text: string, terms: string[], radius = 120): string {
  const lower = text.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return Array.from(text).slice(0, radius * 2).join("");
  const term = terms.find((item) => lower.indexOf(item.toLowerCase()) === at)!;
  const start = Math.max(0, at - radius), end = Math.min(text.length, at + term.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, at)}[${text.slice(at, at + term.length)}]${text.slice(at + term.length, end)}${end < text.length ? "…" : ""}`;
}
