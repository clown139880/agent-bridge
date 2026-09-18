import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import type { StructuredSessionEventMessage } from "@agent-bridge/protocol";

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

interface MessageRow {
  sequence: number;
  message_id: string;
  session_id: string;
  role: ConversationRole;
  content: string | null;
  occurred_at: number;
  collected_at: number;
  turn_id: string | null;
  item_id: string | null;
  storage_state: "hot" | "cold" | "deleted";
  archive_chunk_id: string | null;
  completeness: string;
}

interface ArchivedMessage {
  messageId: string;
  sequence: number;
  content: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function ftsQuery(query: string): string {
  const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function textSentences(text: string): string[] {
  return text.split(/(?<=[。！？.!?])\s*|\n+/u).map((item) => item.trim()).filter(Boolean);
}

export class ConversationMemoryStore {
  private capacityEstimate?: number;
  private writesSinceCapacityCheck = 0;

  constructor(readonly db: DatabaseSync, readonly objectDir: string,
    readonly limits: { maxCapacityBytes?: number; maxMessageBytes?: number } = {}) {}

  upsertSessionProject(sessionId: string, projectIdentity?: string): void {
    if (projectIdentity) this.db.prepare("UPDATE sessions SET project_identity=? WHERE id=?")
      .run(normalizeRepository(projectIdentity), sessionId);
  }

  backfillStoredEvents(): { scanned: number; inserted: number } {
    const rows = this.db.prepare(`SELECT e.payload,s.machine_id FROM events e JOIN sessions s ON s.id=e.session_id
      WHERE e.event_schema=2 AND e.type IN ('message.completed','turn.completed','command.completed') ORDER BY e.id`)
      .all() as Array<{ payload: string; machine_id: string }>;
    let inserted = 0;
    for (const row of rows) {
      try {
        const event = JSON.parse(row.payload) as Record<string, unknown>;
        const structured: StructuredSessionEventMessage = {
          type: "session.event", eventId: String(event.eventId), eventType: String(event.type) as StructuredSessionEventMessage["eventType"],
          sessionId: String(event.sessionId), timestamp: Number(event.timestamp),
          turnId: event.turnId ? String(event.turnId) : undefined, itemId: event.itemId ? String(event.itemId) : undefined,
          payload: event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload as Record<string, unknown> : {},
        };
        const result = this.ingestEvent(row.machine_id, structured);
        if (result.messageId && !result.duplicate) inserted++;
      } catch { /* an invalid old projection remains covered by its source completeness flag */ }
    }
    return { scanned: rows.length, inserted };
  }

  ingestEvent(machineId: string, message: StructuredSessionEventMessage, sourceSessionId = message.sessionId):
    { messageId?: string; duplicate: boolean } {
    const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
    let role: ConversationRole | undefined;
    let content: string | undefined;
    let completeness = "complete";
    if (message.eventType === "message.completed"
      && (payload.role === "user" || payload.role === "assistant") && typeof payload.text === "string") {
      role = payload.role;
      content = payload.text;
      if (payload.truncated === true || payload.contentTruncated === true) completeness = "source-truncated";
    } else if (message.eventType === "turn.completed" && typeof payload.summary === "string" && payload.summary) {
      role = "assistant";
      content = payload.summary;
      if (payload.historyCompleteness === "terminal-only") completeness = "terminal-only-source";
    } else if (message.eventType === "command.completed") {
      role = "tool";
      const command = typeof payload.command === "string" ? payload.command : "command";
      const output = typeof payload.output === "string" ? payload.output : "";
      const status = typeof payload.status === "string" ? payload.status : "unknown";
      const exit = typeof payload.exitCode === "number" ? `; exit=${payload.exitCode}` : "";
      content = `$ ${Array.from(command).slice(0, 1_000).join("")}\n[status=${status}${exit}]${output
        ? `\n${Array.from(output).slice(0, 2_000).join("")}` : ""}`;
      if (Array.from(command).length > 1_000 || Array.from(output).length > 2_000) completeness = "policy-truncated-tool-output";
      else if (payload.truncated === true || payload.contentTruncated === true) completeness = "source-truncated";
    }
    if (content?.includes("…[truncated]")) completeness = "source-truncated";
    if (!role || content === undefined) return { duplicate: false };
    const messageId = `msg_${sha256(`${machineId}\0${sourceSessionId}\0${message.eventId}`).slice(0, 32)}`;
    const existing = this.db.prepare(`SELECT message_id FROM conversation_messages
      WHERE source_instance=? AND source_session_id=? AND source_event_id=?
      UNION ALL SELECT message_id FROM conversation_source_aliases
      WHERE source_instance=? AND source_session_id=? AND source_event_id=? LIMIT 1`)
      .get(machineId, sourceSessionId, message.eventId, machineId, sourceSessionId, message.eventId) as
      { message_id: string } | undefined;
    if (existing) return { messageId: existing.message_id, duplicate: true };
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > (this.limits.maxMessageBytes ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error("conversation_message_size_limit_exceeded");
    }
    if (!this.reserveCapacity(contentBytes)) {
      throw new Error("conversation_capacity_limit_exceeded");
    }
    const contentHash = sha256(content);
    if (message.turnId) {
      const alias = this.db.prepare(`SELECT message_id FROM conversation_messages
        WHERE session_id=? AND role=? AND content_sha256=? AND turn_id=? LIMIT 1`)
        .get(message.sessionId, role, contentHash, message.turnId) as { message_id: string } | undefined;
      if (alias) {
        this.db.prepare(`INSERT OR IGNORE INTO conversation_source_aliases
          (source_instance,source_session_id,source_event_id,message_id) VALUES (?,?,?,?)`)
          .run(machineId, sourceSessionId, message.eventId, alias.message_id);
        return { messageId: alias.message_id, duplicate: true };
      }
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO conversation_messages
      (message_id,session_id,source_instance,source_session_id,source_event_id,role,content,content_sha256,
       content_chars,occurred_at,collected_at,turn_id,item_id,completeness)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, message.sessionId, machineId, sourceSessionId,
      message.eventId, role, content, contentHash, Array.from(content).length, message.timestamp, Date.now(),
      message.turnId ?? null, message.itemId ?? null, completeness);
    if (result.changes) {
      const sequence = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO conversation_messages_fts(rowid,content) VALUES (?,?)").run(sequence, content);
      this.db.prepare("INSERT INTO conversation_messages_fts_trigram(rowid,content) VALUES (?,?)").run(sequence, content);
      this.db.prepare("UPDATE conversation_summaries SET stale=1 WHERE session_id=?").run(message.sessionId);
    }
    return { messageId, duplicate: result.changes === 0 };
  }

  recordGap(gapId: string, sourceInstance: string, firstEventId: string | undefined, lastEventId: string | undefined,
    droppedCount: number, reason: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO conversation_collection_gaps
      (gap_id,source_instance,first_event_id,last_event_id,dropped_count,reason,reported_at) VALUES (?,?,?,?,?,?,?)`)
      .run(gapId, sourceInstance, firstEventId ?? null, lastEventId ?? null, droppedCount, reason, Date.now());
  }

  search(input: ConversationSearchInput): Record<string, unknown> {
    const query = input.query.trim();
    if (!query) throw new Error("query_required");
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const before = decodeCursor(input.cursor);
    const where: string[] = ["1=1"];
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
    if (input.since !== undefined) { where.push("m.occurred_at>=?"); params.push(input.since); }
    if (input.until !== undefined) { where.push("m.occurred_at<=?"); params.push(input.until); }
    if (input.agents?.length) {
      where.push(`s.agent_type IN (${input.agents.map(() => "?").join(",")})`); params.push(...input.agents);
    }
    if (before !== undefined) { where.push("m.sequence<?"); params.push(before); }

    const hasCjk = /\p{Script=Han}/u.test(query);
    const cjkChars = (query.match(/\p{Script=Han}/gu) ?? []).length;
    let rows: Array<Record<string, unknown>>;
    if (hasCjk && cjkChars < 3) {
      rows = this.db.prepare(`SELECT m.*,s.title,s.project_name,s.project_path,s.project_identity,s.agent_type,
        substr(COALESCE(m.content,''),1,360) AS snippet
        FROM conversation_messages m JOIN sessions s ON s.id=m.session_id
        WHERE ${where.join(" AND ")} AND COALESCE(m.content,
          (SELECT content FROM conversation_messages_fts WHERE rowid=m.sequence)) LIKE ? ESCAPE '\\'
        ORDER BY m.sequence DESC LIMIT ?`).all(...params, `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, limit + 1) as Array<Record<string, unknown>>;
    } else {
      const table = hasCjk ? "conversation_messages_fts_trigram" : "conversation_messages_fts";
      const match = hasCjk ? `"${query.replaceAll('"', '""')}"` : ftsQuery(query);
      if (!match) throw new Error("query_has_no_searchable_terms");
      rows = this.db.prepare(`SELECT m.*,s.title,s.project_name,s.project_path,s.project_identity,s.agent_type,
        snippet(${table},0,'[',']','…',32) AS snippet
        FROM ${table} f JOIN conversation_messages m ON m.sequence=f.rowid JOIN sessions s ON s.id=m.session_id
        WHERE ${table} MATCH ? AND ${where.join(" AND ")}
        ORDER BY m.sequence DESC LIMIT ?`).all(match, ...params, limit + 1) as Array<Record<string, unknown>>;
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const results = rows.map((row) => ({
      sessionId: String(row.session_id), title: row.title ? String(row.title) : null,
      project: { name: String(row.project_name), path: String(row.project_path),
        identity: row.project_identity ? String(row.project_identity) : null },
      agent: String(row.agent_type), messageId: String(row.message_id), role: String(row.role),
      occurredAt: Number(row.occurred_at), snippet: String(row.snippet ?? ""),
      source: { instance: String(row.source_instance), sessionId: String(row.source_session_id),
        eventId: String(row.source_event_id) },
      collectedThrough: Number(row.collected_at), summaryThrough: this.summaryThrough(String(row.session_id)),
      completeness: String(row.completeness), storage: String(row.storage_state),
    }));
    return { query, resolvedScope: resolution, searchCoverage: "all indexed original messages",
      results, nextCursor: hasMore && rows.length ? encodeCursor(Number(rows.at(-1)!.sequence)) : null };
  }

  read(input: { sessionId: string; messageId?: string; cursor?: string; direction?: "before" | "after";
    limit?: number; messageOffset?: number; maxChars?: number }): Record<string, unknown> {
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    let anchor: number | undefined = decodeCursor(input.cursor);
    if (input.messageId) {
      const row = this.db.prepare("SELECT sequence,session_id FROM conversation_messages WHERE message_id=?")
        .get(input.messageId) as { sequence: number; session_id: string } | undefined;
      if (!row || row.session_id !== input.sessionId) throw new Error("message_not_found");
      anchor = Number(row.sequence);
    }
    const direction = input.direction ?? "after";
    const compare = anchor === undefined ? "" : direction === "after" ? "AND sequence>=?" : "AND sequence<=?";
    const ordering = direction === "after" ? "ASC" : "DESC";
    const rows = this.db.prepare(`SELECT * FROM conversation_messages WHERE session_id=? ${compare}
      ORDER BY sequence ${ordering} LIMIT ?`).all(input.sessionId, ...(anchor === undefined ? [] : [anchor]), limit + 1) as unknown as MessageRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    if (direction === "before") rows.reverse();
    const messages = rows.map((row) => this.shapeMessage(row,
      input.messageId && row.message_id === input.messageId ? input.messageOffset ?? 0 : 0,
      input.maxChars ?? 12_000));
    const first = rows.at(0), last = rows.at(-1);
    const gap = this.sessionGap(input.sessionId);
    return { sessionId: input.sessionId, messages,
      previousCursor: first ? encodeCursor(first.sequence) : null,
      nextCursor: hasMore && last ? encodeCursor(last.sequence) : null,
      collectedThrough: rows.length ? Math.max(...rows.map((row) => row.collected_at)) : null,
      summaryThrough: this.summaryThrough(input.sessionId),
      completeness: gap.length ? { status: "incomplete", gaps: gap } : { status: "complete" } };
  }

  review(sessionId: string, focus?: string, outputBudget = 4_000): Record<string, unknown> {
    const session = this.db.prepare(`SELECT id,title,project_name,project_path,project_identity,agent_type,source,
      history_completeness FROM sessions WHERE id=?`).get(sessionId) as Record<string, unknown> | undefined;
    if (!session) throw new Error("session_not_found");
    const latest = this.db.prepare("SELECT MAX(sequence) AS n,MAX(collected_at) AS collected FROM conversation_messages WHERE session_id=?")
      .get(sessionId) as { n: number | null; collected: number | null };
    let summary = this.db.prepare("SELECT * FROM conversation_summaries WHERE session_id=?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!summary || Number(summary.stale) || Number(summary.through_sequence) !== Number(latest.n ?? 0)) {
      summary = this.rebuildSummary(sessionId, Number(latest.n ?? 0));
    }
    const recent = this.db.prepare("SELECT * FROM conversation_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 12")
      .all(sessionId) as unknown as MessageRow[];
    recent.reverse();
    const summaryBody = summary ? JSON.parse(String(summary.summary_json)) as Record<string, unknown> : null;
    const boundedRecent: unknown[] = [];
    let used = JSON.stringify(summaryBody).length;
    for (const row of recent) {
      const item = this.shapeMessage(row);
      const size = JSON.stringify(item).length;
      if (used + size > Math.max(1_000, outputBudget)) break;
      boundedRecent.push(item); used += size;
    }
    return { sessionId, focus: focus ?? null, session: {
      title: session.title ?? null, projectName: session.project_name, projectPath: session.project_path,
      repository: session.project_identity ?? null, agent: session.agent_type, source: session.source,
    }, summary: summaryBody, summaryStatus: summary ? (Number(summary.stale) ? "stale" : "ready") : "unavailable",
      summaryThrough: summary ? Number(summary.through_sequence) : null, collectedThrough: latest.collected,
      recentMessages: boundedRecent, originalPointers: boundedRecent.map((item) => (item as { messageId: string }).messageId),
      completeness: { source: session.history_completeness, collectionGaps: this.sessionGap(sessionId) } };
  }

  archiveEligible(before: number, maxChunkBytes = 1_048_576, onlySessionId?: string): { chunks: number; messages: number;
    hotBytes: number; compressedBytes: number } {
    mkdirSync(this.objectDir, { recursive: true });
    const sessions = this.db.prepare(`SELECT DISTINCT session_id FROM conversation_messages
      WHERE storage_state='hot' AND occurred_at<? ${onlySessionId ? "AND session_id=?" : ""} ORDER BY session_id`)
      .all(before, ...(onlySessionId ? [onlySessionId] : [])) as Array<{ session_id: string }>;
    let chunks = 0, messages = 0, hotBytes = 0, compressedBytes = 0;
    for (const { session_id: sessionId } of sessions) {
      const candidates = this.db.prepare(`SELECT * FROM conversation_messages
        WHERE session_id=? AND storage_state='hot' AND occurred_at<? ORDER BY sequence`)
        .all(sessionId, before) as unknown as MessageRow[];
      let batch: MessageRow[] = [], size = 0;
      const flush = () => {
        if (!batch.length) return;
        const records = batch.map((row) => ({ messageId: row.message_id, sequence: row.sequence,
          content: row.content ?? "" } satisfies ArchivedMessage));
        const plain = Buffer.from(records.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
        const compressed = gzipSync(plain, { level: 9 });
        const id = `arc_${randomUUID()}`;
        const relative = `${sessionId.replaceAll(/[^A-Za-z0-9_.-]/g, "_")}/${id}.jsonl.gz`;
        const finalPath = join(this.objectDir, relative), tempPath = `${finalPath}.tmp`;
        mkdirSync(dirname(finalPath), { recursive: true });
        writeFileSync(tempPath, compressed, { mode: 0o600 });
        const verified = readFileSync(tempPath);
        if (sha256(verified) !== sha256(compressed) || !gunzipSync(verified).equals(plain)) {
          unlinkSync(tempPath); throw new Error("archive_verification_failed");
        }
        renameSync(tempPath, finalPath);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare(`INSERT INTO conversation_archive_chunks
            (id,session_id,relative_path,first_sequence,last_sequence,message_count,uncompressed_bytes,
             compressed_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(id, sessionId, relative, batch[0]!.sequence, batch.at(-1)!.sequence, batch.length,
              plain.length, compressed.length, sha256(compressed), Date.now());
          const ids = batch.map(() => "?").join(",");
          this.db.prepare(`UPDATE conversation_messages SET content=NULL,storage_state='cold',archive_chunk_id=?
            WHERE sequence IN (${ids})`).run(id, ...batch.map((row) => row.sequence));
          this.db.prepare("INSERT INTO conversation_cleanup_audit(action,detail_json,created_at) VALUES ('archive',?,?)")
            .run(JSON.stringify({ chunkId: id, sessionId, messages: batch.length, uncompressedBytes: plain.length,
              compressedBytes: compressed.length }), Date.now());
          this.db.exec("COMMIT");
        } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
        chunks++; messages += batch.length; hotBytes += plain.length; compressedBytes += compressed.length;
        batch = []; size = 0;
      };
      for (const row of candidates) {
        const rowSize = Buffer.byteLength(row.content ?? "", "utf8") + 256;
        if (batch.length && size + rowSize > maxChunkBytes) flush();
        batch.push(row); size += rowSize;
      }
      flush();
    }
    return { chunks, messages, hotBytes, compressedBytes };
  }

  audit(): Record<string, unknown> {
    const tables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')
      AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(name) || name.startsWith("conversation_messages_fts_")) continue;
      try { counts[name] = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n); }
      catch { /* virtual-table internals and views can be unreadable as row stores */ }
    }
    const page = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const messages = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN storage_state='hot' THEN 1 ELSE 0 END) AS hot,
      SUM(CASE WHEN storage_state='cold' THEN 1 ELSE 0 END) AS cold,
      COALESCE(SUM(content_chars),0) AS chars,MIN(occurred_at) AS oldest,MAX(occurred_at) AS newest
      FROM conversation_messages`).get() as Record<string, unknown>;
    const chunks = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(uncompressed_bytes),0) AS raw,
      COALESCE(SUM(compressed_bytes),0) AS compressed FROM conversation_archive_chunks`).get();
    const databaseFile = (this.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>)
      .find((item) => item.name === "main")?.file;
    const walFile = databaseFile ? `${databaseFile}-wal` : undefined;
    return { generatedAt: Date.now(), databaseFile,
      sqliteBytes: databaseFile && existsSync(databaseFile) ? statSync(databaseFile).size
        : Number(page.page_count) * Number(pageSize.page_size),
      walBytes: walFile && existsSync(walFile) ? statSync(walFile).size : 0,
      objectDir: this.objectDir, tables: counts, messages, archive: chunks,
      cleanupPreview: { expirableOperationalEvents: Number((this.db.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE event_schema=2 AND type NOT IN ('message.completed','command.completed')"
      ).get() as { n: number }).n), bodyPolicy: "archive; never silently delete" } };
  }

  archiveObjectPaths(sessionId: string): string[] {
    return (this.db.prepare("SELECT relative_path FROM conversation_archive_chunks WHERE session_id=?")
      .all(sessionId) as Array<{ relative_path: string }>).map((row) => join(this.objectDir, row.relative_path));
  }

  private capacityBytes(): number {
    const page = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const archive = this.db.prepare("SELECT COALESCE(SUM(compressed_bytes),0) AS n FROM conversation_archive_chunks")
      .get() as { n: number };
    return Number(page.page_count) * Number(pageSize.page_size) + Number(archive.n);
  }

  private reserveCapacity(contentBytes: number): boolean {
    const maximum = this.limits.maxCapacityBytes ?? Number.MAX_SAFE_INTEGER;
    if (maximum === Number.MAX_SAFE_INTEGER) return true;
    if (this.capacityEstimate === undefined || this.writesSinceCapacityCheck >= 100) {
      this.capacityEstimate = this.capacityBytes();
      this.writesSinceCapacityCheck = 0;
    }
    // Body + word FTS + trigram FTS can transiently use several copies. A
    // conservative reservation prevents bursts from racing past the hard cap.
    const reservation = contentBytes * 5;
    if (this.capacityEstimate + reservation > maximum) return false;
    this.capacityEstimate += reservation;
    this.writesSinceCapacityCheck++;
    return true;
  }

  removeOrphanedArchiveObjects(paths: string[], sessionId: string): void {
    const failures: Array<{ path: string; error: string }> = [];
    for (const path of paths) {
      try { if (existsSync(path)) unlinkSync(path); }
      catch (error) { failures.push({ path, error: error instanceof Error ? error.message : String(error) }); }
    }
    this.db.prepare("INSERT INTO conversation_cleanup_audit(action,detail_json,created_at) VALUES ('session-delete',?,?)")
      .run(JSON.stringify({ sessionId, objects: paths.length, failures }), Date.now());
  }

  private shapeMessage(row: MessageRow, messageOffset = 0, maxChars = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
    const content = this.loadContent(row);
    const points = Array.from(content);
    const boundedOffset = Math.min(points.length, Math.max(0, messageOffset));
    const segment = points.slice(boundedOffset, boundedOffset + Math.max(1, maxChars)).join("");
    const nextOffset = boundedOffset + Array.from(segment).length;
    return { messageId: row.message_id, role: row.role, content: segment, occurredAt: row.occurred_at,
      sourcePosition: { sequence: row.sequence, turnId: row.turn_id, itemId: row.item_id,
        messageOffset: boundedOffset }, storage: row.storage_state, completeness: row.completeness,
      contentTruncated: boundedOffset > 0 || nextOffset < points.length,
      originalContentChars: points.length, nextMessageOffset: nextOffset < points.length ? nextOffset : null };
  }

  private loadContent(row: MessageRow): string {
    if (row.content !== null) return row.content;
    if (row.storage_state !== "cold" || !row.archive_chunk_id) throw new Error("message_content_unavailable");
    const chunk = this.db.prepare("SELECT relative_path,sha256 FROM conversation_archive_chunks WHERE id=?")
      .get(row.archive_chunk_id) as { relative_path: string; sha256: string } | undefined;
    if (!chunk) throw new Error("archive_pointer_expired");
    const path = join(this.objectDir, chunk.relative_path);
    if (!existsSync(path)) throw new Error("archive_object_missing");
    const bytes = readFileSync(path);
    if (sha256(bytes) !== chunk.sha256) throw new Error("archive_checksum_mismatch");
    for (const line of gunzipSync(bytes).toString("utf8").trimEnd().split("\n")) {
      const item = JSON.parse(line) as ArchivedMessage;
      if (item.messageId === row.message_id) {
        if (sha256(item.content) !== (this.db.prepare("SELECT content_sha256 FROM conversation_messages WHERE sequence=?")
          .get(row.sequence) as { content_sha256: string }).content_sha256) throw new Error("archive_content_mismatch");
        return item.content;
      }
    }
    throw new Error("archive_message_missing");
  }

  private rebuildSummary(sessionId: string, through: number): Record<string, unknown> | undefined {
    const rows = this.db.prepare(`SELECT * FROM conversation_messages WHERE session_id=? AND role IN ('user','assistant')
      ORDER BY sequence`).all(sessionId) as unknown as MessageRow[];
    if (!rows.length) return undefined;
    const user = rows.filter((row) => row.role === "user");
    const assistant = rows.filter((row) => row.role === "assistant");
    const select = (source: MessageRow[], pattern: RegExp, limit: number) => source.flatMap((row) =>
      textSentences(this.loadContent(row)).filter((sentence) => pattern.test(sentence)).map((text) => ({
        text, messageId: row.message_id,
      }))).slice(0, limit);
    const body = {
      goal: user.length ? { text: textSentences(this.loadContent(user[0]!))[0] ?? this.loadContent(user[0]!),
        messageId: user[0]!.message_id } : null,
      constraints: select(user, /必须|不要|不能|不作为|不依赖|约束|only|must|do not|without/i, 12),
      confirmedDecisions: select(user, /决定|确认|采用|提供|不持有|不作为|纳入|必须|MCP|projectId|Obsidian|容量/i, 16),
      assistantSuggestions: select(assistant, /建议|可以|应该|方案|recommend|could|should/i, 12),
      openQuestions: [...select(user, /[？?]|未决|待确认|是否/u, 8), ...select(assistant, /[？?]|未决|待确认/u, 4)],
      note: "Extractive navigation only. Verify decisions against the pointed original messages and current repository state.",
    };
    const version = sha256(rows.map((row) => `${row.message_id}:${row.sequence}`).join("\n"));
    this.db.prepare(`INSERT INTO conversation_summaries
      (session_id,through_sequence,source_version,generator_version,summary_json,generated_at,stale)
      VALUES (?,?,?,?,?,?,0) ON CONFLICT(session_id) DO UPDATE SET through_sequence=excluded.through_sequence,
      source_version=excluded.source_version,generator_version=excluded.generator_version,
      summary_json=excluded.summary_json,generated_at=excluded.generated_at,stale=0`)
      .run(sessionId, through, version, "extractive-v1", JSON.stringify(body), Date.now());
    return this.db.prepare("SELECT * FROM conversation_summaries WHERE session_id=?").get(sessionId) as Record<string, unknown>;
  }

  private summaryThrough(sessionId: string): number | null {
    const row = this.db.prepare("SELECT through_sequence FROM conversation_summaries WHERE session_id=? AND stale=0")
      .get(sessionId) as { through_sequence: number } | undefined;
    return row ? Number(row.through_sequence) : null;
  }

  private sessionGap(sessionId: string): unknown[] {
    const source = this.db.prepare("SELECT DISTINCT source_instance FROM conversation_messages WHERE session_id=?")
      .all(sessionId) as Array<{ source_instance: string }>;
    if (!source.length) return [];
    const placeholders = source.map(() => "?").join(",");
    return this.db.prepare(`SELECT first_event_id AS firstEventId,last_event_id AS lastEventId,
      dropped_count AS droppedCount,reason,reported_at AS reportedAt FROM conversation_collection_gaps
      WHERE source_instance IN (${placeholders}) ORDER BY reported_at`)
      .all(...source.map((item) => item.source_instance));
  }
}
