import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

/** A JSON-RPC error answered by the agent, or one we answer to the agent's request. */
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * JSON-RPC 2.0 over newline-delimited stdio, the transport of the Agent Client
 * Protocol (https://agentclientprotocol.com). Both sides send requests: we call
 * `session/*`, the agent calls back with `session/request_permission`.
 */
export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed?: Error;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: {
      notification: (method: string, params: Record<string, unknown>) => void;
      /** Answer an agent request; throw an AcpRpcError to answer with an error. */
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    },
  ) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    input.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      // Split on \n only: readline also splits on U+2028/U+2029 inside JSON strings.
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    input.on("end", () => this.close(new Error("agent closed its output")));
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Fail every outstanding request; later calls reject with `error`. */
  close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // agents may print banners; only JSON lines are protocol
    }
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : undefined;
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    if (method && id !== undefined && id !== null) {
      // An agent request; ids may be 0 or strings.
      void this.handlers.request(method, params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) => this.write({ jsonrpc: "2.0", id, error: error instanceof AcpRpcError
          ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
          : { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    if (method) {
      this.handlers.notification(method, params);
      return;
    }
    // A response; ids we never sent (agent-internal replies) are ignored.
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as number);
    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) pending.reject(new AcpRpcError(error.code ?? -32603, error.message ?? "ACP request failed", error.data));
    else pending.resolve(message.result ?? {});
  }

  private write(message: Record<string, unknown>): void {
    if (this.output.writable) this.output.write(`${JSON.stringify(message)}\n`);
  }
}
