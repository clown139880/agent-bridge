import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage, statusForEvent } from "../packages/protocol/src/index.js";

test("parseMessage accepts typed JSON objects", () => {
  assert.deepEqual(parseMessage('{"type":"heartbeat","timestamp":1}'), { type: "heartbeat", timestamp: 1 });
  assert.equal(parseMessage("not json"), undefined);
  assert.equal(parseMessage("[]"), undefined);
});

test("statusForEvent maps lifecycle events", () => {
  assert.equal(statusForEvent("agent.started"), "working");
  assert.equal(statusForEvent("agent.blocked"), "blocked");
  assert.equal(statusForEvent("agent.completed"), "completed");
});

test("parseMessage accepts approval responses", () => {
  assert.deepEqual(parseMessage('{"type":"approval_response","sessionId":"s1","approvalId":"a1","choice":"allow-session"}'), {
    type: "approval_response",
    sessionId: "s1",
    approvalId: "a1",
    choice: "allow-session",
  });
});
