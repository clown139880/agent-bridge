export const AGENT_STATUSES = [
  "starting",
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
  agentType: "codex-cli" | "codex-desktop";
  projectPath: string;
  projectName?: string;
  title?: string;
  promptSummary?: string;
  status: AgentStatus;
  createdAt: number;
}

export interface RegisterMessage {
  type: "register";
  machineId: string;
  name: string;
  platform: NodeJS.Platform;
  hostname: string;
  capabilities: string[];
  token?: string;
}

export interface RegisteredMessage {
  type: "registered";
  machineId: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  machineId: string;
  timestamp: number;
  activeSessionIds?: string[];
  waitingSessionIds?: string[];
  blockedSessionIds?: string[];
}

export interface StartAgentMessage {
  type: "start_agent";
  sessionId: string;
  resumeSessionId?: string;
  agentType: "codex-cli";
  projectPath: string;
  prompt?: string;
}

export interface AgentInputMessage {
  type: "agent_input";
  sessionId: string;
  text: string;
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

export type ApprovalKind = "command" | "file-change" | "permissions";
export type ApprovalChoice = "allow" | "deny" | "allow-session";

export interface ApprovalRequestMessage {
  type: "approval_request";
  sessionId: string;
  approvalId: string;
  kind: ApprovalKind;
  summary: string;
  choices: ApprovalChoice[];
}

export interface ApprovalResolvedMessage {
  type: "approval_resolved";
  sessionId: string;
  approvalId: string;
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
}

export type BridgeToControlMessage =
  | RegisterMessage
  | HeartbeatMessage
  | SessionDiscoveredMessage
  | AgentEvent
  | ApprovalRequestMessage
  | ApprovalResolvedMessage
  | LogResponseMessage
  | ErrorMessage;

export type ControlToBridgeMessage =
  | RegisteredMessage
  | StartAgentMessage
  | AgentInputMessage
  | ApprovalResponseMessage
  | StopAgentMessage
  | LogRequestMessage
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
