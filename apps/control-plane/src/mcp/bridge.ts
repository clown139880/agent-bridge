import type { AgentControlApi } from "../api/router.js";
import { ControlClient } from "./bridge-client.js";
import { BridgeOps } from "./bridge-ops.js";
import type { McpEndpoint, McpTool } from "./route.js";

/**
 * /mcp/bridge: drive worker sessions from another agent (Hermes, Claude, Codex).
 * It replaces the abctl CLI and its stdio MCP server. Every operation calls the
 * Control API over loopback with the caller's own token, so /api/v1 stays the
 * single place that authorizes, records idempotent actions and audits.
 */

export interface BridgePrincipal { write: boolean; authorization: string }

const SESSION_ID = { type: "string", description: "Agent Bridge session id (from sessions)." };
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 600;
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", ...(required.length ? { required } : {}), additionalProperties: false, properties });

export const BRIDGE_INSTRUCTIONS = "Drive Agent Bridge worker sessions: sessions/session to find and read one, create or turn to give it work, then wait until it finishes or needs an approval/answer (approve/answer), and wait again. Irreversible or high-risk approvals belong to the human.";

export function bridgeTools(apiBase: () => string): Array<McpTool<BridgePrincipal>> {
  const ops = (principal: BridgePrincipal) =>
    new BridgeOps(new ControlClient({ url: apiBase(), token: principal.authorization.slice(7) }));
  const read = () => true;
  const write = (principal: BridgePrincipal) => principal.write;
  const need = (args: Record<string, any>, key: string): string => {
    if (typeof args[key] !== "string" || !args[key]) throw new Error(`${key} is required`);
    return args[key];
  };
  return [
    {
      name: "workers", legacy: "ab_workers", allowed: read,
      description: "List workers (agent@machine, e.g. claude@hal, codex@dev-wsl): online status and recent workspaces.",
      inputSchema: object({}),
      run: async (_args, principal) => ({ workers: (await ops(principal).workers()).map((worker) => ({ id: worker.id, name: worker.name,
        status: worker.status, activeSessions: worker.activeSessionCount,
        recentWorkspaces: (worker.recentWorkspaces ?? []).map((item: Record<string, unknown>) => ({ name: item.name, path: item.path })) })) }),
    },
    {
      name: "sessions", legacy: "ab_sessions", allowed: read,
      description: "List recent Agent Bridge sessions, newest first.",
      inputSchema: object({
        active: { type: "boolean", description: "Only sessions with a running turn or a pending request." },
        worker_id: { type: "string" }, machine_id: { type: "string" }, workspace: { type: "string" },
        q: { type: "string", description: "Case-insensitive match on title, prompt and project name." },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      }),
      run: async (args: Record<string, any>, principal) => ({ sessions: await ops(principal).sessions({ active: args.active,
        workerId: args.worker_id, machineId: args.machine_id, workspace: args.workspace, q: args.q, limit: args.limit }) }),
    },
    {
      name: "session", legacy: "ab_session", allowed: read,
      description: "One session: status, pending approvals/questions and its recent transcript (messages, turn results), oldest first.",
      inputSchema: object({
        session_id: SESSION_ID, events: { type: "integer", minimum: 1, maximum: 500, description: "Transcript entries; default 20." },
      }, ["session_id"]),
      run: async (args: Record<string, any>, principal) => ({ ...await ops(principal).session(need(args, "session_id"), args.events) }),
    },
    {
      name: "pending", legacy: "ab_pending", allowed: read,
      description: "Pending approvals and questions, for one session or all.",
      inputSchema: object({ session_id: { type: "string" }, machine_id: { type: "string" } }),
      run: async (args: Record<string, any>, principal) => {
        const filter = { sessionId: args.session_id, machineId: args.machine_id }, bridge = ops(principal);
        return { approvals: await bridge.approvals(filter), userInput: await bridge.userInput(filter) };
      },
    },
    {
      name: "wait", legacy: "ab_wait", allowed: read,
      description: `Wait until the session needs attention: its turn completed/failed/interrupted (with the final message as summary), it asks for an approval or an answer, or it went offline. Pass turn_id and cursor from turn/create. On state "timeout" call again with the returned cursor.`,
      inputSchema: object({
        session_id: SESSION_ID, turn_id: { type: "string" }, cursor: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: `Default ${DEFAULT_WAIT_SECONDS}.` },
      }, ["session_id"]),
      run: async (args: Record<string, any>, principal, signal) => {
        const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(args.timeout_seconds ?? DEFAULT_WAIT_SECONDS)));
        return { ...await ops(principal).wait(need(args, "session_id"), { turnId: args.turn_id, cursor: args.cursor,
          timeoutMs: seconds * 1_000, signal }) };
      },
    },
    {
      name: "create", legacy: "ab_create_session", allowed: write,
      description: "Start a new session on a worker. workspace is an absolute path or the name of one of the worker's recent workspaces. With input, the first turn starts at once; follow with wait using the returned turn_id and cursor.",
      inputSchema: object({
        worker_id: { type: "string", description: "<codex|claude|pi>@<machine>" }, workspace: { type: "string" },
        input: { type: "string" }, model: { type: "string" },
      }, ["worker_id", "workspace"]),
      run: async (args: Record<string, any>, principal) => ({ ...await ops(principal).create({ workerId: need(args, "worker_id"),
        workspace: need(args, "workspace"), input: args.input, model: args.model }) }),
    },
    {
      name: "turn", legacy: "ab_send", allowed: write,
      description: "Send a message to a session: starts a turn when idle, steers the running turn otherwise. Returns turn_id and cursor for wait. Fails while an approval or question is pending; answer it first.",
      inputSchema: object({
        session_id: SESSION_ID, input: { type: "string" },
        delivery: { type: "string", enum: ["auto", "steer", "start_turn"] },
        model: { type: "string" }, reasoning_effort: { type: "string" },
      }, ["session_id", "input"]),
      run: async (args: Record<string, any>, principal) => ({ ...await ops(principal).send(need(args, "session_id"), need(args, "input"),
        { delivery: args.delivery, model: args.model, reasoningEffort: args.reasoning_effort }) }),
    },
    {
      name: "approve", legacy: "ab_decide", allowed: write,
      description: "Resolve an approval. allow-session allows the whole tool for the rest of the session (every Bash command for Bash), not just this call.",
      inputSchema: object({
        approval_id: { type: "string" }, choice: { type: "string", enum: ["allow", "deny", "allow-session"] },
      }, ["approval_id", "choice"]),
      run: async (args: Record<string, any>, principal) => ({ ...await ops(principal).decide(need(args, "approval_id"),
        need(args, "choice") as "allow" | "deny" | "allow-session") }),
    },
    {
      name: "answer", legacy: "ab_answer", allowed: write,
      description: "Answer a question (user-input request). Use answer for a request with one question, or answers keyed by question id.",
      inputSchema: object({
        request_id: { type: "string" }, answer: { type: "string" },
        answers: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
      }, ["request_id"]),
      run: async (args: Record<string, any>, principal) => ({ ...await ops(principal).answer(need(args, "request_id"),
        typeof args.answer === "string" ? args.answer : args.answers ?? {}) }),
    },
    {
      name: "interrupt", legacy: "ab_interrupt", allowed: write,
      description: "Interrupt the session's running turn.",
      inputSchema: object({ session_id: SESSION_ID }, ["session_id"]),
      run: async (args: Record<string, any>, principal) => ({ ...await ops(principal).interrupt(need(args, "session_id")) }),
    },
  ];
}

/** Any Control API token except the Bridge registration token; a read token sees only the read tools. */
export function bridgeEndpoint(api: AgentControlApi, apiBase: () => string): McpEndpoint<BridgePrincipal> {
  return { name: "agent-bridge", version: "0.7.0", instructions: BRIDGE_INSTRUCTIONS,
    authenticate: (authorization) => {
      const principal = api.principalFor(authorization);
      return principal && principal.id !== "bridge" && principal.read ? { write: principal.write, authorization: authorization! } : undefined;
    },
    tools: bridgeTools(apiBase) };
}
