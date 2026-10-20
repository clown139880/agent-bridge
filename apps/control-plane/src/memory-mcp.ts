import type { IncomingMessage, ServerResponse } from "node:http";
import pino from "pino";
import type { ConversationMemoryStore } from "@agent-bridge/database";
import { MEMORY_INSTRUCTIONS, memoryAuthenticator, memoryTools, type AgentMemoryMcpOptions, type MemoryPrincipal } from "./mcp/memory.js";
import type { McpTool } from "./mcp/route.js";

export type { AgentMemoryMcpOptions } from "./mcp/memory.js";

const log = pino({ name: "legacy-mcp" });

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 1_048_576) throw new Error("request_too_large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The pre-0.7 hand-written /mcp endpoint, kept until 0.8 so clients migrate to
 * /mcp/memory at their own pace. It lists the old tool names and accepts both
 * old and new ones; `legacyCalls` shows whether anything still depends on it.
 */
export class ConversationMcpServer {
  legacyCalls = 0;
  private readonly authenticate: (header: string | undefined) => MemoryPrincipal | undefined;
  private readonly tools: Array<McpTool<MemoryPrincipal>>;
  private readonly byName = new Map<string, McpTool<MemoryPrincipal>>();

  constructor(memory: ConversationMemoryStore, token: string | undefined, agentMemory?: AgentMemoryMcpOptions) {
    this.authenticate = memoryAuthenticator(token, agentMemory);
    this.tools = memoryTools(memory, agentMemory);
    for (const tool of this.tools) { this.byName.set(tool.name, tool); if (tool.legacy) this.byName.set(tool.legacy, tool); }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const principal = this.authenticate(request.headers.authorization);
    if (!principal) return this.send(response, 401, {
      jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" },
    });
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" }).end(); return;
    }
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    let raw: unknown;
    try { raw = await jsonBody(request); }
    catch (error) { return this.send(response, 400, { jsonrpc: "2.0", id: null,
      error: { code: -32700, message: error instanceof Error ? error.message : "parse_error" } }); }
    if (Array.isArray(raw)) {
      const replies = (await Promise.all(raw.map((item) => this.dispatch(item, principal)))).filter((item) => item !== undefined);
      if (!replies.length) { response.writeHead(202).end(); return; }
      return this.send(response, 200, replies);
    }
    const reply = await this.dispatch(raw, principal);
    if (reply === undefined) { response.writeHead(202).end(); return; }
    this.send(response, 200, reply);
  }

  private async dispatch(raw: unknown, principal: MemoryPrincipal): Promise<Record<string, unknown> | undefined> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_request" },
    };
    const request = raw as Partial<JsonRpcRequest>;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return {
      jsonrpc: "2.0", id: request.id ?? null, error: { code: -32600, message: "invalid_request" },
    };
    if (request.id === undefined) return undefined;
    try {
      let result: unknown;
      if (request.method === "initialize") result = {
        protocolVersion: typeof request.params?.protocolVersion === "string"
          ? request.params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-bridge-conversation-memory", version: "1.0.0" },
        instructions: MEMORY_INSTRUCTIONS,
      };
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: this.tools.filter((tool) => tool.allowed(principal))
        .map((tool) => ({ name: tool.legacy ?? tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
      else if (request.method === "tools/call") result = await this.callTool(request.params, principal);
      else return { jsonrpc: "2.0", id: request.id ?? null,
        error: { code: -32601, message: "method_not_found" } };
      return { jsonrpc: "2.0", id: request.id ?? null, result };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602,
        message: error instanceof Error ? error.message : "invalid_params" } };
    }
  }

  private async callTool(params: Record<string, unknown> | undefined, principal: MemoryPrincipal): Promise<Record<string, unknown>> {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown> : {};
    const tool = typeof name === "string" ? this.byName.get(name) : undefined;
    if (!tool || !tool.allowed(principal)) throw new Error("unknown_tool");
    this.legacyCalls++;
    log.info({ tool: name, writer: principal.writer?.name }, "Legacy /mcp tool call; migrate the client to /mcp/memory");
    const value = await tool.run(args, principal) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false };
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  }
}
