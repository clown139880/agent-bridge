import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentControlApi } from "../api/router.js";
import { ApiProblem } from "../api/validation.js";

export type Json = Record<string, any>;
export interface MatrixControl {
  call(sender: string, path: string, body?: Json, key?: string): Promise<Json>;
}

/** Trusted frontend dispatch; all normal validation, idempotency and approval CAS still apply. */
export class MatrixControlApi implements MatrixControl {
  constructor(private readonly api: AgentControlApi) {}
  async call(sender: string, path: string, body?: Json, key?: string): Promise<Json> {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
    request.method = body === undefined ? "GET" : "POST";
    request.headers = { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) };
    let status = 200, value: Json = {};
    const response = {
      writeHead(code: number) { status = code; },
      end(content: string) { value = content ? JSON.parse(String(content)) : {}; },
    } as unknown as ServerResponse;
    await this.api.handle(request, response, { principal: { id: `control:matrix:${sender}`, read: true, write: true },
      url: new URL(`/api/v1${path}`, "http://matrix.internal") });
    if (status >= 400) throw new ApiProblem(status, value.error?.code ?? "api_error", value.error?.message ?? "API error", value.error?.retryable);
    return value;
  }
}
