#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc` used by the bridge pi-adapter tests.
// Reads JSONL commands on stdin and emits the subset of RPC responses/events the
// PiAdapter relies on. Configured via env so each test can assert on received
// commands and control the available-model catalog.
import process from "node:process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const LOG_PATH = process.env.PI_MOCK_LOG;
const MODELS = JSON.parse(process.env.PI_MOCK_MODELS ?? '[]');
let provider = "";
let modelId = "";
let session = "";
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--provider" && process.argv[i + 1]) provider = process.argv[i + 1];
  if (process.argv[i] === "--session" && process.argv[i + 1]) session = process.argv[i + 1];
  if (process.argv[i] === "--model" && process.argv[i + 1]) modelId = process.argv[i + 1].includes("/")
    ? process.argv[i + 1].slice(process.argv[i + 1].indexOf("/") + 1)
    : process.argv[i + 1];
}

function log(line) {
  if (LOG_PATH) appendFileSync(LOG_PATH, line + "\n");
}
// Record the launch-time provider/model so tests can assert what pi was started
// with (mirrors the provider-qualified model-id resolution in the adapter).
log(JSON.stringify({ type: "launch", provider, model: modelId, ...(session ? { session } : {}) }));
// Like pi itself: an unknown --session prints to stderr and exits before any RPC.
if (session && session === process.env.PI_MOCK_MISSING_SESSION) {
  process.stderr.write(`No session found matching '${session}'\n`);
  process.exit(0);
}
// PI_MOCK_STORE=<dir>: sessions live on disk like pi's own, so a new process
// given --session continues the conversation and a fresh one starts a new uuid.
const STORE = process.env.PI_MOCK_STORE;
let history = [];
if (STORE) {
  if (session && !existsSync(`${STORE}/${session}.json`)) {
    process.stderr.write(`No session found matching '${session}'\n`);
    process.exit(0);
  }
  if (session) history = JSON.parse(readFileSync(`${STORE}/${session}.json`, "utf8"));
  else session = randomUUID();
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(command, data, success = true, error) {
  out({ type: "response", command, success, ...(success ? { data } : { error }) });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handleLine(line);
    newline = buffer.indexOf("\n");
  }
});

function handleLine(raw) {
  let command;
  try { command = JSON.parse(raw); } catch { out({ type: "response", command: "parse", success: false, error: "bad json" }); return; }
  log(JSON.stringify(command));
  switch (command.type) {
    case "get_state":
      respond("get_state", {
        model: modelId ? { id: modelId, provider, name: modelId } : null,
        sessionId: session || "mock-session",
        sessionFile: "/tmp/mock-session.jsonl",
        thinkingLevel: "medium",
        isStreaming: false,
      });
      break;
    case "get_available_models":
      respond("get_available_models", { models: MODELS });
      break;
    case "set_model":
      modelId = command.modelId;
      provider = command.provider;
      respond("set_model", { id: modelId, provider, name: modelId });
      break;
    case "set_thinking_level":
      respond("set_thinking_level");
      break;
    case "prompt":
    case "steer":
    case "follow_up": {
      respond(command.type, {});
      // PI_MOCK_SCRIPT=multi: one prompt as pi really runs it — several model
      // responses per agent run, each its own turn_start/turn_end, tools between.
      if (process.env.PI_MOCK_SCRIPT === "multi") { runMulti(command); break; }
      out({ type: "turn_start" });
      const err = process.env.PI_MOCK_ERROR;
      if (err) {
        out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: err } });
      } else {
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
      }
      out({ type: "turn_end" });
      out({ type: "agent_settled" });
      break;
    }
    case "abort":
      respond("abort");
      break;
    default:
      respond(command.type, {});
  }
}

function runMulti(command) {
  const earlier = history.at(-1);
  history.push(command.message);
  if (STORE) writeFileSync(`${STORE}/${session}.json`, JSON.stringify(history));
  const images = command.images?.length ? ` with ${command.images.length} image(s)` : "";
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
  out({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "plan" }, { type: "text", text: `Looking into "${command.message}"${images}.` },
    { type: "toolCall", id: "call_0", name: "bash", arguments: { command: "ls" } }] } });
  out({ type: "tool_execution_start", toolCallId: "call_0", toolName: "bash", args: { command: "ls" } });
  out({ type: "tool_execution_end", toolCallId: "call_0", toolName: "bash", result: { content: [{ type: "text", text: "a.ts" }] }, isError: false });
  out({ type: "turn_end", message: {}, toolResults: [] });
  out({ type: "turn_start" });
  out({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "text", text: "Editing it." }, { type: "toolCall", id: "call_0", name: "edit", arguments: { path: "a.ts" } }] } });
  out({ type: "tool_execution_start", toolCallId: "call_0", toolName: "edit", args: { path: "a.ts" } });
  out({ type: "tool_execution_end", toolCallId: "call_0", toolName: "edit", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  out({ type: "turn_end", message: {}, toolResults: [] });
  out({ type: "turn_start" });
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  out({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [
    { type: "text", text: `Done with "${command.message}". Before that you asked: ${earlier ? `"${earlier}"` : "nothing"}.` }] } });
  out({ type: "turn_end", message: {}, toolResults: [] });
  out({ type: "agent_end", messages: [] });
  out({ type: "agent_settled" });
}
