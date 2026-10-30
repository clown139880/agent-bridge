import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeAdapter } from "../apps/bridge/src/claude/claude-adapter.js";
import { PiAdapter } from "../apps/bridge/src/pi/pi-adapter.js";
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";
import { waitForTurnSettlement } from "../apps/bridge/src/turn-settlement.js";
import { contextualInput, originalUserInput } from "../apps/bridge/src/session-context.js";

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
test("Claude and Pi interrupts do not publish a false terminal event when cancellation merely acknowledges", async t => {
  const keepalive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepalive));
  for (const kind of ["claude", "pi"]) {
    const events: any[] = [];
    const adapter = kind === "claude" ? new ClaudeCodeAdapter({ command: "", allowedRoots: [] } as any, e => events.push(e))
      : new PiAdapter({ command: "", allowedRoots: [] }, e => events.push(e));
    const seam = adapter as any;
    const session = { sessionId: "session", activeTurnId: "turn", cwd: "/tmp", logs: [], pendingApprovals: new Map(),
      tasks: new Map(), query: { async interrupt() {} }, abort: new AbortController(), turnSeq: 1 };
    seam.sessions.set("session", session);
    if (kind === "pi") seam.sendCommand = () => {};
    let accepted = false;
    const result = adapter.interruptAction("session", "turn").then(() => { accepted = true; });
    await delay(40);
    assert.equal(accepted, false); assert.equal(session.activeTurnId, "turn");
    assert.equal(events.filter(e => e.eventType === "turn.interrupted").length, 0);
    seam.finishTurn(session, "completed");
    await result;
    assert.equal(events.filter(e => e.eventType === "turn.interrupted").length, 1);
  }
});

test("unconfirmed cancellation retains the active turn and returns a specific failure", async () => {
  const timer = setTimeout(() => {}, 1000);
  try { await assert.rejects(waitForTurnSettlement(() => "old", "old", 30), { code: "interrupt_unconfirmed" }); }
  finally { clearTimeout(timer); }
});

test("supplemental context reaches the model while original user text remains clean in the UI", () => {
  const original = "compare my attachments\nwith yesterday's result";
  const combined = contextualInput(original, { scopeId: "room", revision: "v", text: "saved core memory", changed: true, recall: "relevant fact" })!;
  assert.ok(combined.startsWith(original)); assert.match(combined, /saved core memory/); assert.match(combined, /relevant fact/);
  assert.equal(originalUserInput(combined), original);
  assert.equal(originalUserInput(original), original);
});

test("Codex interrupted turns close only their own interactions without inventing a deny decision", () => {
  const events: any[] = [];
  const adapter = new CodexAppServerAdapter({ command: "", allowedRoots: [] } as any, event => events.push(event));
  const seam = adapter as any;
  seam.pendingUserInput.set("old-question", { publicId: "old-question", sessionId: "s", turnId: "old" });
  seam.pendingUserInput.set("new-question", { publicId: "new-question", sessionId: "s", turnId: "new" });
  seam.pendingApprovals.set("old-approval", { approvalId: "old-approval", sessionId: "s", turnId: "old" });
  seam.emitTerminalTurn("s", { id: "old", status: "interrupted", items: [] });
  assert.equal(seam.pendingUserInput.has("old-question"), false);
  assert.equal(seam.pendingUserInput.has("new-question"), true);
  assert.equal(seam.pendingApprovals.has("old-approval"), false);
  assert.ok(events.some(e => e.eventType === "approval.resolved" && e.payload.resolution === "cancelled"));
  assert.ok(events.every(e => e.choice !== "deny" && e.payload?.choice !== "deny"));
});
