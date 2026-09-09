/**
 * Type definitions for the Claude Code stream-json integration.
 * Ported from hapi (cli/src/claude/sdk/types.ts); hapi-specific imports removed.
 */

/** Claude Code permission modes accepted by `--permission-mode`. */
export type ClaudePermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan";

/** Base shape of any newline-delimited JSON message on Claude's stdout. */
export interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

export interface SDKUserMessage extends SDKMessage {
  type: "user";
  parent_tool_use_id?: string;
  /**
   * Set by Claude Code on user-role messages it injects itself (skill bodies,
   * compact continuation summaries) rather than relaying from the human.
   */
  isSynthetic?: boolean;
  isMeta?: boolean;
  message: {
    role: "user";
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
          [key: string]: unknown;
        }>;
  };
}

export interface SDKAssistantMessage extends SDKMessage {
  type: "assistant";
  parent_tool_use_id?: string;
  message: {
    role: "assistant";
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      [key: string]: unknown;
    }>;
  };
}

export interface SDKSystemMessage extends SDKMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  slash_commands?: string[];
  compact_result?: string;
  compact_error?: string;
}

export interface SDKResultMessage extends SDKMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  result?: string;
  num_turns: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd: number;
  duration_ms: number;
  is_error: boolean;
  session_id: string;
}

export interface SDKControlResponse extends SDKMessage {
  type: "control_response";
  response: {
    request_id: string;
    subtype: "success" | "error";
    error?: string;
  };
}

/** Control request types (Claude → client, expecting a control_response). */
export interface ControlRequest {
  subtype: string;
}

export interface InterruptRequest extends ControlRequest {
  subtype: "interrupt";
}

export interface CanUseToolRequest extends ControlRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: unknown;
}

export interface CanUseToolControlRequest {
  type: "control_request";
  request_id: string;
  request: CanUseToolRequest;
}

export interface CanUseToolControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: PermissionResult;
    error?: string;
  };
}

export interface ControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

export interface SDKControlRequest {
  request_id: string;
  type: "control_request";
  request: ControlRequest;
}

/** Result returned from a canCallTool permission check. */
export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface CanCallToolCallback {
  (toolName: string, input: unknown, options: { signal: AbortSignal }): Promise<PermissionResult>;
}

export interface QueryOptions {
  abort?: AbortSignal;
  additionalArgs?: string[];
  additionalDirectories?: string[];
  allowedTools?: string[];
  appendSystemPrompt?: string;
  customSystemPrompt?: string;
  cwd?: string;
  disallowedTools?: string[];
  maxTurns?: number;
  mcpServers?: Record<string, unknown>;
  pathToClaudeCodeExecutable?: string;
  permissionMode?: ClaudePermissionMode;
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  model?: string;
  effort?: string;
  fallbackModel?: string;
  settingsPath?: string;
  strictMcpConfig?: boolean;
  canCallTool?: CanCallToolCallback;
  promptFailureCleanupTimeoutMs?: number;
}

export type QueryPrompt = string | AsyncIterable<SDKMessage>;

export type ControlResponseHandler = (response: SDKControlResponse["response"]) => void;

export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}
