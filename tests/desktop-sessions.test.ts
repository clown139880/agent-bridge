import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]?.type, "session.discovered");
  assert.equal(emitted[0] && "agentType" in emitted[0] ? emitted[0].agentType : undefined, "codex-desktop");
  assert.deepEqual(emitted[1], {
    type: "agent.completed",
    eventId: "desktop:session-1:new-turn:agent.completed",
    sessionId: "session-1",
    timestamp: emitted[1] && "timestamp" in emitted[1] ? emitted[1].timestamp : undefined,
    summary: "Finished from Desktop",
  });

  await scanner.refresh();
  assert.equal(emitted.length, 2);
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
