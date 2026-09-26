import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { isPathWithinRoots } from "./path-utils.js";
import pino from "pino";
import type { BridgeToControlMessage } from "@agent-bridge/protocol";

const log = pino({ name: "codex-desktop-sessions" });
const MAX_SCAN_FILES = 500;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_INDEX_BYTES = 8 * 1024 * 1024;
const FIRST_LINE_BYTES = 64 * 1024;
const MAX_PARTIAL_LINE_CHARS = 1024 * 1024;
const MAX_EVENT_TEXT = 64 * 1024;
// While a Desktop turn runs, re-read only the active rollouts at this pace so
// tool events reach Control Plane while the turn is still in progress. The
// full directory walk keeps its configured interval.
const ACTIVE_SCAN_INTERVAL_MS = 750;

interface DesktopSessionMetadata {
  threadId: string;
  cwd: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
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
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export class CodexDesktopSessionScanner {
  private readonly files = new Map<string, FileState>();
  private readonly reportedEvents = new Set<string>();
  private timer?: NodeJS.Timeout;
  private currentScan?: Promise<void>;
  private stopped = true;
  private lastFullScanAt = 0;

  constructor(private readonly options: {
    codexHome: string;
    allowedRoots: string[];
    intervalMs: number;
    replayExisting: boolean;
    emit: (message: BridgeToControlMessage) => void;
    /** True when the Bridge's own App Server is running this turn, so its notifications already report it. */
    isBridgeTurn?: (threadId: string, turnId: string | undefined) => boolean;
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

  hasActiveThreads(): boolean {
    return [...this.files.values()].some((file) => Boolean(file.activeTurnId));
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
    const delay = this.hasActiveThreads()
      ? Math.min(ACTIVE_SCAN_INTERVAL_MS, this.options.intervalMs)
      : this.options.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const activeOnly = Date.now() - this.lastFullScanAt < this.options.intervalMs;
      void this.scan(false, activeOnly).catch((error) => log.warn({ error }, "Unable to scan Codex Desktop sessions"))
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private scan(initial: boolean, activeOnly = false): Promise<void> {
    if (this.currentScan) return this.currentScan;
    const attempt = this.scanInternal(initial, activeOnly).finally(() => {
      if (this.currentScan === attempt) this.currentScan = undefined;
    });
    this.currentScan = attempt;
    return attempt;
  }

  private async scanInternal(initial: boolean, activeOnly: boolean): Promise<void> {
    if (activeOnly) {
      for (const state of [...this.files.values()].filter((file) => file.activeTurnId)) {
        try {
          this.scanFile(state.path, false);
        } catch (error) {
          log.warn({ error, path: state.path }, "Unable to inspect Codex Desktop rollout");
        }
      }
      return;
    }
    this.lastFullScanAt = Date.now();
    const sessionsRoot = join(this.options.codexHome, "sessions");
    const indexedTitles = readDesktopSessionTitles(this.options.codexHome);
    const paths = listRecentRollouts(sessionsRoot);
    for (const path of paths) {
      try {
        this.scanFile(path, initial);
        const state = this.files.get(path);
        const indexedTitle = state && indexedTitles.get(state.threadId);
        if (state && indexedTitle && indexedTitle !== state.title) {
          state.title = indexedTitle;
          this.emitDiscovery(state, state.activeTurnId ? "working" : "waiting");
        }
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
      const timestamp = rolloutTimestamp(entry);
      if (timestamp !== undefined) state.updatedAt = Math.max(state.updatedAt, timestamp);
      if (entry.type === "session_meta" && payload.id === state.threadId && typeof payload.title === "string") {
        if (payload.title !== state.title) {
          state.title = payload.title;
          if (!baselineOnly) this.emitDiscovery(state, state.activeTurnId ? "working" : "waiting");
        }
        continue;
      }
      if (entry.type === "event_msg" && payload.type === "task_started" && typeof payload.turn_id === "string") {
        state.activeTurnId = payload.turn_id;
        state.lastAssistantText = undefined;
        if (baselineOnly || this.isBridgeTurn(state, payload.turn_id)) continue;
        // Use the same event id as the App Server's turn/started so the two
        // sources collapse into one row in Control Plane.
        this.emitDiscovery(state, "working");
        this.options.emit({
          type: "session.event",
          eventId: `app-server:${state.threadId}:${payload.turn_id}:started`,
          eventType: "turn.started",
          sessionId: state.threadId,
          turnId: payload.turn_id,
          timestamp: timestamp ?? codexSeconds(payload.started_at) ?? Date.now(),
          payload: { status: "in_progress" },
        });
        continue;
      }
      if (entry.type === "event_msg" && payload.type === "item_completed") {
        if (!baselineOnly) this.emitCompletedItem(state, payload, timestamp);
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
      if (baselineOnly || this.isBridgeTurn(state, turnId)) continue;
      this.emitDiscovery(state, terminalType === "agent.completed" ? "completed" : "stopped");
      this.options.emit({
        type: terminalType,
        eventId,
        sessionId: state.threadId,
        timestamp: timestamp ?? Date.now(),
        summary: terminalType === "agent.completed" ? state.lastAssistantText : undefined,
      });
      this.options.emit({
        type: "session.event",
        eventId: `${eventId}:structured`,
        eventType: terminalType === "agent.completed" ? "turn.completed" : "turn.interrupted",
        sessionId: state.threadId,
        turnId,
        timestamp: timestamp ?? Date.now(),
        payload: {
          status: terminalType === "agent.completed" ? "completed" : "interrupted",
          summary: terminalType === "agent.completed" ? state.lastAssistantText : undefined,
          historyCompleteness: "terminal-only",
        },
      });
    }
  }

  private isBridgeTurn(state: FileState, turnId: string | undefined): boolean {
    return Boolean(this.options.isBridgeTurn?.(state.threadId, turnId));
  }

  /**
   * Forward one finished rollout item while its turn is still running.
   *
   * The rollout carries no item_started records and no streamed command
   * output, so a long command appears only once it exits, stamped with its
   * real completion time. The rollout is an internal Codex format that can
   * change between releases: anything unrecognized is skipped, and the App
   * Server read after the turn still backfills it. Event ids match the App
   * Server's (rollout item ids equal thread/read item ids), so that later
   * backfill is dropped as a duplicate instead of re-timestamping the item.
   */
  private emitCompletedItem(state: FileState, payload: Record<string, unknown>, entryTimestamp: number | undefined): void {
    const item = payload.item && typeof payload.item === "object" ? payload.item as Record<string, unknown> : undefined;
    const itemId = typeof item?.id === "string" && item.id ? item.id : undefined;
    if (!item || !itemId) return;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : state.activeTurnId;
    if (this.isBridgeTurn(state, turnId)) return;
    const timestamp = finiteNumber(payload.completed_at_ms) ?? entryTimestamp ?? Date.now();
    const threadId = state.threadId;
    const emit = (eventType: "message.completed" | "command.completed" | "file_change.completed",
      suffix: string, eventPayload: Record<string, unknown>) => this.options.emit({
      type: "session.event", eventId: `app-server:${threadId}:${itemId}:${suffix}`, eventType,
      sessionId: threadId, turnId, itemId, timestamp, payload: eventPayload,
    });
    if (item.type === "AgentMessage" || item.type === "UserMessage") {
      const text = contentText(item.content);
      if (!text) return;
      emit("message.completed", "message",
        { role: item.type === "UserMessage" ? "user" : "assistant", text: truncateEventText(text) });
    } else if (item.type === "CommandExecution") {
      const exitCode = finiteNumber(item.exit_code) ?? null;
      const output = [item.aggregated_output, item.formatted_output, item.stdout]
        .find((value): value is string => typeof value === "string") ?? "";
      emit("command.completed", "command", {
        command: commandText(item.command), cwd: rolloutPath(item.cwd),
        status: typeof item.status === "string" ? item.status : "unknown", exitCode,
        output: truncateEventText(output),
      });
    } else if (item.type === "FileChange") {
      const changes = fileChanges(item.changes);
      const summary = `${changes.length} file change${changes.length === 1 ? "" : "s"} applied`;
      emit("file_change.completed", "file-change",
        { changes: changes.slice(0, 200), summary, truncated: changes.length > 200 });
    }
  }

  private emitDiscovery(state: FileState, status: "working" | "waiting" | "completed" | "stopped"): void {
    this.options.emit({
      type: "session.discovered",
      sessionId: state.threadId,
      nativeSessionId: state.threadId,
      agentType: "codex-desktop",
      projectPath: state.cwd,
      projectName: basename(state.cwd.replace(/[\\/]$/, "")) || state.cwd,
      title: state.title,
      status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }
}

function readDesktopSessionTitles(codexHome: string): Map<string, string> {
  const titles = new Map<string, string>();
  const path = join(codexHome, "session_index.jsonl");
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return titles;
  }
  const start = Math.max(0, size - MAX_SESSION_INDEX_BYTES);
  const chunk = readRange(path, start, size);
  const text = start > 0 ? chunk.slice(Math.max(0, chunk.indexOf("\n") + 1)) : chunk;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id : undefined;
      const title = typeof entry.thread_name === "string" ? entry.thread_name.trim() : "";
      if (id && title) titles.set(id, title);
    } catch {
      // Ignore a concurrently written or malformed index entry.
    }
  }
  return titles;
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
    createdAt: rolloutTimestamp(entry) ?? Math.floor(statSync(path).birthtimeMs || statSync(path).mtimeMs),
    updatedAt: rolloutTimestamp(entry) ?? Math.floor(statSync(path).mtimeMs),
  };
}

function rolloutTimestamp(entry: RolloutEntry): number | undefined {
  if (typeof entry.timestamp !== "string") return undefined;
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
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
  return isPathWithinRoots(path, roots);
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function codexSeconds(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function truncateEventText(text: string): string {
  return text.length <= MAX_EVENT_TEXT ? text : `${text.slice(0, MAX_EVENT_TEXT)}\n…[truncated]`;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => part && typeof part === "object"
    && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, string>).text] : [])
    .join("\n").trim();
  return text || undefined;
}

/** The rollout stores argv; App Server shows one shell-quoted line. */
function commandText(command: unknown): string {
  if (typeof command === "string") return command || "command";
  if (!Array.isArray(command) || !command.length) return "command";
  return command.map((arg) => {
    const value = String(arg);
    return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  }).join(" ");
}

/** The rollout stores cwd as a file URL; App Server reports a plain path. */
function rolloutPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!value.startsWith("file://")) return normalizeDesktopPath(value);
  let path: string;
  try {
    path = decodeURIComponent(value.slice("file://".length));
  } catch {
    return undefined;
  }
  // file:///C:/Users/... carries a leading slash before the drive letter.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return normalizeDesktopPath(path);
}

/** Convert the rollout's `{ path: change }` map into App Server's change list. */
function fileChanges(changes: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(changes)) return changes.filter((change) => change && typeof change === "object");
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes as Record<string, unknown>).map(([path, raw]) => {
    const change = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const movePath = typeof change.move_path === "string" ? change.move_path : undefined;
    const diff = [change.unified_diff, change.content].find((value): value is string => typeof value === "string") ?? "";
    return {
      path,
      kind: { type: typeof change.type === "string" ? change.type : "update", ...(movePath ? { move_path: movePath } : {}) },
      diff,
    };
  });
}
