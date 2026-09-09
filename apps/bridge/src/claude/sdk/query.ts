/**
 * Spawns Claude Code as a child process and manages the bidirectional
 * stream-json protocol (message stream out, control_request/response for tool
 * permissions in). Ported from hapi (cli/src/claude/sdk/query.ts) with
 * hapi-internal deps (bunRuntime, mcpConfig, logger, shellEscape, process)
 * replaced by ./support.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import type { Writable } from "node:stream";
import { Stream } from "./stream.js";
import {
  AbortError,
  type CanCallToolCallback,
  type CanUseToolControlRequest,
  type CanUseToolControlResponse,
  type ControlCancelRequest,
  type ControlRequest,
  type ControlResponseHandler,
  type PermissionResult,
  type QueryOptions,
  type QueryPrompt,
  type SDKControlRequest,
  type SDKControlResponse,
  type SDKMessage,
} from "./types.js";
import {
  getDefaultClaudeCodePath,
  killProcessByChildProcess,
  logDebug,
  streamToStdin,
  stripNewlinesForWindowsShellArg,
} from "./support.js";

const DEFAULT_PROMPT_FAILURE_CLEANUP_TIMEOUT_MS = 3_000;

/**
 * Manages a single Claude Code subprocess as an AsyncIterableIterator of SDK
 * messages, plus the control-request/response permission protocol over stdin.
 */
export class Query implements AsyncIterableIterator<SDKMessage> {
  private pendingControlResponses = new Map<string, ControlResponseHandler>();
  private cancelControllers = new Map<string, AbortController>();
  private sdkMessages: AsyncIterableIterator<SDKMessage>;
  private inputStream = new Stream<SDKMessage>();
  private canCallTool?: CanCallToolCallback;
  private promptFailure: Error | null = null;

  constructor(
    private childStdin: Writable | null,
    private childStdout: NodeJS.ReadableStream,
    private processExitPromise: Promise<void>,
    canCallTool?: CanCallToolCallback,
  ) {
    this.canCallTool = canCallTool;
    void this.readMessages();
    this.sdkMessages = this.readSdkMessages();
  }

  setError(error: Error): void {
    this.inputStream.error(error);
  }

  registerPromptFailure(error: Error): boolean {
    if (this.promptFailure) return false;
    this.promptFailure = error;
    this.cleanupControllers();
    return true;
  }

  getPromptFailure(): Error | null {
    return this.promptFailure;
  }

  next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage>> {
    return this.sdkMessages.next(...args);
  }

  return(value?: unknown): Promise<IteratorResult<SDKMessage>> {
    if (this.sdkMessages.return) return this.sdkMessages.return(value);
    return Promise.resolve({ done: true, value: undefined });
  }

  throw(e?: unknown): Promise<IteratorResult<SDKMessage>> {
    if (this.sdkMessages.throw) return this.sdkMessages.throw(e);
    return Promise.reject(e);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
    return this.sdkMessages;
  }

  private async readMessages(): Promise<void> {
    const rl = createInterface({ input: this.childStdout });
    let hadError = false;
    try {
      for await (const line of rl) {
        if (this.promptFailure) break;
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as SDKMessage | SDKControlResponse;
          if (this.promptFailure) break;
          if (message.type === "control_response") {
            const controlResponse = message as SDKControlResponse;
            const handler = this.pendingControlResponses.get(controlResponse.response.request_id);
            if (handler) handler(controlResponse.response);
            continue;
          } else if (message.type === "control_request") {
            await this.handleControlRequest(message as unknown as CanUseToolControlRequest);
            continue;
          } else if (message.type === "control_cancel_request") {
            this.handleControlCancelRequest(message as unknown as ControlCancelRequest);
            continue;
          }
          this.inputStream.enqueue(message);
        } catch {
          logDebug(`[claude-sdk] non-JSON line: ${line.slice(0, 200)}`);
        }
      }
      await this.processExitPromise;
    } catch (error) {
      hadError = true;
      this.inputStream.error(error as Error);
    } finally {
      if (!hadError && !this.inputStream.hasTerminalError) this.inputStream.done();
      this.cleanupControllers();
      rl.close();
    }
  }

  private async *readSdkMessages(): AsyncIterableIterator<SDKMessage> {
    for await (const message of this.inputStream) yield message;
  }

  async interrupt(): Promise<void> {
    if (!this.childStdin) throw new Error("Interrupt requires --input-format stream-json");
    await this.request({ subtype: "interrupt" }, this.childStdin);
  }

  private request(request: ControlRequest, childStdin: Writable): Promise<SDKControlResponse["response"]> {
    const requestId = Math.random().toString(36).substring(2, 15);
    const sdkRequest: SDKControlRequest = { request_id: requestId, type: "control_request", request };
    return new Promise((resolve, reject) => {
      this.pendingControlResponses.set(requestId, (response) => {
        if (response.subtype === "success") resolve(response);
        else reject(new Error(response.error));
      });
      childStdin.write(JSON.stringify(sdkRequest) + "\n");
    });
  }

  private async handleControlRequest(request: CanUseToolControlRequest): Promise<void> {
    if (!this.childStdin) {
      logDebug("Cannot handle control request - no stdin available");
      return;
    }
    const controller = new AbortController();
    this.cancelControllers.set(request.request_id, controller);
    try {
      const response = await this.processControlRequest(request, controller.signal);
      if (this.promptFailure || controller.signal.aborted || !this.childStdin?.writable) return;
      const controlResponse: CanUseToolControlResponse = {
        type: "control_response",
        response: { subtype: "success", request_id: request.request_id, response },
      };
      this.childStdin.write(JSON.stringify(controlResponse) + "\n");
    } catch (error) {
      if (this.promptFailure || controller.signal.aborted || !this.childStdin?.writable) return;
      const controlErrorResponse: CanUseToolControlResponse = {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: request.request_id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      this.childStdin.write(JSON.stringify(controlErrorResponse) + "\n");
    } finally {
      this.cancelControllers.delete(request.request_id);
    }
  }

  private handleControlCancelRequest(request: ControlCancelRequest): void {
    const controller = this.cancelControllers.get(request.request_id);
    if (controller) {
      controller.abort();
      this.cancelControllers.delete(request.request_id);
    }
  }

  private async processControlRequest(
    request: CanUseToolControlRequest,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (request.request.subtype === "can_use_tool") {
      if (!this.canCallTool) throw new Error("canCallTool callback is not provided.");
      return this.canCallTool(request.request.tool_name, request.request.input, { signal });
    }
    throw new Error("Unsupported control request subtype: " + request.request.subtype);
  }

  private cleanupControllers(): void {
    for (const [requestId, controller] of this.cancelControllers.entries()) {
      controller.abort();
      this.cancelControllers.delete(requestId);
    }
  }
}

/** Spawn Claude Code and return a Query over its message stream. */
export function query(config: { prompt: QueryPrompt; options?: QueryOptions }): Query {
  const {
    prompt,
    options: {
      additionalArgs = [],
      additionalDirectories = [],
      allowedTools = [],
      appendSystemPrompt,
      customSystemPrompt,
      cwd,
      disallowedTools = [],
      maxTurns,
      pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
      permissionMode = "default",
      continue: continueConversation,
      resume,
      forkSession,
      model,
      effort,
      fallbackModel,
      settingsPath,
      strictMcpConfig,
      canCallTool,
      promptFailureCleanupTimeoutMs = DEFAULT_PROMPT_FAILURE_CLEANUP_TIMEOUT_MS,
    } = {},
  } = config;

  if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
    process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  }

  const args = ["--output-format", "stream-json", "--verbose"];

  if (customSystemPrompt) args.push("--system-prompt", stripNewlinesForWindowsShellArg(customSystemPrompt));
  if (appendSystemPrompt) args.push("--append-system-prompt", stripNewlinesForWindowsShellArg(appendSystemPrompt));
  if (maxTurns) args.push("--max-turns", maxTurns.toString());
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);

  if (canCallTool) {
    if (typeof prompt === "string") {
      throw new Error(
        "canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable.",
      );
    }
    args.push("--permission-prompt-tool", "stdio");
  }

  if (continueConversation) args.push("--continue");
  if (resume) args.push("--resume", resume);
  if (forkSession) args.push("--fork-session");
  args.push(...additionalArgs);
  if (settingsPath) args.push("--settings", settingsPath);
  if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));
  if (additionalDirectories.length > 0) args.push("--add-dir", ...additionalDirectories);
  if (strictMcpConfig) args.push("--strict-mcp-config");
  if (permissionMode) args.push("--permission-mode", permissionMode);

  if (fallbackModel) {
    if (model && fallbackModel === model) {
      throw new Error(
        "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.",
      );
    }
    args.push("--fallback-model", fallbackModel);
  }

  if (typeof prompt === "string") {
    args.push("--print", stripNewlinesForWindowsShellArg(prompt.trim()));
  } else {
    args.push("--input-format", "stream-json");
  }

  const isCommandOnly = !pathToClaudeCodeExecutable.includes("/");
  if (!isCommandOnly && !existsSync(pathToClaudeCodeExecutable)) {
    throw new ReferenceError(
      `Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is CLAUDE_COMMAND set?`,
    );
  }

  logDebug(`Spawning Claude Code process: ${pathToClaudeCodeExecutable} ${args.join(" ")}`);

  const child = spawn(pathToClaudeCodeExecutable, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    signal: config.options?.abort,
    env: process.env,
    shell: false,
  }) as ChildProcessWithoutNullStreams;

  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const processExitPromise = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  let childStdin: Writable | null = null;
  if (typeof prompt === "string") {
    child.stdin.end();
  } else {
    childStdin = child.stdin;
  }

  if (process.env.DEBUG) {
    child.stderr.on("data", (data) => {
      console.error("Claude Code stderr:", data.toString());
    });
  }

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await killProcessByChildProcess(child);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    })();
    return cleanupPromise;
  };

  const handleAbort = () => void cleanup();
  const handleProcessExit = () => void cleanup();
  config.options?.abort?.addEventListener("abort", handleAbort);
  process.on("exit", handleProcessExit);

  const queryInstance = new Query(childStdin, child.stdout, processExitPromise, canCallTool);

  if (typeof prompt !== "string") {
    void streamToStdin(prompt, child.stdin, config.options?.abort).catch(async (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!queryInstance.registerPromptFailure(err)) return;
      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) => setTimeout(resolve, promptFailureCleanupTimeoutMs)),
      ]);
      queryInstance.setError(err);
      rejectExit(err);
    });
  }

  child.on("close", (code) => {
    const promptFailure = queryInstance.getPromptFailure();
    if (promptFailure) {
      rejectExit(promptFailure);
    } else if (config.options?.abort?.aborted) {
      const err = new AbortError("Claude Code process aborted by user");
      queryInstance.setError(err);
      rejectExit(err);
    } else if (code !== 0) {
      const err = new Error(`Claude Code process exited with code ${code}`);
      queryInstance.setError(err);
      rejectExit(err);
    } else {
      resolveExit();
    }
  });

  child.on("error", (error) => {
    const promptFailure = queryInstance.getPromptFailure();
    if (promptFailure) {
      rejectExit(promptFailure);
    } else if (config.options?.abort?.aborted) {
      const err = new AbortError("Claude Code process aborted by user");
      queryInstance.setError(err);
      rejectExit(err);
    } else {
      const err = new Error(`Failed to spawn Claude Code process: ${error.message}`);
      queryInstance.setError(err);
      rejectExit(err);
    }
  });

  processExitPromise
    .catch(() => {})
    .finally(() => {
      void cleanup();
      process.removeListener("exit", handleProcessExit);
      config.options?.abort?.removeEventListener("abort", handleAbort);
    });

  return queryInstance;
}
