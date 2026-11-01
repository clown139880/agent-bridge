import pino from "pino";
import { controlHttpBase } from "./attachments.js";
import { deriveProjectIdentity } from "./path-utils.js";

/** Core memory (_global plus the project scope) to add to a new session's instructions, or undefined. */
/** `scope` names the project explicitly (a chat room's scope); otherwise it is resolved from `cwd`. */
export type MemoryBootstrapFetcher = (cwd: string, scope?: string) => Promise<string | undefined>;

const TIMEOUT_MS = 2_000;
const log = pino({ name: "memory-bootstrap" });

/**
 * Ask the Control Plane for the memory of the project at `cwd`, so agents do not spend a tool call
 * (and an approval) on it every session. Any failure starts the session without memory.
 */
export function makeMemoryBootstrapFetcher(wsUrl: string, token: string | undefined, machineId: string): MemoryBootstrapFetcher {
  const base = controlHttpBase(wsUrl);
  return async (cwd, scope) => {
    const params = new URLSearchParams({ machine_id: machineId, cwd });
    if (scope) params.set("scope", scope);
    const repository = await deriveProjectIdentity(cwd);
    if (repository) params.set("repository", repository);
    try {
      const response = await fetch(`${base}/memory/bootstrap?${params}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) return undefined;  // memory is not enabled on this Control Plane
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { text?: unknown };
      return typeof body.text === "string" && body.text ? body.text : undefined;
    } catch (error) {
      log.warn({ error: String(error), cwd }, "Memory bootstrap unavailable; starting without it");
      return undefined;
    }
  };
}

/**
 * The session's own id, for its instructions: an agent passes it as `from_session_id` when it contacts
 * another session through /mcp/bridge, so that session can answer with `reply`.
 */
export function withSessionId(instructions: string | undefined, sessionId: string): string {
  const line = `本会话的 Agent Bridge session id 是 ${sessionId}。用 bridge 的 create/turn 找别的会话时把它作为 from_session_id 传入，对方才能用 reply 回复你。`;
  return instructions ? `${instructions}\n\n${line}` : line;
}
