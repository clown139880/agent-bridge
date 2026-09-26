import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { BridgeToControlMessage } from "../packages/protocol/src/index.js";
import { CodexDesktopSessionScanner } from "../apps/bridge/src/desktop-sessions.js";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

test("Desktop scanner baselines history, reports new completions, and tracks active turns", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-${randomUUID()}`);
  const project = join(root, "project");
  const sessionDirectory = join(root, ".codex", "sessions", "2026", "09", "04");
  const rollout = join(sessionDirectory, "rollout-session-1.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(rollout, [
    line({ type: "session_meta", payload: { id: "session-1", cwd: project, originator: "Codex Desktop" } }),
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } }),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn" } }),
  ].join(""));

  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({
    codexHome: join(root, ".codex"),
    allowedRoots: [root],
    intervalMs: 60_000,
    replayExisting: false,
    emit: (message) => emitted.push(message),
  });

  await scanner.start();
  assert.deepEqual(emitted, []);
  appendFileSync(rollout, line({ type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } }));
  await scanner.refresh();
  assert.equal(scanner.isThreadActive("session-1"), true);

  appendFileSync(rollout, [
    line({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished from Desktop" }] },
    }),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "new-turn" } }),
  ].join(""));
  await scanner.refresh();

  assert.equal(scanner.isThreadActive("session-1"), false);
  assert.equal(emitted.length, 5);
  assert.equal(emitted[0]?.type === "session.discovered" ? emitted[0].status : undefined, "working");
  assert.equal(emitted[1]?.type === "session.event" ? emitted[1].eventType : undefined, "turn.started");
  assert.equal(emitted[1]?.type === "session.event" ? emitted[1].eventId : undefined, "app-server:session-1:new-turn:started");
  assert.equal(emitted[2]?.type, "session.discovered");
  if(emitted[2]?.type === "session.discovered") assert.equal(emitted[2].updatedAt,emitted[2].createdAt);
  assert.equal(emitted[2] && "agentType" in emitted[2] ? emitted[2].agentType : undefined, "codex-desktop");
  assert.deepEqual(emitted[3], {
    type: "agent.completed",
    eventId: "desktop:session-1:new-turn:agent.completed",
    sessionId: "session-1",
    timestamp: emitted[3] && "timestamp" in emitted[3] ? emitted[3].timestamp : undefined,
    summary: "Finished from Desktop",
  });
  assert.equal(emitted[4]?.type, "session.event");
  assert.equal(emitted[4]?.type === "session.event" ? emitted[4].eventType : undefined, "turn.completed");

  await scanner.refresh();
  assert.equal(emitted.length, 5);
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner ignores non-Desktop and out-of-scope rollouts", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-${randomUUID()}`);
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  const sessions = join(root, ".codex", "sessions");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-cli.jsonl"), [
    line({ type: "session_meta", payload: { id: "cli", cwd: allowed, originator: "codex_cli_rs" } }),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join(""));
  writeFileSync(join(sessions, "rollout-outside.jsonl"), [
    line({ type: "session_meta", payload: { id: "outside", cwd: outside, originator: "Codex Desktop" } }),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } }),
  ].join(""));

  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({
    codexHome: join(root, ".codex"),
    allowedRoots: [allowed],
    intervalMs: 60_000,
    replayExisting: true,
    emit: (message) => emitted.push(message),
  });
  await scanner.start();
  scanner.stop();
  assert.deepEqual(emitted, []);
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner rediscovers a session when its title is updated", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-title-${randomUUID()}`);
  const project = join(root, "project");
  const sessions = join(root, ".codex", "sessions");
  const rollout = join(sessions, "rollout-title.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, line({ type: "session_meta", payload: {
    id: "desktop-title", cwd: project, originator: "Codex Desktop", title: "Initial",
  } }));
  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({ codexHome: join(root, ".codex"), allowedRoots: [root],
    intervalMs: 60_000, replayExisting: false, emit: (message) => emitted.push(message) });
  await scanner.start();

  appendFileSync(rollout, line({ type: "session_meta", payload: {
    id: "desktop-title", title: "Generated title",
  } }));
  await scanner.refresh();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.type, "session.discovered");
  assert.equal(emitted[0]?.type === "session.discovered" ? emitted[0].title : undefined, "Generated title");
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner reads generated titles from the Desktop session index", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-index-title-${randomUUID()}`);
  const project = join(root, "project");
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions");
  const rollout = join(sessions, "rollout-index-title.jsonl");
  const index = join(codexHome, "session_index.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, line({ type: "session_meta", payload: {
    id: "desktop-index-title", cwd: project, originator: "Codex Desktop",
  } }));
  writeFileSync(index, line({ id: "desktop-index-title", thread_name: "Generated in Desktop" }));
  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({ codexHome, allowedRoots: [root],
    intervalMs: 60_000, replayExisting: false, emit: (message) => emitted.push(message) });

  await scanner.start();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.type === "session.discovered" ? emitted[0].title : undefined, "Generated in Desktop");

  appendFileSync(index, line({ id: "desktop-index-title", thread_name: "Renamed in Desktop" }));
  await scanner.refresh();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.type === "session.discovered" ? emitted[1].title : undefined, "Renamed in Desktop");
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner uses rollout event times instead of synchronized file mtimes", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-time-${randomUUID()}`);
  const project = join(root, "project");
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions");
  const rollout = join(sessions, "rollout-time.jsonl");
  const createdAt = "2026-09-09T01:00:00.000Z";
  const completedAt = "2026-09-09T01:15:00.000Z";
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, [
    line({ timestamp: createdAt, type: "session_meta", payload: {
      id: "desktop-time", cwd: project, originator: "Codex Desktop", title: "Timed session",
    } }),
    line({ timestamp: "2026-09-09T01:14:00.000Z", type: "event_msg", payload: {
      type: "task_started", turn_id: "turn-time",
    } }),
    line({ timestamp: completedAt, type: "event_msg", payload: {
      type: "task_complete", turn_id: "turn-time",
    } }),
  ].join(""));
  const synchronizedAt = new Date("2026-09-09T09:00:00.000Z");
  utimesSync(rollout, synchronizedAt, synchronizedAt);
  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({ codexHome, allowedRoots: [root],
    intervalMs: 60_000, replayExisting: true, emit: (message) => emitted.push(message) });

  await scanner.start();

  const discovery = emitted.findLast((message) => message.type === "session.discovered");
  assert.ok(discovery?.type === "session.discovered");
  assert.equal(discovery.createdAt, Date.parse(createdAt));
  assert.equal(discovery.updatedAt, Date.parse(completedAt));
  const completed = emitted.find((message) => message.type === "agent.completed");
  assert.ok(completed?.type === "agent.completed");
  assert.equal(completed.timestamp, Date.parse(completedAt));
  const terminal = emitted.find((message) => message.type === "session.event" && message.eventType === "turn.completed");
  assert.ok(terminal?.type === "session.event");
  assert.equal(terminal.timestamp, Date.parse(completedAt));
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner streams completed rollout items while the turn is running", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-items-${randomUUID()}`);
  const project = join(root, "project");
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions");
  const rollout = join(sessions, "rollout-items.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, line({ type: "session_meta", payload: { id: "desktop-items", cwd: project, originator: "Codex Desktop" } }));
  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({ codexHome, allowedRoots: [root],
    intervalMs: 60_000, replayExisting: false, emit: (message) => emitted.push(message) });
  await scanner.start();

  const item = (turn: string, value: Record<string, unknown>, completedAt: number) => line({
    timestamp: "2026-09-26T00:00:59.000Z", type: "event_msg",
    payload: { type: "item_completed", thread_id: "desktop-items", turn_id: turn, item: value,
      started_at_ms: completedAt - 5, completed_at_ms: completedAt },
  });
  appendFileSync(rollout, [
    line({ timestamp: "2026-09-26T00:00:00.000Z", type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1", started_at: 1_790_000_000 } }),
    item("turn-1", { type: "UserMessage", id: "user-1", content: [{ type: "text", text: "run it", text_elements: [] }] }, 1_000),
    item("turn-1", { type: "Reasoning", id: "rs-1", summary_text: [] }, 1_500),
    item("turn-1", { type: "CommandExecution", id: "exec-1", command: ["/usr/bin/zsh", "-lc", "echo 'hi' && ls"],
      cwd: "file:///root/my%20project", status: "failed", exit_code: 2, aggregated_output: "boom" }, 2_000),
    item("turn-1", { type: "FileChange", id: "exec-2", status: "completed", changes: {
      "/root/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@", move_path: null },
      "/root/b.ts": { type: "add", content: "new" },
    } }, 3_000),
    item("turn-1", { type: "AgentMessage", id: "msg-1", phase: "commentary", content: [{ type: "Text", text: "Working" }] }, 4_000),
    item("turn-1", { type: "CommandExecution", command: ["true"] }, 5_000),
  ].join(""));
  await scanner.refresh();

  assert.equal(scanner.isThreadActive("desktop-items"), true);
  const events = emitted.filter((message) => message.type === "session.event");
  assert.deepEqual(events.map((event) => event.type === "session.event" && [event.eventType, event.eventId, event.turnId, event.itemId, event.timestamp]), [
    ["turn.started", "app-server:desktop-items:turn-1:started", "turn-1", undefined, Date.parse("2026-09-26T00:00:00.000Z")],
    ["message.completed", "app-server:desktop-items:user-1:message", "turn-1", "user-1", 1_000],
    ["command.completed", "app-server:desktop-items:exec-1:command", "turn-1", "exec-1", 2_000],
    ["file_change.completed", "app-server:desktop-items:exec-2:file-change", "turn-1", "exec-2", 3_000],
    ["message.completed", "app-server:desktop-items:msg-1:message", "turn-1", "msg-1", 4_000],
  ]);
  assert.equal(emitted[0]?.type === "session.discovered" ? emitted[0].status : undefined, "working");
  const payloads = events.map((event) => event.type === "session.event" ? event.payload : undefined);
  assert.deepEqual(payloads[1], { role: "user", text: "run it" });
  assert.deepEqual(payloads[2], { command: "/usr/bin/zsh -lc 'echo '\\''hi'\\'' && ls'", cwd: "/root/my project",
    status: "failed", exitCode: 2, output: "boom" });
  assert.deepEqual(payloads[3], { changes: [
    { path: "/root/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@" },
    { path: "/root/b.ts", kind: { type: "add" }, diff: "new" },
  ], summary: "2 file changes applied", truncated: false });
  assert.deepEqual(payloads[4], { role: "assistant", text: "Working" });
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner leaves turns run by the Bridge App Server to its notifications", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-owned-${randomUUID()}`);
  const project = join(root, "project");
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions");
  const rollout = join(sessions, "rollout-owned.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, line({ type: "session_meta", payload: { id: "desktop-owned", cwd: project, originator: "Codex Desktop" } }));
  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({ codexHome, allowedRoots: [root],
    intervalMs: 60_000, replayExisting: false, emit: (message) => emitted.push(message),
    isBridgeTurn: (_threadId, turnId) => turnId === "bridge-turn" });
  await scanner.start();

  const turn = (turnId: string) => [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    line({ type: "event_msg", payload: { type: "item_completed", turn_id: turnId,
      item: { type: "CommandExecution", id: `${turnId}-exec`, command: ["ls"], status: "completed", exit_code: 0 },
      completed_at_ms: 1 } }),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }),
  ].join("");
  appendFileSync(rollout, turn("bridge-turn") + turn("desktop-turn"));
  await scanner.refresh();

  assert.ok(emitted.length > 0);
  for (const message of emitted) {
    if ("eventId" in message) assert.ok(!String(message.eventId).includes("bridge-turn"), String(message.eventId));
  }
  assert.ok(emitted.some((message) => message.type === "session.event" && message.itemId === "desktop-turn-exec"));
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Desktop scanner rescans active rollouts faster than the idle interval", async () => {
  const root = join(tmpdir(), `agent-bridge-desktop-fast-${randomUUID()}`);
  const project = join(root, "project");
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions");
  const rollout = join(sessions, "rollout-fast.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, line({ type: "session_meta", payload: { id: "desktop-fast", cwd: project, originator: "Codex Desktop" } }));
  const emitted: BridgeToControlMessage[] = [];
  const scanner = new CodexDesktopSessionScanner({ codexHome, allowedRoots: [root],
    intervalMs: 3_000, replayExisting: false, emit: (message) => emitted.push(message) });
  await scanner.start();
  appendFileSync(rollout, line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-fast" } }));
  // Let the idle timer (3 s) discover the running turn, then time the next item.
  await new Promise((resolve) => setTimeout(resolve, 3_300));
  assert.equal(scanner.isThreadActive("desktop-fast"), true);
  appendFileSync(rollout, line({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn-fast",
    item: { type: "CommandExecution", id: "fast-exec", command: ["ls"], status: "completed", exit_code: 0 }, completed_at_ms: 1 } }));
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  assert.ok(emitted.some((message) => message.type === "session.event" && message.itemId === "fast-exec"));
  scanner.stop();
  rmSync(root, { recursive: true, force: true });
});
