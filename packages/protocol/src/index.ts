export const AGENT_STATUSES = [
  "starting",
  "update_waiting",
  "update_required",
  "update_failed",
  "working",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentType = "codex-cli" | "codex-desktop" | "claude-code" | "opencode";
export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * Short worker-id prefix per agent family. Worker ids are `${prefix}@${machineId}`.
 * Codex CLI/Desktop share the historical `codex` prefix for backward compatibility.
 */
export function workerPrefix(agentType: AgentType): string {
  switch (agentType) {
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    default:
      return "codex";
  }
}

/** Build a worker id, e.g. workerId("claude-code","hal") => "claude@hal". */
export function workerId(agentType: AgentType, machineId: string): string {
  return `${workerPrefix(agentType)}@${machineId}`;
}

/** Parse a worker id into its agent prefix and machine id, or undefined if malformed. */
export function parseWorkerId(id: string): { prefix: string; machineId: string } | undefined {
  const at = id.indexOf("@");
  if (at <= 0 || at === id.length - 1) return undefined;
  return { prefix: id.slice(0, at), machineId: id.slice(at + 1) };
}

export type SessionActivityStatus =
  | "creating" | "active" | "waiting_for_approval" | "waiting_for_input"
  | "idle" | "offline" | "error" | "unknown";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted" | "unknown";
export type PendingResolutionStatus = "pending" | "accepted" | "denied" | "resolved_elsewhere" | "expired";
export type ActionKind = "create_session" | "submit_turn" | "interrupt_turn"
  | "resolve_approval" | "resolve_user_input" | "delete_session";
export type ActionStatus = "accepted" | "succeeded" | "failed";

export type AgentEventType =
  | "agent.started"
  | "agent.output"
  | "agent.progress"
  | "agent.waiting"
  | "agent.blocked"
  | "agent.completed"
  | "agent.failed"
  | "agent.stopped";

export interface AgentEvent {
  type: AgentEventType;
  eventId?: string;
  sessionId: string;
  timestamp: number;
  text?: string;
  summary?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface SessionDiscoveredMessage {
  type: "session.discovered";
  requestId?: string;
  sessionId: string;
  nativeSessionId: string;
  agentType: AgentType;
  projectPath: string;
  projectName?: string;
  title?: string;
  promptSummary?: string;
  status: AgentStatus;
  createdAt: number;
  /** Last real thread activity. Inventory and reconnect time must not replace it. */
  updatedAt?: number;
  model?: string;
  /** Memory seam: stable cross-machine project key (e.g. derived from git remote). */
  projectIdentity?: string;
}

export interface RegisterMessage {
  type: "register";
  machineId: string;
  name: string;
  platform: NodeJS.Platform;
  hostname: string;
  capabilities: string[];
  bridgeVersion?: string;
  protocolVersion?: number;
  features?: string[];
  token?: string;
}

export interface RegisteredMessage {
  type: "registered";
  machineId: string;
}

export interface BridgeUpdateAnnouncementMessage {
  type: "bridge_update.available";
  latestVersion: string;
  source: string;
  publishedAt?: number;
  epoch?: string;
}

export interface BridgeUpdateCheckMessage {
  type: "bridge_update.check";
  currentVersion: string;
}

export type BridgeUpdatePhase =
  | "discovered"
  | "deferred"
  | "fetching"
  | "fetched"
  | "validating"
  | "restarting"
  | "completed"
  | "failed"
  | "rolled_back";

export interface BridgeUpdateStatusMessage {
  type: "bridge_update.status";
  phase: BridgeUpdatePhase;
  currentVersion: string;
  latestVersion: string;
  updatable: boolean;
  fetched: boolean;
  reason?: string;
}

export interface BridgeIdleMessage {
  type: "bridge.idle";
  machineId: string;
  timestamp: number;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  machineId: string;
  timestamp: number;
  activeSessionIds?: string[];
  waitingSessionIds?: string[];
  blockedSessionIds?: string[];
}

/**
 * Reference to an uploaded attachment (image/file) stored on the control-plane.
 * Messages carry refs, never the bytes; the bridge fetches bytes by id at send
 * time. Mirrors hapi's AttachmentMetadata (minus the host-local `path`).
 */
export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface StartAgentMessage {
  type: "start_agent";
  sessionId: string;
  resumeSessionId?: string;
  agentType: AgentType;
  projectPath: string;
  prompt?: string;
  model?: string;
  attachments?: AttachmentRef[];
}

export interface AgentInputMessage {
  type: "agent_input";
  sessionId: string;
  text: string;
  model?: string;
  attachments?: AttachmentRef[];
}

export interface StopAgentMessage {
  type: "stop_agent";
  sessionId: string;
}

export interface LogRequestMessage {
  type: "log_request";
  sessionId: string;
  lines: number;
}

export interface LogResponseMessage {
  type: "log_response";
  sessionId: string;
  text: string;
}

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
}
export interface ModelCatalogRequestMessage { type: "model_catalog_request"; requestId: string; }
export interface ModelCatalogResponseMessage {
  type: "model_catalog_response";
  requestId: string;
  models?: CodexModelInfo[];
  error?: string;
}

export type ApprovalKind = "command" | "file-change" | "permissions";
export type ApprovalChoice = "allow" | "deny" | "allow-session";

export interface ApprovalRequestMessage {
  type: "approval_request";
  sessionId: string;
  approvalId: string;
  kind: ApprovalKind;
  summary: string;
  choices: ApprovalChoice[];
  turnId?: string;
  requestedAt?: number;
}

export interface ApprovalResolvedMessage {
  type: "approval_resolved";
  sessionId: string;
  approvalId: string;
  choice?: ApprovalChoice;
  resolvedAt?: number;
}

export interface UserInputOption { label: string; description: string; }
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

export interface UserInputRequestMessage {
  type: "user_input_request";
  sessionId: string;
  requestId: string;
  turnId?: string;
  questions: UserInputQuestion[];
  requestedAt: number;
}

export interface UserInputResolvedMessage {
  type: "user_input_resolved";
  sessionId: string;
  requestId: string;
  resolvedAt: number;
}

export type SessionSource = "app-server" | "desktop-rollout" | "claude-cli";

export interface SessionState {
  sessionId: string;
  nativeSessionId: string;
  agentType: AgentType;
  projectPath: string;
  projectName: string;
  title?: string;
  promptSummary?: string;
  activityStatus: SessionActivityStatus;
  activeTurnId?: string;
  lastTurnStatus?: TurnStatus;
  createdAt: number;
  updatedAt: number;
  source: SessionSource;
  historyCompleteness: "full" | "loaded-only" | "terminal-only";
  /** Memory seam: stable cross-machine project key (e.g. derived from git remote). */
  projectIdentity?: string;
}

export interface StateSnapshotMessage {
  type: "state.snapshot";
  generation: string;
  sessions: SessionState[];
  approvals: Array<Omit<ApprovalRequestMessage, "type">>;
  userInputs: Array<Omit<UserInputRequestMessage, "type">>;
  complete: boolean;
}

export type StructuredSessionEventType =
  | "session.discovered" | "session.updated" | "turn.started" | "turn.completed"
  | "turn.failed" | "turn.interrupted" | "message.completed" | "command.completed"
  | "file_change.completed" | "progress" | "approval.requested" | "approval.resolved"
  | "user_input.requested" | "user_input.resolved" | "model.rerouted" | "context.updated" | "error";

export interface StructuredSessionEventMessage {
  type: "session.event";
  eventId: string;
  eventType: StructuredSessionEventType;
  sessionId: string;
  timestamp: number;
  turnId?: string;
  itemId?: string;
  payload: Record<string, unknown>;
}

export interface CreateSessionActionMessage {
  type: "action.create_session";
  actionId: string;
  agentType?: AgentType;
  projectPath: string;
  input?: string;
  model?: string;
  attachments?: AttachmentRef[];
}
export interface SubmitTurnActionMessage {
  type: "action.submit_turn";
  actionId: string;
  sessionId: string;
  input: string;
  delivery: "auto" | "steer" | "start_turn";
  expectedTurnId?: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: AttachmentRef[];
}
export interface InterruptTurnActionMessage {
  type: "action.interrupt_turn";
  actionId: string;
  sessionId: string;
  expectedTurnId?: string;
}
export interface ResolveApprovalActionMessage {
  type: "action.resolve_approval";
  actionId: string;
  sessionId: string;
  approvalId: string;
  choice: ApprovalChoice;
}
export interface ResolveUserInputActionMessage {
  type: "action.resolve_user_input";
  actionId: string;
  sessionId: string;
  requestId: string;
  answers: Record<string, { answers: string[] }>;
}
export interface DeleteSessionActionMessage {
  type: "action.delete_session";
  actionId: string;
  sessionId: string;
}
export interface ActionResultMessage {
  type: "action.result";
  actionId: string;
  kind: ActionKind;
  status: "succeeded" | "failed";
  sessionId?: string;
  turnId?: string;
  resolvedAction?: "steer" | "start_turn";
  error?: { code: string; message: string; retryable: boolean };
  timestamp: number;
}

export interface SessionDeletedMessage {
  type: "session.deleted";
  sessionId: string;
  timestamp: number;
}

export interface ApprovalResponseMessage {
  type: "approval_response";
  sessionId: string;
  approvalId: string;
  choice: ApprovalChoice;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  sessionId?: string;
  code?: "update_required" | "update_failed";
}

export type BridgeToControlMessage =
  | RegisterMessage
  | BridgeUpdateCheckMessage
  | BridgeUpdateStatusMessage
  | BridgeIdleMessage
  | HeartbeatMessage
  | SessionDiscoveredMessage
  | AgentEvent
  | ApprovalRequestMessage
  | ApprovalResolvedMessage
  | UserInputRequestMessage
  | UserInputResolvedMessage
  | StateSnapshotMessage
  | StructuredSessionEventMessage
  | SessionDeletedMessage
  | ActionResultMessage
  | LogResponseMessage
  | ModelCatalogResponseMessage
  | ErrorMessage;

export type ControlToBridgeMessage =
  | RegisteredMessage
  | BridgeUpdateAnnouncementMessage
  | StartAgentMessage
  | AgentInputMessage
  | ApprovalResponseMessage
  | CreateSessionActionMessage
  | SubmitTurnActionMessage
  | InterruptTurnActionMessage
  | ResolveApprovalActionMessage
  | ResolveUserInputActionMessage
  | DeleteSessionActionMessage
  | StopAgentMessage
  | LogRequestMessage
  | ModelCatalogRequestMessage
  | ErrorMessage;

export function parseMessage(raw: string): { type: string; [key: string]: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
      return undefined;
    }
    return value as { type: string; [key: string]: unknown };
  } catch {
    return undefined;
  }
}

export function statusForEvent(type: AgentEventType): AgentStatus | undefined {
  const statuses: Partial<Record<AgentEventType, AgentStatus>> = {
    "agent.started": "working",
    "agent.output": "working",
    "agent.progress": "working",
    "agent.waiting": "waiting",
    "agent.blocked": "blocked",
    "agent.completed": "completed",
    "agent.failed": "failed",
    "agent.stopped": "stopped",
  };
  return statuses[type];
}
