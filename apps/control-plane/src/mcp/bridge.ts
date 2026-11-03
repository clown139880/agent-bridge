import type { AgentControlApi } from "../api/router.js";
import { ControlClient } from "./bridge-client.js";
import { BridgeOps } from "./bridge-ops.js";
import { PAIR_MESSAGES_PER_DAY, type SessionContacts } from "./contacts.js";
import type { McpEndpoint, McpTool } from "./route.js";

/**
 * /mcp/bridge: drive worker sessions from another agent (Hermes, Claude, Codex).
 * It replaces the abctl CLI and its stdio MCP server. Every operation calls the
 * Control API over loopback with the caller's own token, so /api/v1 stays the
 * single place that authorizes, records idempotent actions and audits.
 */

export interface BridgePrincipal { write: boolean; authorization: string; id?: string }

/** Who is calling from where: the session of `principal` that is calling `tool` right now, and the room a session reports to. */
export interface CallerLookup {
  session(principal: string, tool: string): Promise<string | undefined>;
  room(sessionId: string): string | undefined;
}

const SESSION_ID = { type: "string", description: "Agent Bridge session id (from sessions)." };
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 600;
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", ...(required.length ? { required } : {}), additionalProperties: false, properties });

export const BRIDGE_INSTRUCTIONS = "Drive Agent Bridge worker sessions: sessions/session to find and read one, create or turn to give it work, then wait until it finishes or needs an approval/answer (approve/answer), and wait again. Irreversible or high-risk approvals belong to the human. Pass your own session id as from_session_id so the other session can answer you with reply.";

const FROM_SESSION = { type: "string", description: "Your own Agent Bridge session id (in your system prompt, or AGENT_BRIDGE_SESSION_ID). With it the other session can answer you with reply; its answer arrives as a new message in your session." };

/** Where a session runs, for the line that introduces its message. */
async function introduce(client: ControlClient, sessionId: string): Promise<string> {
  const session = await client.get(`/sessions/${encodeURIComponent(sessionId)}`);
  return `${sessionId}（${session.workerId ?? "?"} · ${session.workspace ?? "?"}${session.title ? ` · ${String(session.title).slice(0, 40)}` : ""}）`;
}

export function bridgeTools(apiBase: () => string, contacts?: SessionContacts, notify?: (text: string) => void, caller?: CallerLookup): Array<McpTool<BridgePrincipal>> {
  const ops = (principal: BridgePrincipal) =>
    new BridgeOps(new ControlClient({ url: apiBase(), token: principal.authorization.slice(7) }));
  const client = (principal: BridgePrincipal) => new ControlClient({ url: apiBase(), token: principal.authorization.slice(7) });
  const read = () => true;
  const write = (principal: BridgePrincipal) => principal.write;
  const need = (args: Record<string, any>, key: string): string => {
    if (typeof args[key] !== "string" || !args[key]) throw new Error(`${key} is required`);
    return args[key];
  };
  /** A message between sessions may not exceed the pair's daily limit; the one over it goes to the human. */
  const withinLimit = (a: string, b: string) => {
    if (contacts!.exchanged(a, b) < PAIR_MESSAGES_PER_DAY) return;
    notify?.(`🔁 两个会话今天已来回 ${PAIR_MESSAGES_PER_DAY} 条消息，已暂停它们之间的对话：${a} ↔ ${b}`);
    throw Object.assign(new Error(`these two sessions exchanged ${PAIR_MESSAGES_PER_DAY} messages today; the person was told, stop and report instead`), { code: "pair_limit" });
  };
  /** The caller's own session: as given, or found from the call itself (so Codex, which cannot know its id, is covered). */
  const fromSession = async (args: Record<string, any>, principal: BridgePrincipal, tool: string): Promise<string | undefined> =>
    typeof args.from_session_id === "string" && args.from_session_id ? args.from_session_id
      : principal.id && caller ? await caller.session(principal.id, tool) : undefined;
  /** The line a message from another session starts with: who sent it and how to answer. */
  const contactInput = async (principal: BridgePrincipal, from: string, to: string | undefined, input: string) => {
    if (!contacts) return { input, key: undefined };
    if (from === to) throw Object.assign(new Error("from_session_id is the session you are sending to"), { code: "invalid_parameter" });
    if (to) withinLimit(from, to);
    const sender = await introduce(client(principal), from);
    const key = contacts.open(from, to);
    return { key, input: `[Agent Bridge 会话消息] 来自另一个会话 ${sender}。需要回复时调用 bridge 的 reply 工具（reply_key: ${key}），不必回复就不回。以下是它的消息：\n\n${input}` };
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
        input: { type: "string" }, model: { type: "string" }, from_session_id: FROM_SESSION,
      }, ["worker_id", "workspace"]),
      run: async (args: Record<string, any>, principal) => {
        const from = typeof args.input === "string" && args.input ? await fromSession(args, principal, "create") : undefined;
        const contact = from ? await contactInput(principal, from, undefined, args.input) : { input: args.input, key: undefined };
        const created = await ops(principal).create({ workerId: need(args, "worker_id"), workspace: need(args, "workspace"), input: contact.input, model: args.model });
        if (contact.key) contacts!.bind(contact.key, created.sessionId);
        return { ...created };
      },
    },
    {
      name: "turn", legacy: "ab_send", allowed: write,
      description: "Send a message to a session: starts a turn when idle, steers the running turn otherwise. Returns turn_id and cursor for wait. Fails while an approval or question is pending; answer it first.",
      inputSchema: object({
        session_id: SESSION_ID, input: { type: "string" },
        delivery: { type: "string", enum: ["auto", "steer", "start_turn"] },
        model: { type: "string" }, reasoning_effort: { type: "string" }, from_session_id: FROM_SESSION,
      }, ["session_id", "input"]),
      run: async (args: Record<string, any>, principal) => {
        const to = need(args, "session_id");
        const from = await fromSession(args, principal, "turn");
        // A session sending to itself by name is a mistake; one found to be the target is just not another session.
        const contact = from && (from !== to || args.from_session_id) ? await contactInput(principal, from, to, need(args, "input")) : { input: need(args, "input"), key: undefined };
        return { ...await ops(principal).send(to, contact.input, { delivery: args.delivery, model: args.model, reasoningEffort: args.reasoning_effort }) };
      },
    },
    ...(contacts ? [{
      name: "reply", allowed: write,
      description: "Answer a message another session sent you: pass the reply_key its first line names. Your answer arrives in that session as a new message (joining its running turn, or starting one), with a new key it can answer in turn. Needs no approval. Fails while that session waits on an approval or a question; try again later.",
      inputSchema: object({ reply_key: { type: "string" }, input: { type: "string" } }, ["reply_key", "input"]),
      run: async (args: Record<string, any>, principal: BridgePrincipal) => {
        const contact = contacts.answer(need(args, "reply_key"));
        withinLimit(contact.to, contact.from);
        const sender = await introduce(client(principal), contact.to);
        const key = contacts.open(contact.to, contact.from);
        const sent = await ops(principal).send(contact.from, `[Agent Bridge 会话回复] 会话 ${sender} 回复了你发给它的消息。需要再回复时调用 bridge 的 reply 工具（reply_key: ${key}），不必回复就不回。以下是它的回复：\n\n${need(args, "input")}`);
        contacts.replied(contact.key);
        return { delivered: true, sessionId: contact.from, turnId: sent.turnId, delivery: sent.delivery };
      },
    } satisfies McpTool<BridgePrincipal>] : []),
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
      name: "automation_list", allowed: read,
      description: "Scheduled and webhook tasks: id, title, trigger, next run, last run status.",
      inputSchema: object({}),
      run: async (_args, principal) => ({ automations: (await client(principal).get("/automations")).data }),
    },
    {
      name: "automation_runs", allowed: read,
      description: "One task: its definition and recent runs (status, output, error, session).",
      inputSchema: object({ id: { type: "string" } }, ["id"]),
      run: async (args: Record<string, any>, principal) => ({ ...await client(principal).get(`/automations/${encodeURIComponent(need(args, "id"))}`) }),
    },
    {
      name: "automation_propose", allowed: write,
      description: "Create, change or delete a scheduled/webhook task. A reviewer checks it; most take effect at once, the rest wait for the human (the result says which). definition: {title, trigger: {schedule: {cron | everyMinutes, tz?}} | {at: \"2026-11-06 14:00\", tz?} (once; then done) | {webhook: {secretRef?, template?}}, and one of: session: {id: \"self\" | <session id>, note} (at the time, wake that session with your note; you have the context, so no prompt; a busy session gets it in its running turn) | room: {to: \"self\" | \"matrix:!room:server\", text?, agent?} (post to a room; when agent renders truthy, the room's current session handles it) | agent: {prompt, agent?, model?, target?} (a new session) | script: {path, cwd?} (an existing script) | template; plus deliver?: [\"app\" | \"matrix:!room:server\" | \"call:<who>\"], level?. Output starting with [SILENT] is not delivered. To be reminded later yourself, use trigger.at with session: {id: self, note}. For a system that pushes messages into your room: trigger: {webhook: {}}, room: {to: self, text: \"{text}\", agent: \"{agent}\"}; the result lists the hook URLs (POST JSON there; no secret is needed on this machine or the LAN), so wire the caller to one and try it with curl.",
      inputSchema: object({
        action: { type: "string", enum: ["create", "update", "delete"] }, id: { type: "string", description: "lowercase slug" },
        scope: { type: "string", description: "memory scope (new tasks)" }, definition: { type: "object" }, reason: { type: "string" },
        from_session_id: FROM_SESSION,
      }, ["action", "id"]),
      run: async (args: Record<string, any>, principal) => {
        // `session: self` / `room: { to: self }` name the proposing session, or the room it reports to.
        let definition = args.definition && typeof args.definition === "object" ? { ...args.definition } : args.definition;
        if (definition?.session?.id === "self" || definition?.room?.to === "self") {
          const self = await fromSession(args, principal, "automation_propose");
          if (!self) throw new Error("could not tell which session is calling; pass from_session_id, or name the session id");
          if (definition.session?.id === "self") definition = { ...definition, session: { ...definition.session, id: self } };
          if (definition.room?.to === "self") {
            const room = caller?.room(self);
            if (!room) throw new Error("this session reports to no chat room; use session: self instead");
            definition = { ...definition, room: { ...definition.room, to: room } };
          }
        }
        const result = await client(principal).post("/automations/proposals",
          { action: args.action, id: args.id, scope: args.scope, definition, reason: args.reason });
        // A webhook task in effect: say where to call it, so the agent can wire its caller and try it at once.
        if (result.status === "applied" && definition?.trigger?.webhook) {
          const task = await client(principal).get(`/automations/${encodeURIComponent(String(args.id))}`).catch(() => undefined);
          if (task?.hooks?.length) return { ...result, hooks: task.hooks,
            howToCall: "POST JSON to one of hooks (127.0.0.1 from the same machine); its fields fill the templates, e.g. {\"text\": \"…\", \"agent\": true}. Try it now with curl and check the room." };
        }
        return { ...result };
      },
    },
    {
      name: "automation_run", allowed: write,
      description: "Run a confirmed task now, whatever its schedule.",
      inputSchema: object({ id: { type: "string" } }, ["id"]),
      run: async (args: Record<string, any>, principal) => ({ ...await client(principal).post(`/automations/${encodeURIComponent(need(args, "id"))}/run`, {}) }),
    },
    {
      name: "automation_pause", allowed: write,
      description: "Pause (paused=true) or resume a confirmed task.",
      inputSchema: object({ id: { type: "string" }, paused: { type: "boolean" } }, ["id", "paused"]),
      run: async (args: Record<string, any>, principal) => ({ ...await client(principal).post(
        `/automations/${encodeURIComponent(need(args, "id"))}/${args.paused === false ? "resume" : "pause"}`, {}) }),
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
export function bridgeEndpoint(api: AgentControlApi, apiBase: () => string, contacts?: SessionContacts, notify?: (text: string) => void, caller?: CallerLookup): McpEndpoint<BridgePrincipal> {
  return { name: "agent-bridge", version: "0.7.0", instructions: BRIDGE_INSTRUCTIONS,
    authenticate: (authorization) => {
      const principal = api.principalFor(authorization);
      return principal && principal.id !== "bridge" && principal.read ? { write: principal.write, authorization: authorization!, id: principal.id } : undefined;
    },
    tools: bridgeTools(apiBase, contacts, notify, caller) };
}
