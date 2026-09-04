import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import pino from "pino";
import type { BridgeToControlMessage } from "@agent-bridge/protocol";

const log = pino({ name: "codex-desktop-sessions" });
const MAX_SCAN_FILES = 500;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const FIRST_LINE_BYTES = 64 * 1024;
const MAX_PARTIAL_LINE_CHARS = 1024 * 1024;

interface DesktopSessionMetadata {
  threadId: string;
  cwd: string;
  title?: string;
}

interface FileState extends DesktopSessionMetadata {
  path: string;
  offset: number;
  modifiedAt: number;
  activeTurnId?: string;
  lastAssistantText?: string;
  carry: string;
}

interface RolloutEntry {
  type?: string;
  payload?: Record<string, unknown>;
}

export class CodexDesktopSessionScanner {
  private readonly files = new Map<string, FileState>();
  private readonly reportedEvents = new Set<string>();
  private timer?: NodeJS.Timeout;
  private currentScan?: Promise<void>;
  private stopped = true;

  constructor(private readonly options: {
    codexHome: string;
    allowedRoots: string[];
    intervalMs: number;
    replayExisting: boolean;
    emit: (message: BridgeToControlMessage) => void;
  }) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.scan(true);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  refresh(): Promise<void> {
    return this.scan(false);
  }

  isThreadActive(threadId: string): boolean {
    return Boolean(this.latestThreadFile(threadId)?.activeTurnId);
  }

  getThreadCwd(threadId: string): string | undefined {
    return this.latestThreadFile(threadId)?.cwd;
  }

  private latestThreadFile(threadId: string): FileState | undefined {
    return [...this.files.values()]
      .filter((file) => file.threadId === threadId)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan(false).catch((error) => log.warn({ error }, "Unable to scan Codex Desktop sessions"))
        .finally(() => this.schedule());
    }, this.options.intervalMs);
    this.timer.unref();
  }

  private scan(initial: boolean): Promise<void> {
    if (this.currentScan) return this.currentScan;
    const attempt = this.scanInternal(initial).finally(() => {
      if (this.currentScan === attempt) this.currentScan = undefined;
    });
    this.currentScan = attempt;
    return attempt;
  }

  private async scanInternal(initial: boolean): Promise<void> {
    const sessionsRoot = join(this.options.codexHome, "sessions");
    const paths = listRecentRollouts(sessionsRoot);
    for (const path of paths) {
      try {
        this.scanFile(path, initial);
      } catch (error) {
        log.warn({ error, path }, "Unable to inspect Codex Desktop rollout");
      }
    }
  }

  private scanFile(path: string, initial: boolean): void {
    const stat = statSync(path);
    if (!stat.isFile()) return;
    let state = this.files.get(path);
    if (!state) {
      const metadata = readDesktopSessionMetadata(path, this.options.allowedRoots);
      if (!metadata) return;
      state = { ...metadata, path, offset: 0, modifiedAt: stat.mtimeMs, carry: "" };
      this.files.set(path, state);
    }

    if (stat.size < state.offset) {
      state.offset = 0;
      state.activeTurnId = undefined;
      state.lastAssistantText = undefined;
      state.carry = "";
    }
    if (stat.size === state.offset) {
      state.modifiedAt = stat.mtimeMs;
      return;
    }

    const originalOffset = state.offset;
    const start = Math.max(state.offset, stat.size - MAX_READ_BYTES);
    const chunk = readRange(path, start, stat.size);
    state.offset = stat.size;
    state.modifiedAt = stat.mtimeMs;
    const newline = chunk.indexOf("\n");
    const text = start > originalOffset && newline >= 0 ? chunk.slice(newline + 1) : chunk;
    const combined = state.carry + text;
    const lines = combined.split("\n");
    const trailing = combined.endsWith("\n") ? "" : (lines.pop() ?? "");
    state.carry = trailing.length <= MAX_PARTIAL_LINE_CHARS ? trailing : "";
    this.processLines(state, lines, initial && !this.options.replayExisting);
  }

  private processLines(state: FileState, lines: string[], baselineOnly: boolean): void {
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: RolloutEntry;
      try {
        entry = JSON.parse(line) as RolloutEntry;
      } catch {
        continue;
      }
      const payload = entry.payload ?? {};
      if (entry.type === "event_msg" && payload.type === "task_started" && typeof payload.turn_id === "string") {
        state.activeTurnId = payload.turn_id;
        state.lastAssistantText = undefined;
        continue;
      }
      const assistantText = extractAssistantText(entry);
      if (assistantText) state.lastAssistantText = assistantText;
      if (entry.type !== "event_msg") continue;
      const eventType = payload.type;
      if (!["task_complete", "turn_aborted"].includes(String(eventType))) continue;
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : state.activeTurnId;
      if (!turnId) continue;
      if (state.activeTurnId === turnId) state.activeTurnId = undefined;
      const terminalType = eventType === "turn_aborted" ? "agent.stopped" : "agent.completed";
      const eventId = `desktop:${state.threadId}:${turnId}:${terminalType}`;
      if (this.reportedEvents.has(eventId)) continue;
      this.reportedEvents.add(eventId);
      if (baselineOnly) continue;
      this.options.emit({
        type: "session.discovered",
        sessionId: state.threadId,
        nativeSessionId: state.threadId,
        agentType: "codex-desktop",
        projectPath: state.cwd,
        projectName: basename(state.cwd.replace(/[\\/]$/, "")) || state.cwd,
        title: state.title,
        status: terminalType === "agent.completed" ? "completed" : "stopped",
        createdAt: Math.floor(state.modifiedAt),
      });
      this.options.emit({
        type: terminalType,
        eventId,
        sessionId: state.threadId,
        timestamp: Date.now(),
        summary: terminalType === "agent.completed" ? state.lastAssistantText : undefined,
      });
    }
  }
}

function listRecentRollouts(root: string): string[] {
  const files: Array<{ path: string; modifiedAt: number }> = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          files.push({ path, modifiedAt: statSync(path).mtimeMs });
        } catch {
          // The Desktop may rotate a rollout while it is being enumerated.
        }
      }
    }
  }
  return files.sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, MAX_SCAN_FILES)
    .map((file) => file.path);
}

function readDesktopSessionMetadata(path: string, allowedRoots: string[]): DesktopSessionMetadata | undefined {
  const firstLine = readRange(path, 0, Math.min(statSync(path).size, FIRST_LINE_BYTES)).split("\n", 1)[0];
  if (!firstLine) return undefined;
  let entry: RolloutEntry;
  try {
    entry = JSON.parse(firstLine) as RolloutEntry;
  } catch {
    return undefined;
  }
  const payload = entry.payload ?? {};
  if (entry.type !== "session_meta" || payload.originator !== "Codex Desktop") return undefined;
  if (typeof payload.id !== "string" || typeof payload.cwd !== "string") return undefined;
  const cwd = normalizeDesktopPath(payload.cwd);
  if (!isAllowedProjectPath(cwd, allowedRoots)) return undefined;
  return {
    threadId: payload.id,
    cwd,
    title: typeof payload.title === "string" ? payload.title : undefined,
  };
}

function normalizeDesktopPath(value: string): string {
  if (process.platform !== "win32") {
    const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
    if (match) return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`;
  }
  return value;
}

function isAllowedProjectPath(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    return false;
  }
  return roots.some((root) => {
    try {
      const base = realpathSync(resolve(root));
      const rel = relative(base, target);
      return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
    } catch {
      return false;
    }
  });
}

function readRange(path: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (length === 0) return "";
  const fd = openSync(path, "r");
  try {
    const actualEnd = Math.min(end, fstatSync(fd).size);
    const buffer = Buffer.alloc(Math.max(0, actualEnd - start));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function extractAssistantText(entry: RolloutEntry): string | undefined {
  const payload = entry.payload ?? {};
  if (entry.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
    return payload.message.trim() || undefined;
  }
  if (entry.type !== "response_item" || payload.type !== "message" || payload.role !== "assistant") return undefined;
  if (!Array.isArray(payload.content)) return undefined;
  const text = payload.content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  }).join("\n").trim();
  return text || undefined;
}
