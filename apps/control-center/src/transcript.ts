import type { SessionEvent } from "./api/types";

export const TOOL_TYPES = new Set(["tool.started", "tool.completed", "command.completed", "file_change.completed", "task.started", "task.progress", "task.completed"]);

/** Each tool call once, where it started, showing its latest event (a call's events share an itemId). */
export function transcriptRows(events: SessionEvent[]) {
  const latest = new Map<string, SessionEvent>();
  for (const e of events) if (TOOL_TYPES.has(e.type) && e.itemId) latest.set(e.itemId, e);
  const shown = new Set<string>();
  return events.flatMap(e => {
    if (!TOOL_TYPES.has(e.type) || !e.itemId) return [{ key: e.eventId, event: e }];
    if (shown.has(e.itemId)) return [];
    shown.add(e.itemId);
    return [{ key: e.eventId, event: latest.get(e.itemId)! }];
  });
}
