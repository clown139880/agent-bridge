/**
 * The event contract every agent adapter keeps, checked end to end: adapter →
 * Control Plane event store → the DSH plugin's projection of a running turn.
 *
 * - every assistant message of a turn is stored (no id collisions, none dropped);
 * - an idle-reaped session revived for its next turn still has its conversation;
 * - a long tool turn is visible while it runs, not only when it ends;
 * - Stop, a restart or a later sync neither repeats nor loses anything.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import type { BridgeToControlMessage, StructuredSessionEventMessage } from "../packages/protocol/src/index.js";
import { PiAdapter } from "../apps/bridge/src/pi/pi-adapter.js";
import { ClaudeCodeAdapter } from "../apps/bridge/src/claude/claude-adapter.js";
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";
import { openStep, projectNativeEvents, TOOL_EVENT_TYPES } from "../integrations/dsh-agent-control/src/agent-bridge-provider/mapping.js";
import type { NativeEvent } from "../integrations/dsh-agent-control/src/agent-bridge-provider/dsh-compat.js";
import type { JsonObject } from "../integrations/dsh-agent-control/src/types.js";

const MOCK_PI = fileURLToPath(new URL("./fixtures/mock-pi.mjs", import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** The Control Plane's event store for one session, fed exactly as the server feeds it. */
function controlPlane(sessionId: string, agentType: string) {
  const dir = mkdtempSync(join(tmpdir(), "event-contract-"));
  const store = new Store(join(dir, "control.sqlite"));
  cleanups.push(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  store.upsertMachine({ id: "hal", name: "hal", platform: "linux", hostname: "hal", capabilities: [] });
  store.createSession({ id: sessionId, machineId: "hal", agentType: agentType as never, projectName: "p", projectPath: "/work",
    matrixRoomId: "", matrixThreadId: null, nativeSessionId: null as never, status: "completed", createdAt: 1, updatedAt: 1 });
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  const conflicts: string[] = [];
  return {
    conflicts,
    ingest(message: BridgeToControlMessage) {
      if (message.type !== "session.event" || message.eventType === "session.discovered") return;
      const event = { ...message, sessionId } as StructuredSessionEventMessage;
      if (control.appendSessionEvent(event) === false && control.duplicateEventConflict(event)) conflicts.push(event.eventId);
    },
    /** What the session_events API serves: every stored row, oldest first. */
    rows(): JsonObject[] { return control.sessionEvents(sessionId, undefined, 10_000, []).data as JsonObject[]; },
  };
}

/**
 * The DSH plugin's view: a native turn opened around the remote turn, each
 * poll's rows written into its open step as they arrive (presentLive), the
 * turn's trailing reply as the native answer, then a background sync.
 */
class DshView {
  events: NativeEvent[] = [];
  private turn = 0;
  /** Rows a live turn has read, as the plugin's stream remembers them. */
  private readonly seen = new Set<string>();
  private append(type: string, data: JsonObject) { this.events.push({ type, data, seq: this.events.length, time: 0 }); }
  open() {
    this.turn++;
    this.append("turn/start", { turn: this.turn });
    this.append("step/start", { turn: this.turn, step: 1 });
  }
  /** One poll: what the plugin's stream writes for these rows (the trailing reply is held). */
  poll(rows: JsonObject[], held: { reply?: JsonObject }) {
    const batch: JsonObject[] = [];
    for (const row of rows) {
      if (this.seen.has(String(row["eventId"]))) continue;
      this.seen.add(String(row["eventId"]));
      const payload = row["payload"] as JsonObject;
      if (row["type"] === "message.completed" && payload["role"] === "assistant") { if (held.reply) batch.push(held.reply); held.reply = row; }
      else if (row["type"] === "message.completed" || TOOL_EVENT_TYPES.includes(String(row["type"])) || row["type"] === "task.completed") {
        if (held.reply) { batch.push(held.reply); held.reply = undefined; }
        batch.push(row);
      }
    }
    for (const event of projectNativeEvents(batch, this.events, "remote", "tool-role", openStep(this.events))) this.events.push({ ...event, seq: this.events.length });
  }
  close(held: { reply?: JsonObject }) {
    const text = held.reply ? String((held.reply["payload"] as JsonObject)["text"]) : "";
    if (held.reply) this.append("agent-bridge/event", { eventId: String(held.reply["eventId"]), turnId: String(held.reply["turnId"]) });
    this.append("assistant/message", { turn: this.turn, step: 1, message: { id: "native", role: "assistant", content: text ? [{ type: "text", text }] : [] } });
    this.append("step/end", { turn: this.turn, step: 1 });
    this.append("turn/end", { turn: this.turn, reason: { kind: "completed" } });
    held.reply = undefined;
  }
  /** The background sync after the turn: projects whatever was not yet shown. */
  sync(rows: JsonObject[]) {
    for (const event of projectNativeEvents(rows, this.events, "remote", "tool-role")) this.events.push({ ...event, seq: this.events.length });
    this.turn = Math.max(this.turn, ...this.events.map((event) => Number(event.data["turn"]) || 0));
  }
  shown(): string[] {
    return this.events.flatMap((event) => {
      if (event.type === "tool/call") return [`tool:${String(event.data["callId"])}`];
      if (event.type !== "assistant/message") return [];
      const content = ((event.data["message"] as JsonObject)["content"] as JsonObject[]) ?? [];
      const text = content.map((block) => String(block["text"] ?? "")).join("");
      return text ? [`text:${text}`] : [];
    });
  }
}

const assistantTexts = (rows: JsonObject[]) => rows.filter((row) => row["type"] === "message.completed" && (row["payload"] as JsonObject)["role"] === "assistant")
  .map((row) => String((row["payload"] as JsonObject)["text"]));

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("pi: every message of every turn is stored, and a reaped session revived for its next turn remembers the last", async () => {
  const piStore = mkdtempSync(join(tmpdir(), "mock-pi-store-"));
  process.env.PI_MOCK_STORE = piStore;
  process.env.PI_MOCK_SCRIPT = "multi";
  cleanups.push(() => { delete process.env.PI_MOCK_STORE; delete process.env.PI_MOCK_SCRIPT; rmSync(piStore, { recursive: true, force: true }); });
  let cp: ReturnType<typeof controlPlane> | undefined;
  const early: BridgeToControlMessage[] = [];
  const adapter = new PiAdapter({ command: MOCK_PI, sessionDir: tmpdir(), allowedRoots: [tmpdir()] }, (message) => cp ? cp.ingest(message) : early.push(message));
  cleanups.push(() => adapter.stop());

  const sessionId = await adapter.startSession("run-1", tmpdir());
  cp = controlPlane(sessionId, "pi");
  for (const message of early) cp.ingest(message);
  const settled = () => adapter.stateSnapshot().sessions.find((s) => s.sessionId === sessionId)?.activityStatus === "idle";

  await adapter.submitTurnAction("a1", sessionId, "first question", "auto");
  await waitFor(() => settled() && cp!.rows().some((row) => row["type"] === "turn.completed"));
  const nativeId = adapter.stateSnapshot().sessions[0]!.nativeSessionId;
  assert.match(String(nativeId), /^[0-9a-f-]{36}$/);

  // Idle reaping kills the pi process; the next turn revives it as the client does.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(adapter.reapIdleSessions(1), [sessionId]);
  await adapter.resumeSession(sessionId, tmpdir(), nativeId);
  await adapter.submitTurnAction("a2", sessionId, "second question", "auto");
  await waitFor(() => settled() && cp!.rows().filter((row) => row["type"] === "turn.completed").length === 2);

  const rows = cp.rows();
  assert.deepEqual(cp.conflicts, [], "no event id is reused for different content");
  // Three model responses per prompt, all stored, in both turns.
  assert.deepEqual(assistantTexts(rows), [
    'Looking into "first question".', "Editing it.", 'Done with "first question". Before that you asked: nothing.',
    'Looking into "second question".', "Editing it.", 'Done with "second question". Before that you asked: "first question".',
  ]);
  // pi's per-response turn_end closes nothing: one turn.completed per prompt, summarised by its answer.
  const completed = rows.filter((row) => row["type"] === "turn.completed");
  assert.deepEqual(completed.map((row) => (row["payload"] as JsonObject)["summary"]), [
    'Done with "first question". Before that you asked: nothing.', 'Done with "second question". Before that you asked: "first question".',
  ]);
  // Tool calls are reported as they start and as they end, as command / file-change cards.
  assert.equal(rows.filter((row) => row["type"] === "tool.started").length, 4);
  assert.deepEqual(rows.filter((row) => TOOL_EVENT_TYPES.includes(String(row["type"]))).map((row) => row["type"]),
    ["command.completed", "file_change.completed", "command.completed", "file_change.completed"]);
  assert.ok(rows.some((row) => row["type"] === "progress" && (row["payload"] as JsonObject)["phase"] === "thinking"));
});

test("pi: image attachments reach pi with the prompt", async () => {
  const piStore = mkdtempSync(join(tmpdir(), "mock-pi-store-"));
  process.env.PI_MOCK_STORE = piStore;
  process.env.PI_MOCK_SCRIPT = "multi";
  cleanups.push(() => { delete process.env.PI_MOCK_STORE; delete process.env.PI_MOCK_SCRIPT; rmSync(piStore, { recursive: true, force: true }); });
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new PiAdapter({ command: MOCK_PI, sessionDir: tmpdir(), allowedRoots: [tmpdir()],
    fetchAttachment: async (ref) => ({ ref, mediaType: "image/png", base64: "aGVsbG8=" }) }, (message) => emitted.push(message));
  cleanups.push(() => adapter.stop());
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("a1", sessionId, "why", "auto", undefined, undefined, undefined,
    [{ id: "img", mimeType: "image/png", filename: "shot.png", size: 5 } as never]);
  await waitFor(() => emitted.some((m) => m.type === "session.event" && m.eventType === "turn.completed"));
  const texts = emitted.flatMap((m) => m.type === "session.event" && m.eventType === "message.completed" ? [String(m.payload.text)] : []);
  assert.ok(texts.includes('Looking into "why" with 1 image(s).'), texts.join(" | "));
});

/** A Claude turn as the SDK streams it: text and a tool, the tool's result, then the answer. */
function claudeTurn(question: string, answer: string, uuids: boolean) {
  const id = (name: string) => (uuids ? { uuid: `${question}-${name}` } : {});
  return [
    { type: "assistant", parent_tool_use_id: null, ...id("plan"), message: { content: [
      { type: "text", text: `Checking ${question}.` }, { type: "tool_use", id: `toolu_${question}`, name: "Bash", input: { command: "ls" } }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `toolu_${question}`, content: "a.ts" }] } },
    { type: "assistant", parent_tool_use_id: null, ...id("answer"), message: { content: [{ type: "text", text: answer }] } },
    { type: "result", subtype: "success", is_error: false, result: answer },
  ];
}

test("claude: identical replies in a revived session are two messages, all shown live and once", () => {
  const sessionId = "claude-contract";
  const cp = controlPlane(sessionId, "claude-code");
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({ command: "", allowedRoots: [] }, (message) => { emitted.push(message); cp.ingest(message); });
  const seam = adapter as unknown as { handleMessage(session: unknown, message: unknown): void; startTurnEvents(session: unknown): string };
  // A fresh session object per process, as a revive creates; its turn counter restarts.
  const session = () => ({ sessionId, cwd: "/work", projectPath: "/work", discovered: true, turnSeq: 0, turnTextSeq: 0, logs: [],
    toolUses: new Map(), tasks: new Map(), pendingApprovals: new Map(), ended: false });
  const view = new DshView();
  for (const [question, uuids] of [["one", true], ["two", false]] as const) {
    const live = session();
    const before = cp.rows().length;
    seam.startTurnEvents(live);
    view.open();
    const held: { reply?: JsonObject } = {};
    for (const message of claudeTurn(question, "Done.", uuids)) {
      seam.handleMessage(live, message);
      // The plugin polls after each SDK message: what has arrived is on screen already.
      view.poll(cp.rows().slice(before), held);
    }
    assert.ok(view.shown().includes(`text:Checking ${question}.`), "the plan shows before the turn ends");
    view.close(held);
  }
  assert.deepEqual(cp.conflicts, []);
  assert.deepEqual(assistantTexts(cp.rows()), ["Checking one.", "Done.", "Checking two.", "Done."]);
  assert.deepEqual(view.shown(), ["text:Checking one.", "tool:bridge:claude:claude-contract:toolu_one:command", "text:Done.",
    "text:Checking two.", "tool:bridge:claude:claude-contract:toolu_two:command", "text:Done."]);
  // A background sync (or a restarted plugin) re-reading everything shows nothing again.
  const shownBefore = view.shown();
  view.sync(cp.rows());
  view.sync(cp.rows());
  assert.deepEqual(view.shown(), shownBefore);
});

test("codex: tool starts and thinking are reported, and a long turn shows its work before it ends", async () => {
  const threadId = "thread-contract";
  const cp = controlPlane(threadId, "codex-cli");
  const adapter = new CodexAppServerAdapter({ command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()], manageServer: false, reconnectMs: 3_000 },
    (message) => cp.ingest(message));
  const seam = adapter as unknown as { handleNotification(method: string, params: Record<string, unknown>): Promise<void>; threadsById: Map<string, unknown> };
  seam.threadsById.set(threadId, { id: threadId, cwd: process.cwd() });
  const view = new DshView();
  const held: { reply?: JsonObject } = {};
  let cursor = 0;
  const poll = () => { const rows = cp.rows(); view.poll(rows.slice(cursor), held); cursor = rows.length; };
  const notify = async (method: string, params: Record<string, unknown>) => { await seam.handleNotification(method, { threadId, ...params }); poll(); };
  view.open();
  await notify("turn/started", { turn: { id: "turn-1", status: "inProgress", items: [] } });
  await notify("item/started", { turnId: "turn-1", item: { id: "r1", type: "reasoning" } });
  await notify("item/completed", { turnId: "turn-1", item: { id: "m1", type: "agentMessage", text: "Looking." } });
  await notify("item/started", { turnId: "turn-1", item: { id: "c1", type: "commandExecution", command: "ls" } });
  await notify("item/completed", { turnId: "turn-1", item: { id: "c1", type: "commandExecution", command: "ls", status: "completed", exitCode: 0 } });
  await notify("item/started", { turnId: "turn-1", item: { id: "t1", type: "mcpToolCall", server: "docs", tool: "search" } });
  await notify("item/completed", { turnId: "turn-1", item: { id: "t1", type: "mcpToolCall", server: "docs", tool: "search", status: "completed" } });
  // Mid-turn, before turn/completed: the text and both tools are on screen.
  assert.deepEqual(view.shown(), ["text:Looking.", "tool:bridge:app-server:thread-contract:c1:command", "tool:bridge:app-server:thread-contract:t1:tool"]);
  await notify("item/completed", { turnId: "turn-1", item: { id: "m2", type: "agentMessage", text: "Found it." } });
  await notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [
    { id: "m1", type: "agentMessage", text: "Looking." }, { id: "m2", type: "agentMessage", text: "Found it." }] } });
  view.close(held);
  const rows = cp.rows();
  assert.deepEqual(cp.conflicts, []);
  assert.deepEqual(rows.filter((row) => row["type"] === "tool.started").map((row) => (row["payload"] as JsonObject)["name"]), ["shell", "search"]);
  assert.ok(rows.some((row) => row["type"] === "progress" && (row["payload"] as JsonObject)["phase"] === "thinking"));
  assert.deepEqual(view.shown(), ["text:Looking.", "tool:bridge:app-server:thread-contract:c1:command", "tool:bridge:app-server:thread-contract:t1:tool", "text:Found it."]);
  const shownBefore = view.shown();
  view.sync(rows);
  assert.deepEqual(view.shown(), shownBefore);
});

test("the Control Plane tells a replay from a reused event id", () => {
  const cp = controlPlane("s", "pi");
  const event = (text: string) => ({ type: "session.event", eventType: "message.completed", sessionId: "s", eventId: "pi:s:t1:assistant",
    timestamp: 1, turnId: "t1", payload: { role: "assistant", text } }) as BridgeToControlMessage;
  cp.ingest(event("first"));
  cp.ingest(event("first"));
  assert.deepEqual(cp.conflicts, [], "a replay is not a conflict");
  cp.ingest(event("second"));
  assert.deepEqual(cp.conflicts, ["pi:s:t1:assistant"]);
});
