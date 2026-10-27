export interface Worker {
  id: string; name: string; status: string; capabilities: string[];
  recentWorkspaces?: { name: string; path: string }[]; workspaces: string[];
}
export interface Session {
  sessionId: string; workerId: string; machineId: string; agent: string;
  title: string | null; promptSummary: string | null; projectName: string; workspace: string;
  status: string; activeTurnId: string | null; updatedAt: number; createdAt: number; lastPromptAt?: number | null;
  /** Agent replies so far; unread badges compare it with what this device last saw. */
  messageCount?: number;
  /** Moves with every change of the conversation view; above the held revision means fetch changes. */
  viewRevision?: number;
  pendingApprovalCount: number; pendingUserInputCount: number;
  capabilities?: string[]; historyCompleteness?: string; source?: string;
  error?: { error: { message: string } } | null;
}
export interface SessionEvent {
  eventId: string; cursor: string; sessionId: string; type: string; turnId: string | null; itemId?: string | null;
  timestamp: number; payload: Record<string, unknown>;
}
export interface Question {
  id: string; header?: string; question: string; isOther?: boolean; isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}
export interface Pending {
  id?: string; approvalId?: string; requestId?: string; sessionId: string; status: string;
  summary?: string; kind?: string; choices?: string[]; questions?: Question[];
}
export interface ModelInfo {
  id: string; model: string; displayName: string; isDefault?: boolean; defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}
export interface AttachmentRef { id: string; filename: string; mimeType: string; size: number }
export interface Action {
  actionId: string; kind: string; status: "accepted" | "succeeded" | "failed";
  sessionId: string | null; turnId: string | null;
  error: { error: { code: string; message: string; retryable: boolean } } | null;
}
export interface Page<T> { data: T[]; nextCursor: string | null; hasMore: boolean; streamCursor: string }
export interface Snapshot {
  sessions: Session[]; workers: Worker[]; approvals: Pending[]; userInput: Pending[];
  streamCursor: string; truncated: { sessions: boolean };
}
export interface Envelope {
  cursor: string; eventId: string; type: string; sessionId: string | null;
  resource: { kind: string; id: string }; data: unknown;
}
export const isLive = (s?: Session) => Boolean(s && ["creating", "active", "waiting_for_approval", "waiting_for_input"].includes(s.status));
export const pendingId = (p: Pending) => p.id ?? p.approvalId ?? p.requestId ?? "";
export const segment = encodeURIComponent;
