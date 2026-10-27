import type { SessionEvent } from "./api/types";

export const TOOL_TYPES = new Set(["tool.started", "tool.completed", "command.completed", "file_change.completed", "task.started", "task.progress", "task.completed"]);

/** Each tool call once, where it started, showing its latest event (a call's events share an itemId). */
export function transcriptRows(events: SessionEvent[]) {
  const identity = (e: SessionEvent) => JSON.stringify([e.turnId, e.itemId]);
  const latest = new Map<string, SessionEvent>();
  for (const e of events) if (TOOL_TYPES.has(e.type) && e.itemId) latest.set(identity(e), e);
  const shown = new Set<string>();
  return events.flatMap(e => {
    if (!TOOL_TYPES.has(e.type) || !e.itemId) return [{ key: e.eventId, event: e }];
    if (shown.has(identity(e))) return [];
    shown.add(identity(e));
    return [{ key: e.eventId, event: latest.get(identity(e))! }];
  });
}

export type TranscriptRow = ReturnType<typeof transcriptRows>[number];
export interface TranscriptTurn {
  key: string; turnId: string | null; rows: TranscriptRow[];
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  durationMs?: number; partial: boolean;
}
const TERMINALS = new Set(['turn.completed', 'turn.failed', 'turn.interrupted']);
/** Keep chronological boundaries, including steered prompts and incomplete pages. */
export function transcriptTurns(events: SessionEvent[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const row of transcriptRows(events)) {
    const e = row.event;
    let turn = turns.at(-1);
    if (!turn || turn.turnId !== e.turnId || (e.type === 'message.completed' && e.payload.role === 'user' && turn.rows.some(r => r.event.type === 'message.completed' || TOOL_TYPES.has(r.event.type)))) {
      turn = { key: row.key, turnId: e.turnId, rows: [], status: 'unknown', partial: true };
      turns.push(turn);
    }
    turn.rows.push(row);
    if (e.type === 'turn.started') { turn.status = 'running'; turn.partial = false; }
    if (TERMINALS.has(e.type)) {
      turn.status = e.type.slice(5) as TranscriptTurn['status'];
      const start = turn.rows.find(r => r.event.type === 'turn.started')?.event;
      const duration = typeof e.payload.durationMs === 'number' ? e.payload.durationMs : start ? e.timestamp - start.timestamp : undefined;
      if (duration !== undefined && Number.isFinite(duration) && duration >= 0) turn.durationMs = duration;
    }
  }
  return turns;
}

export function turnPresentation(turn: TranscriptTurn) {
  const visible = turn.rows.filter(r => r.event.type === 'message.completed' || TOOL_TYPES.has(r.event.type)
    || ['progress', 'approval.requested', 'approval.resolved', 'user_input.requested', 'user_input.resolved', 'error'].includes(r.event.type));
  const last = visible.findLast(r => r.event.type === 'message.completed' && r.event.payload.role === 'assistant');
  // Only a genuinely final reply goes outside the process; later tool calls keep earlier commentary in place.
  const final = last === visible.at(-1) ? last : undefined;
  return { prompts: visible.filter(r => r.event.type === 'message.completed' && r.event.payload.role === 'user'),
    process: visible.filter(r => r !== final && !(r.event.type === 'message.completed' && r.event.payload.role === 'user')), final };
}
