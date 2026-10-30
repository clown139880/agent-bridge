/**
 * pi has no MCP client. The Bridge loads this extension (`pi -e`) so pi gets the same central
 * memory/skills and session tools as Codex and Claude: the tools of the Control Plane's /mcp/memory
 * and /mcp/bridge, registered as `memory_<tool>` / `bridge_<tool>`, authenticated with the agent's
 * own AGENT_TOKEN. Loaded by pi through jiti; it uses only Node built-ins.
 */
const SERVERS = ["memory", "bridge"] as const;

type Json = Record<string, any>;

async function rpc(url: string, token: string, method: string, params: Json | undefined, signal?: AbortSignal): Promise<Json> {
  const response = await fetch(url, {
    method: "POST", signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
  // Streamable HTTP answers either with JSON or with one SSE message.
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("")
    : text;
  const message = JSON.parse(body) as Json;
  if (message.error) throw new Error(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result ?? {};
}

export default async function agentBridgeMcp(pi: any): Promise<void> {
  const base = process.env.AGENT_BRIDGE_CONTROL_URL?.replace(/\/$/, ""), token = process.env.AGENT_TOKEN;
  if (!base || !token) return;
  for (const server of SERVERS) {
    const url = `${base}/mcp/${server}`;
    let tools: Json[], instructions: string | undefined;
    try {
      const init = await rpc(url, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "agent-bridge-pi", version: "1" } }, AbortSignal.timeout(5_000));
      instructions = typeof init.instructions === "string" ? init.instructions : undefined;
      tools = (await rpc(url, token, "tools/list", undefined, AbortSignal.timeout(5_000))).tools ?? [];
    } catch (error) {
      // pi still starts; it only lacks these tools.
      process.stderr.write(`agent-bridge-mcp: ${server} unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    for (const [index, tool] of tools.entries()) {
      const name = `${server}_${tool.name}`;
      pi.registerTool({
        name, label: name,
        description: String(tool.description ?? tool.name),
        promptSnippet: String(tool.description ?? tool.name).split(/(?<=[.。])\s/)[0]!.slice(0, 160),
        ...(index === 0 && instructions ? { promptGuidelines: [`${server}_* tools (Agent Bridge ${server}): ${instructions}`] } : {}),
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        async execute(_id: string, args: Json, signal?: AbortSignal) {
          const result = await rpc(url, token, "tools/call", { name: tool.name, arguments: args ?? {} }, signal);
          const content = (Array.isArray(result.content) ? result.content : []).map((item: Json) =>
            item.type === "text" ? { type: "text", text: String(item.text) } : { type: "text", text: JSON.stringify(item) });
          if (!content.length && result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
          if (result.isError) throw new Error(content.map((item: Json) => item.text).join("\n") || `${name} failed`);
          return { content, details: {} };
        },
      });
    }
  }
}
