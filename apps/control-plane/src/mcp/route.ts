import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import pino from "pino";

const log = pino({ name: "mcp" });

export type JsonSchema = Record<string, unknown>;

/** One MCP tool. `run` returns the structured result; a thrown Error's message becomes the tool error. */
export interface McpTool<P> {
  name: string;
  /** Pre-0.7 name, served only by the legacy hand-written /mcp endpoint. */
  legacy?: string;
  description: string;
  inputSchema: JsonSchema;
  /** Whether this principal may see and call the tool. */
  allowed(principal: P): boolean;
  run(args: Record<string, unknown>, principal: P, signal?: AbortSignal): unknown;
}

export interface McpEndpoint<P> {
  name: string;
  version: string;
  instructions: string;
  /** Map the Authorization header to a principal; undefined is a 401. */
  authenticate(authorization: string | undefined): P | undefined;
  tools: Array<McpTool<P>>;
}

export function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7)), wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function toolResult(value: unknown) {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  return { content: [{ type: "text" as const, text: JSON.stringify(structured) }], structuredContent: structured };
}

/**
 * A stateless MCP endpoint on the official SDK. Each request builds a fresh
 * server holding only the tools its principal may use, so tools/list is the
 * permission boundary and a hidden tool is simply unknown.
 */
export function mcpRoute<P>(endpoint: McpEndpoint<P>) {
  const principals = new WeakMap<object, P>();
  const handler = createMcpHandler(({ authInfo }) => {
    const principal = authInfo?.extra && principals.get(authInfo.extra);
    const server = new McpServer({ name: endpoint.name, version: endpoint.version }, { instructions: endpoint.instructions });
    if (principal === undefined) return server;
    for (const tool of endpoint.tools) {
      if (!tool.allowed(principal)) continue;
      server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema) },
        async (args, ctx) => {
          try { return toolResult(await tool.run(args ?? {}, principal, ctx.mcpReq.signal)); }
          catch (error) {
            // A coded API error keeps its code, so the caller can tell workspace_unknown from forbidden.
            const code = (error as { code?: unknown }).code;
            throw typeof code === "string" && error instanceof Error ? new Error(`${code}: ${error.message}`) : error;
          }
        });
    }
    return server;
  }, { legacy: "stateless", maxRequestBodySize: 1_048_576, onerror: (error) => log.warn({ error, endpoint: endpoint.name }, "MCP request rejected") });
  return async (c: Context): Promise<Response> => {
    const principal = endpoint.authenticate(c.req.header("authorization"));
    if (principal === undefined) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401,
      { "www-authenticate": "Bearer", "cache-control": "no-store" });
    const extra = {};
    principals.set(extra, principal);
    return handler.fetch(c.req.raw, { authInfo: { token: "", clientId: endpoint.name, scopes: [], extra } });
  };
}
