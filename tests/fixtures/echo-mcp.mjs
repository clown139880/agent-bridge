// Minimal stdio MCP server for tool-hub tests: tools `echo` (auto) and `wipe` (needs approval).
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [
    { name: "echo", description: "Echo text back, with the configured greeting", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "wipe", description: "Erase everything", inputSchema: { type: "object", properties: {} } }] } });
  else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text",
    text: `${process.env.GREETING ?? ""}${request.params.name}:${request.params.arguments?.text ?? ""}` }] } });
  else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
});
