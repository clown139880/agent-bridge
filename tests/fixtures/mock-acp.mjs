#!/usr/bin/env node
// A minimal Agent Client Protocol agent for adapter tests, shaped like Grok Build.
// Prompts drive it: "approve <cmd>" asks for permission then runs a command,
// "wait" streams then blocks until session/cancel, anything else echoes.
import { createInterface } from "node:readline";

const sessions = new Map();
let nextAgentRequest = 0;
const pendingAgentRequests = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const ask = (method, params) => new Promise((resolve) => {
  const id = nextAgentRequest++;
  pendingAgentRequests.set(id, resolve);
  send({ id, method, params });
});
const config = (model = "grok-a", effort = "medium") => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: "grok-a", name: "Grok A" }, { value: "grok-b", name: "Grok B" }] },
  { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: effort, options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
];
const modelState = { currentModelId: "grok-a", availableModels: [
  { modelId: "grok-a", name: "Grok A", _meta: { reasoningEfforts: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium", default: true }] } },
  { modelId: "grok-b", name: "Grok B" },
] };

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.find((block) => block.type === "text")?.text ?? "";
  session.history.push(text);
  // Grok also sends vendor notifications and stray responses; clients must ignore them.
  send({ method: "_x.ai/session_notification", params: { type: "retry_state" } });
  send({ id: "skills-reload", result: {} });
  update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  if (text.startsWith("approve ")) {
    const command = text.slice(8);
    update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "run_terminal_command", status: "pending", rawInput: { command } });
    const answer = await ask("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "call-1", kind: "execute", title: `Execute \`${command}\``, rawInput: { command } },
      options: [
        { optionId: "always-allow", kind: "allow_always", name: "Always" },
        { optionId: "allow-once", kind: "allow_once", name: "Once" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    });
    const allowed = answer.outcome?.outcome === "selected" && answer.outcome.optionId !== "reject-once";
    update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", kind: "execute", title: `Execute \`${command}\``,
      status: allowed ? "completed" : "failed", rawInput: { command },
      content: [{ type: "content", content: { type: "text", text: allowed ? "hi" : "rejected" } }],
      rawOutput: allowed ? { exit_code: 0, current_dir: session.cwd } : undefined });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${answer.outcome?.optionId ?? answer.outcome?.outcome}` } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text === "wait") {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    session.cancel = () => send({ id, result: { stopReason: "cancelled" } });
    return;
  }
  update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " } });
  update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${text} [${session.model}/${session.effort}]` } });
  update(params.sessionId, { sessionUpdate: "session_info_update", title: `About ${text}` });
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    pendingAgentRequests.get(message.id)?.(message.result ?? {});
    pendingAgentRequests.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false },
        sessionCapabilities: { resume: {}, close: {} } }, _meta: process.env.MOCK_ACP_NO_MODEL_STATE ? {} : { modelState } } });
      return;
    case "session/new": {
      const sessionId = `native-${sessions.size + 1}`;
      sessions.set(sessionId, { cwd: params.cwd, history: [], model: "grok-a", effort: "medium" });
      send({ id, result: { sessionId, models: modelState, configOptions: config() } });
      return;
    }
    case "session/resume": {
      if (!params.sessionId.startsWith("known-")) { send({ id, error: { code: -32002, message: "session not found" } }); return; }
      sessions.set(params.sessionId, { cwd: params.cwd, history: [], model: "grok-b", effort: "medium" });
      send({ id, result: { configOptions: config("grok-b") } });
      return;
    }
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (params.configId === "model") session.model = params.value;
      if (params.configId === "reasoning_effort") session.effort = params.value;
      send({ id, result: { configOptions: config(session.model, session.effort) } });
      return;
    }
    case "session/prompt":
      void prompt(id, params);
      return;
    case "session/cancel":
      sessions.get(params.sessionId)?.cancel?.();
      return;
    case "session/close":
      send({ id, result: {} });
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown ${method}` } });
  }
});
