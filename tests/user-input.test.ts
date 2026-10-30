import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalResponseFor,
  approvalChoicesFor,
  approvalSummary,
  formatUserInputRequest,
  parseUserInputAnswers,
} from "../apps/bridge/src/app-server.js";
import { askUserQuestionAnswers } from "../apps/bridge/src/claude/claude-adapter.js";

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

test("MCP tool approval elicitations become Bridge approvals", () => {
  const method = "mcpServer/elicitation/request";
  const params = { threadId: "t", turnId: "u", serverName: "memory", mode: "form",
    message: "Allow the memory MCP server to run tool \"scopes\"?",
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] } };
  assert.deepEqual(approvalChoicesFor(method, params), ["allow", "deny", "allow-session"]);
  assert.deepEqual(approvalResponseFor(method, params, "allow"), { action: "accept", content: {}, _meta: null });
  assert.deepEqual(approvalResponseFor(method, params, "allow-session"), { action: "accept", content: {}, _meta: { persist: "session" } });
  assert.deepEqual(approvalResponseFor(method, params, "deny"), { action: "decline", content: null, _meta: null });
  assert.match(approvalSummary(method, params), /Server: memory\nAllow the memory MCP server to run tool "scopes"\?/);
  assert.deepEqual(approvalChoicesFor(method, { ...params, _meta: null }), ["allow", "deny"]);
});

test("MCP elicitations that need form data or a URL can only be declined remotely", () => {
  const method = "mcpServer/elicitation/request";
  const form = { serverName: "x", mode: "form", message: "Token?", _meta: null,
    requestedSchema: { type: "object", properties: { token: { type: "string" } } } };
  assert.deepEqual(approvalChoicesFor(method, form), ["deny"]);
  const url = { serverName: "x", mode: "url", message: "Sign in", url: "https://example.com/auth", elicitationId: "e", _meta: null };
  assert.deepEqual(approvalChoicesFor(method, url), ["deny"]);
  assert.match(approvalSummary(method, url), /URL: https:\/\/example\.com\/auth\nComplete this request in Codex/);
});

test("askUserQuestionAnswers keys Claude answers by question text", () => {
  assert.deepEqual(
    askUserQuestionAnswers(questions, {
      mode: { answers: ["Fast", "Safe"] },
      note: { answers: [] },
    }),
    { "How should Codex proceed?": "Fast, Safe" },
  );
});
