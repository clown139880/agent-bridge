import { gunzipSync, gzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";

/** Bulky tool bodies are gzip BLOBs; every other body stays JSON text so SQL can inspect it. */
const COMPRESSED_TYPES = new Set(["command.completed", "file_change.completed"]);
const COMPRESS_MIN_BYTES = 1024;

export function encodeEventBody(type: string, payload: unknown): string | Uint8Array {
  const json = JSON.stringify(payload ?? {});
  if (!COMPRESSED_TYPES.has(type) || Buffer.byteLength(json, "utf8") < COMPRESS_MIN_BYTES) return json;
  return gzipSync(json);
}

export function decodeEventBody(body: unknown): Record<string, unknown> {
  try {
    const text = body instanceof Uint8Array ? gunzipSync(body).toString("utf8") : String(body ?? "{}");
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export interface EventRow {
  id: number;
  session_id: string;
  event_id: string;
  worker_run_id: string | null;
  type: string;
  turn_id: string | null;
  item_id: string | null;
  created_at: number;
  body: unknown;
}

export const EVENT_COLUMNS = "id,session_id,event_id,worker_run_id,type,turn_id,item_id,created_at,body";

/** The public session event envelope, assembled from row columns plus the stored body. */
export function eventWire(row: EventRow): Record<string, unknown> {
  return { cursor: `e:${row.id}`, eventId: row.event_id, type: row.type, sessionId: row.session_id,
    runId: row.worker_run_id, turnId: row.turn_id, itemId: row.item_id, timestamp: Number(row.created_at),
    payload: decodeEventBody(row.body) };
}

const SEARCH_TEXT_LIMIT = 4_000;

function bounded(text: string): string {
  const points = Array.from(text);
  return points.length > SEARCH_TEXT_LIMIT ? points.slice(0, SEARCH_TEXT_LIMIT).join("") : text;
}

/** Text worth finding again: conversation text and what a tool acted on, never raw tool output. */
export function searchText(type: string, payload: Record<string, unknown>): string | undefined {
  if (type === "message.completed" && typeof payload.text === "string" && payload.text.trim()) return bounded(payload.text);
  if (type === "turn.completed" && typeof payload.summary === "string" && payload.summary.trim()) return bounded(payload.summary);
  if (type === "command.completed" && typeof payload.command === "string") return bounded(`$ ${payload.command}`);
  if (type === "file_change.completed" && Array.isArray(payload.changes)) {
    const paths = payload.changes.map((change) => change && typeof change === "object"
      ? String((change as Record<string, unknown>).path ?? "") : "").filter(Boolean);
    return paths.length ? bounded(paths.join("\n")) : undefined;
  }
  return undefined;
}

/** Index one stored event. A turn summary that repeats its closing assistant message is not indexed twice. */
export function indexEvent(db: DatabaseSync, row: Pick<EventRow, "id" | "session_id" | "type" | "turn_id">,
  payload: Record<string, unknown>): void {
  const text = searchText(row.type, payload);
  if (!text) return;
  if (row.type === "turn.completed" && row.turn_id && db.prepare(`SELECT 1 FROM events WHERE session_id=? AND turn_id=?
    AND type='message.completed' AND typeof(body)='text' AND json_extract(body,'$.role')='assistant'
    AND json_extract(body,'$.text')=? LIMIT 1`).get(row.session_id, row.turn_id, String(payload.summary))) return;
  db.prepare("INSERT INTO event_search(rowid,text) VALUES (?,?)").run(row.id, text);
}
