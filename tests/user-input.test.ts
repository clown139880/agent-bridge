import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalResponseFor,
  approvalChoicesFor,
  approvalSummary,
  formatUserInputRequest,
  parseUserInputAnswers,
} from "../apps/bridge/src/app-server.js";

const questions = [
  {
    id: "mode",
    header: "Mode",
    question: "How should Codex proceed?",
    isOther: false,
    isSecret: false,
    options: [
      { label: "Fast", description: "Skip extended checks" },
      { label: "Safe", description: "Run all checks" },
    ],
  },
  {
    id: "note",
    header: "Note",
    question: "Anything else?",
    isOther: true,
    isSecret: false,
    options: null,
  },
];

test("formatUserInputRequest includes questions, options, and reply instructions", () => {
  const result = formatUserInputRequest(questions);
  assert.match(result, /1\. Mode: How should Codex proceed\?/);
  assert.match(result, /1\) Fast — Skip extended checks/);
  assert.match(result, /Reply with 2 answers, one per line/);
});

test("parseUserInputAnswers accepts option numbers and ordered free-form answers", () => {
  assert.deepEqual(parseUserInputAnswers("2\nPlease preserve compatibility", questions), {
    mode: { answers: ["Safe"] },
    note: { answers: ["Please preserve compatibility"] },
  });
});

test("parseUserInputAnswers accepts a label for a single question", () => {
  assert.deepEqual(parseUserInputAnswers("fast", [questions[0]!]), {
    mode: { answers: ["Fast"] },
  });
});

test("parseUserInputAnswers rejects incomplete multi-question replies", () => {
  assert.throws(() => parseUserInputAnswers("Safe", questions), /Expected 2 answers/);
});

test("approvalResponseFor maps command choices to App Server decisions", () => {
  assert.deepEqual(approvalResponseFor("item/commandExecution/requestApproval", {}, "allow"), { decision: "accept" });
  assert.deepEqual(approvalResponseFor("item/fileChange/requestApproval", {}, "allow-session"), { decision: "acceptForSession" });
  assert.deepEqual(approvalResponseFor("item/commandExecution/requestApproval", {}, "deny"), { decision: "decline" });
});

test("approvalResponseFor uses the exact decision variants offered by App Server", () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["curl"] } };
  const params = { availableDecisions: ["accept", amendment, "cancel"] };
  assert.deepEqual(approvalResponseFor("item/commandExecution/requestApproval", params, "allow-session"), {
    decision: amendment,
  });
  assert.deepEqual(approvalResponseFor("item/commandExecution/requestApproval", params, "deny"), {
    decision: "cancel",
  });
  assert.deepEqual(approvalChoicesFor("item/commandExecution/requestApproval", params), [
    "allow", "deny", "allow-session",
  ]);
});

test("approvalChoicesFor hides choices omitted by App Server", () => {
  assert.deepEqual(approvalChoicesFor("item/commandExecution/requestApproval", {
    availableDecisions: ["accept", "cancel"],
  }), ["allow", "deny"]);
});

test("approvalResponseFor grants only requested permissions with the selected scope", () => {
  const params = { permissions: { network: { enabled: true } } };
  assert.deepEqual(approvalResponseFor("item/permissions/requestApproval", params, "allow"), {
    permissions: params.permissions,
    scope: "turn",
  });
  assert.deepEqual(approvalResponseFor("item/permissions/requestApproval", params, "allow-session"), {
    permissions: params.permissions,
    scope: "session",
  });
  assert.deepEqual(approvalResponseFor("item/permissions/requestApproval", params, "deny"), {
    permissions: {},
    scope: "turn",
  });
});

test("approvalSummary shows network targets instead of relying on a command", () => {
  assert.match(approvalSummary("item/commandExecution/requestApproval", {
    networkApprovalContext: { protocol: "https", host: "example.com" },
    reason: "Download metadata",
  }), /Network: https:\/\/example\.com/);
});
