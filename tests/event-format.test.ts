import assert from "node:assert/strict";
import test from "node:test";
import { formatEvent } from "../apps/control-plane/src/server.js";

test("started and output events do not create Matrix notifications", () => {
  assert.equal(formatEvent({ type: "agent.started", sessionId: "s1", timestamp: 1 }), undefined);
  assert.equal(formatEvent({ type: "agent.output", sessionId: "s1", timestamp: 1, text: "working" }), undefined);
  assert.match(formatEvent({ type: "agent.progress", sessionId: "s1", timestamp: 1, summary: "command" }) ?? "", /Progress/);
});

test("actionable and terminal events still create Matrix notifications", () => {
  assert.match(formatEvent({ type: "agent.waiting", sessionId: "s1", timestamp: 1, summary: "Choose one" }) ?? "", /Needs input/);
  assert.match(formatEvent({ type: "agent.completed", sessionId: "s1", timestamp: 1, summary: "Done" }) ?? "", /Completed/);
  assert.match(formatEvent({ type: "agent.failed", sessionId: "s1", timestamp: 1, summary: "Broken" }) ?? "", /Failed/);
});
