import { createInterface } from "node:readline";
import type { BridgeOps } from "./ops.js";

/**
 * `abctl mcp`: the same operations as the CLI, as an MCP server on stdio
 * (newline-delimited JSON-RPC). A tool call is synchronous, so ab_wait is bounded by
 * timeout_seconds and returns state "timeout" with a cursor to wait again from.
 */

const SESSION_ID = { type: "string", description: "Agent Bridge session id (from ab_sessions)." };
const MAX_WAIT_SECONDS = 1_800;

const TOOLS = [
  {
    name: "ab_workers",
    description: "List workers (agent@machine, e.g. claude@hal, codex@dev-wsl): online status and recent workspaces.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "ab_sessions",
    description: "List recent Agent Bridge sessions, newest first.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      active: { type: "boolean", description: "Only sessions with a running turn or a pending request." },
      worker_id: { type: "string" }, machine_id: { type: "string" }, workspace: { type: "string" },
      q: { type: "string", description: "Case-insensitive match on title, prompt and project name." },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    } },
  },
  {
    name: "ab_session",
    description: "One session: status, pending approvals/questions and its recent transcript (messages, turn results), oldest first.",
    inputSchema: { type: "object", required: ["session_id"], additionalProperties: false, properties: {
      session_id: SESSION_ID, events: { type: "integer", minimum: 1, maximum: 500, description: "Transcript entries; default 20." },
    } },
  },
  {
    name: "ab_create_session",
    description: "Start a new session on a worker. workspace is an absolute path or the name of one of the worker's recent workspaces. With input, the first turn starts at once; follow with ab_wait using the returned turn_id and cursor.",
    inputSchema: { type: "object", required: ["worker_id", "workspace"], additionalProperties: false, properties: {
      worker_id: { type: "string", description: "<codex|claude|pi>@<machine>" }, workspace: { type: "string" },
      input: { type: "string" }, model: { type: "string" },
    } },
  },
  {
    name: "ab_send",
    description: "Send a message to a session: starts a turn when idle, steers the running turn otherwise. Returns turn_id and cursor for ab_wait. Fails while an approval or question is pending; answer it first.",
    inputSchema: { type: "object", required: ["session_id", "input"], additionalProperties: false, properties: {
      session_id: SESSION_ID, input: { type: "string" },
      delivery: { type: "string", enum: ["auto", "steer", "start_turn"] },
      model: { type: "string" }, reasoning_effort: { type: "string" },
    } },
  },
  {
    name: "ab_wait",
    description: "Wait until the session needs attention: its turn completed/failed/interrupted (with the final message as summary), it asks for an approval or an answer, or it went offline. Pass turn_id and cursor from ab_send/ab_create_session. On state \"timeout\" call again with the returned cursor.",
    inputSchema: { type: "object", required: ["session_id"], additionalProperties: false, properties: {
      session_id: SESSION_ID, turn_id: { type: "string" }, cursor: { type: "string" },
      timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: "Default 240." },
    } },
  },
  {
    name: "ab_pending",
    description: "Pending approvals and questions, for one session or all.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      session_id: { type: "string" }, machine_id: { type: "string" },
    } },
  },
  {
    name: "ab_decide",
    description: "Resolve an approval. allow-session allows the whole tool for the rest of the session (every Bash command for Bash), not just this call.",
    inputSchema: { type: "object", required: ["approval_id", "choice"], additionalProperties: false, properties: {
      approval_id: { type: "string" }, choice: { type: "string", enum: ["allow", "deny", "allow-session"] },
    } },
  },
  {
    name: "ab_answer",
    description: "Answer a question (user-input request). Use answer for a request with one question, or answers keyed by question id.",
    inputSchema: { type: "object", required: ["request_id"], additionalProperties: false, properties: {
      request_id: { type: "string" }, answer: { type: "string" },
      answers: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
    } },
  },
  {
    name: "ab_interrupt",
    description: "Interrupt the session's running turn.",
    inputSchema: { type: "object", required: ["session_id"], additionalProperties: false, properties: { session_id: SESSION_ID } },
  },
] as const;

export async function serveMcp(ops: BridgeOps, input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout, version = "0"): Promise<void> {
  const write = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const running = new Set<Promise<void>>();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let request: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };
    try { request = JSON.parse(line); }
    catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse_error" } }); continue; }
    if (request.id === undefined) continue; // notifications
    const id = request.id;
    // Calls run concurrently so a long ab_wait does not block other tools.
    const task = handle(ops, request.method, request.params, version)
      .then((result) => { write({ jsonrpc: "2.0", id, result }); })
      .catch((error: unknown) => { write({ jsonrpc: "2.0", id, error: { code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof Error ? error.message : String(error) } }); })
      .finally(() => running.delete(task));
    running.add(task);
  }
  await Promise.all(running);
}

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }

async function handle(ops: BridgeOps, method: string | undefined, params: Record<string, any> | undefined, version: string): Promise<unknown> {
  if (method === "initialize") return {
    protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "agent-bridge", version },
    instructions: "Drive Agent Bridge worker sessions: ab_sessions/ab_session to find and read one, ab_create_session or ab_send to give it work, then ab_wait until it finishes or needs an approval/answer (ab_decide/ab_answer), and wait again. Irreversible or high-risk approvals belong to the human.",
  };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method !== "tools/call") throw new RpcError(-32601, "method_not_found");
  const args = (params?.arguments ?? {}) as Record<string, any>;
  try {
    const value = await callTool(ops, String(params?.name), args);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false };
  } catch (error) {
    const message = error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message}` : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function callTool(ops: BridgeOps, name: string, args: Record<string, any>): Promise<Record<string, unknown>> {
  const need = (key: string): string => {
    if (typeof args[key] !== "string" || !args[key]) throw new Error(`${key} is required`);
    return args[key];
  };
  switch (name) {
    case "ab_workers": return { workers: (await ops.workers()).map((worker) => ({ id: worker.id, name: worker.name,
      status: worker.status, activeSessions: worker.activeSessionCount,
      recentWorkspaces: (worker.recentWorkspaces ?? []).map((item: Record<string, unknown>) => ({ name: item.name, path: item.path })) })) };
    case "ab_sessions": return { sessions: await ops.sessions({ active: args.active, workerId: args.worker_id,
      machineId: args.machine_id, workspace: args.workspace, q: args.q, limit: args.limit }) };
    case "ab_session": return { ...await ops.session(need("session_id"), args.events) };
    case "ab_create_session": return { ...await ops.create({ workerId: need("worker_id"), workspace: need("workspace"),
      input: args.input, model: args.model }) };
    case "ab_send": return { ...await ops.send(need("session_id"), need("input"), { delivery: args.delivery,
      model: args.model, reasoningEffort: args.reasoning_effort }) };
    case "ab_wait": {
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(args.timeout_seconds ?? 240)));
      return { ...await ops.wait(need("session_id"), { turnId: args.turn_id, cursor: args.cursor, timeoutMs: seconds * 1_000 }) };
    }
    case "ab_pending": {
      const filter = { sessionId: args.session_id, machineId: args.machine_id };
      return { approvals: await ops.approvals(filter), userInput: await ops.userInput(filter) };
    }
    case "ab_decide": return { ...await ops.decide(need("approval_id"), need("choice") as "allow" | "deny" | "allow-session") };
    case "ab_answer": return { ...await ops.answer(need("request_id"), typeof args.answer === "string" ? args.answer : args.answers ?? {}) };
    case "ab_interrupt": return { ...await ops.interrupt(need("session_id")) };
    default: throw new Error(`unknown tool ${name}`);
  }
}
