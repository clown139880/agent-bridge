import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArchiveGapMessage, BridgeToControlMessage } from "@agent-bridge/protocol";

export type ArchiveEvent = Extract<BridgeToControlMessage, { type: "session.event" }>;

type Record =
  | { add: ArchiveEvent }
  | { ack: string }
  | { gap: ArchiveGapMessage | null }
  /** The pre-journal snapshot format; still read so an upgrade keeps unacked events. */
  | { messages?: ArchiveEvent[]; gap?: ArchiveGapMessage };

/**
 * Session events awaiting a control-plane ack, persisted as an append-only journal.
 * Each mutation appends one short line, so disk writes stay proportional to the
 * events produced. The file is rewritten from memory only when acked lines
 * outnumber live entries, which keeps it bounded by the outbox size.
 */
export class ArchiveOutbox {
  readonly messages = new Map<string, ArchiveEvent>();
  gap?: ArchiveGapMessage;
  private lines = 0;

  constructor(private readonly path: string, private readonly limit: number, private readonly machineId: string,
    private readonly onError: (error: unknown) => void) {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { /* first boot */ }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { this.replay(JSON.parse(line) as Record); } catch { /* torn final line after a crash */ }
    }
    if (text) this.compact();
  }

  /** Returns the event ids dropped to stay within capacity. */
  add(message: ArchiveEvent): string[] {
    if (this.messages.has(message.eventId)) return [];
    this.messages.set(message.eventId, message);
    this.append({ add: message });
    const dropped: string[] = [];
    while (this.messages.size > this.limit) {
      const oldest = this.messages.keys().next().value as string;
      this.messages.delete(oldest);
      dropped.push(oldest);
      if (!this.gap) this.gap = { type: "archive.gap", gapId: `gap:${this.machineId}:${Date.now()}`,
        firstEventId: oldest, lastEventId: oldest, droppedCount: 1, reason: "outbox-capacity", reportedAt: Date.now() };
      else { this.gap.lastEventId = oldest; this.gap.droppedCount++; }
    }
    if (dropped.length) this.append({ gap: this.gap! });
    return dropped;
  }

  ack(eventId: string): void {
    if (this.messages.delete(eventId)) this.append({ ack: eventId });
  }

  ackGap(gapId: string): void {
    if (this.gap?.gapId !== gapId) return;
    this.gap = undefined;
    this.append({ gap: null });
  }

  private replay(record: Record): void {
    if ("add" in record) { if (record.add?.type === "session.event" && record.add.eventId) this.messages.set(record.add.eventId, record.add); }
    else if ("ack" in record) this.messages.delete(record.ack);
    else if ("messages" in record) {
      for (const message of record.messages ?? []) if (message?.type === "session.event" && message.eventId) this.messages.set(message.eventId, message);
      if (record.gap?.type === "archive.gap") this.gap = record.gap;
    } else if ("gap" in record) this.gap = record.gap?.type === "archive.gap" ? record.gap : undefined;
    // Capacity drops are not journaled; replay trims the oldest entries exactly as the live outbox did.
    while (this.messages.size > this.limit) this.messages.delete(this.messages.keys().next().value as string);
  }

  private append(record: Record): void {
    if (++this.lines > Math.max(1_024, this.messages.size * 2)) { this.compact(); return; }
    try {
      if (this.lines === 1) mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) { this.onError(error); }
  }

  private compact(): void {
    const records: Record[] = [...this.messages.values()].map((message) => ({ add: message }));
    if (this.gap) records.push({ gap: this.gap });
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
      renameSync(temp, this.path);
      this.lines = records.length;
    } catch (error) { this.onError(error); }
  }
}
