import type { AgentControlApi } from "../api/router.js";
import type { ToolHub } from "../tools.js";
import type { McpEndpoint, McpTool } from "./route.js";

/** /mcp/tools: search and call every tool in the central library (docs/tool-hub-design.zh.md). */

export interface ToolsPrincipal { id: string }

export const TOOLS_INSTRUCTIONS = "Central tool library: tool_search finds a tool by what you need (ComfyUI, Home Assistant, radio, calls…); tool_call runs it by the returned name with arguments matching its inputSchema. Some tools wait for the human's approval before they run.";

export function toolsEndpoint(api: AgentControlApi, hub: ToolHub): McpEndpoint<ToolsPrincipal> {
  const tools: Array<McpTool<ToolsPrincipal>> = [
    {
      name: "tool_search", allowed: () => true,
      description: "Find tools in the central library. Returns name, description, inputSchema and risk (auto runs at once; review/human waits for approval).",
      inputSchema: { type: "object", additionalProperties: false, required: ["query"],
        properties: { query: { type: "string", description: "What you need, in any language; empty lists everything" }, limit: { type: "integer", minimum: 1, maximum: 30 } } },
      run: async (args) => hub.search(String(args.query ?? ""), typeof args.limit === "number" ? args.limit : 10),
    },
    {
      name: "tool_call", allowed: () => true,
      description: "Call a library tool by the name tool_search returned (server.tool). arguments must match its inputSchema. A tool that needs approval blocks until the human decides (up to 10 minutes).",
      inputSchema: { type: "object", additionalProperties: false, required: ["name"],
        properties: { name: { type: "string" }, arguments: { type: "object" } } },
      run: async (args, principal, signal) => hub.call(String(args.name ?? ""),
        args.arguments && typeof args.arguments === "object" ? args.arguments as Record<string, unknown> : {}, principal.id, signal),
    },
  ];
  return { name: "agent-bridge-tools", version: "0.7.0", instructions: TOOLS_INSTRUCTIONS,
    authenticate: (authorization) => {
      const principal = api.principalFor(authorization);
      return principal && principal.id !== "bridge" && principal.write ? { id: principal.id } : undefined;
    },
    tools };
}
