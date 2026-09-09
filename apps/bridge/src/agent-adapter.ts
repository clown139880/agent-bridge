import type { ApprovalChoice, BridgeToControlMessage, CodexModelInfo, SessionState } from "@agent-bridge/protocol";

/**
 * Common surface every agent backend exposes to {@link BridgeClient}. Codex talks
 * to a long-lived App Server over WebSocket JSON-RPC; Claude Code spawns one CLI
 * subprocess per session. Both normalize their native protocol into the same
 * `BridgeToControlMessage` stream via the `emit` callback passed at construction.
 */
export interface AgentAdapter {
  /** Begin connecting / spawning. Resolves once ready (or keeps retrying internally). */
  start(): Promise<void>;
  /** Tear down connections/processes. */
  stop(): void;

  /** Start (or resume) a session for a project, optionally kicking off a first turn. Returns the native session id. */
  startSession(requestId: string, projectPath: string, prompt?: string, resumeSessionId?: string, model?: string): Promise<string>;
  /** Deliver free-form text to a session (answers pending input, steers an active turn, or starts a new turn). */
  input(sessionId: string, text: string, model?: string): Promise<void>;

  /** Idempotent action: create a session. */
  createSessionAction(actionId: string, projectPath: string, input?: string, model?: string): Promise<{ sessionId: string; turnId?: string }>;
  /** Idempotent action: submit a turn with explicit delivery semantics. */
  submitTurnAction(
    actionId: string,
    sessionId: string,
    text: string,
    delivery: "auto" | "steer" | "start_turn",
    expectedTurnId?: string,
    model?: string,
    reasoningEffort?: string,
  ): Promise<{ sessionId: string; turnId?: string; resolvedAction: "steer" | "start_turn" }>;
  /** Idempotent action: interrupt the active turn. */
  interruptAction(sessionId: string, expectedTurnId?: string): Promise<{ sessionId: string; turnId: string }>;
  /** Idempotent action: delete/forget a session. */
  deleteSessionAction(sessionId: string): Promise<{ sessionId: string }>;
  /** Answer a pending structured user-input request. */
  respondUserInput(sessionId: string, publicId: string, answers: Record<string, { answers: string[] }>): Promise<void>;

  /** List models available to this backend (empty when not applicable). */
  models(): Promise<CodexModelInfo[]>;
  /** Reconcile long-running activity after a heartbeat (no-op for stateless backends). */
  reconcileActivity(): Promise<void>;

  /** Full state snapshot for (re)connect. */
  stateSnapshot(): {
    sessions: SessionState[];
    approvals: Array<Record<string, unknown>>;
    userInputs: Array<Record<string, unknown>>;
  };

  /** Resolve a pending approval request. */
  approve(sessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void>;
  /** Interrupt the current turn of a session. */
  stopSession(sessionId: string): Promise<void>;
  /** Return the last `count` log lines captured for a session. */
  logs(sessionId: string, count: number): string;

  /** Whether any session is mid-turn / awaiting approval / awaiting input (blocks self-update). */
  hasActiveSessions(): boolean;
  /** Session-id buckets for heartbeat reporting. */
  sessionActivity(): { activeSessionIds: string[]; waitingSessionIds: string[]; blockedSessionIds: string[] };
  /** Whether the adapter is initialized enough to serve snapshots/actions. */
  isReady(): boolean;
}

/** Construction callback shared by all adapters: emit a normalized message upstream. */
export type AdapterEmit = (message: BridgeToControlMessage) => void;
