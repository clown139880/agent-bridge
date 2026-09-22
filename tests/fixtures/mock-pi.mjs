#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc` used by the bridge pi-adapter tests.
// Reads JSONL commands on stdin and emits the subset of RPC responses/events the
// PiAdapter relies on. Configured via env so each test can assert on received
// commands and control the available-model catalog.
import process from "node:process";
import { appendFileSync } from "node:fs";

const LOG_PATH = process.env.PI_MOCK_LOG;
const MODELS = JSON.parse(process.env.PI_MOCK_MODELS ?? '[]');
let provider = "";
let modelId = "";
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--provider" && process.argv[i + 1]) provider = process.argv[i + 1];
  if (process.argv[i] === "--model" && process.argv[i + 1]) modelId = process.argv[i + 1].includes("/")
    ? process.argv[i + 1].slice(process.argv[i + 1].indexOf("/") + 1)
    : process.argv[i + 1];
}

function log(line) {
  if (LOG_PATH) appendFileSync(LOG_PATH, line + "\n");
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
        sessionId: "mock-session",
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
      out({ type: "turn_start" });
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
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
