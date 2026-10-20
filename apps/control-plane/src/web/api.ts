import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentControlApi } from "../api/router.js";

const PREFIX = "/control/api/v1/";

// This browser entrance trusts network reachability (LAN / Cloudflare Access).
// The public /api/v1 entrance still requires its original Bearer credentials.
export async function handleControlBrowserApi(request: IncomingMessage, response: ServerResponse,
  api: AgentControlApi, tokens: { read?: string; write?: string }): Promise<void> {
  const fail = (status: number, code: string) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    response.end(JSON.stringify({ error: { code, message: code } }));
  };
  // A custom header requires cross-origin JavaScript to preflight. We never grant
  // CORS; additionally reject foreign browser origins and fetch metadata.
  const site = request.headers["sec-fetch-site"], origin = request.headers.origin;
  if (request.headers["x-control-center"] !== "1" || site && site !== "same-origin") {
    fail(403, "browser_origin_required"); return;
  }
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.host !== request.headers.host) throw new Error();
    } catch { fail(403, "browser_origin_required"); return; }
  }
  const url = new URL(request.url!, "http://localhost"), path = url.pathname.slice(PREFIX.length);
  const read = request.method === "GET" && /^(?:access|snapshot|workers|sessions|sessions\/[^/]+(?:\/events)?|actions\/[^/]+|approvals|user-input|stream)$/.test(path);
  const write = request.method === "POST" && /^(?:sessions|sessions\/[^/]+\/(?:turns|interrupt))$/.test(path);
  if (!read && !write) { fail(404, "not_found"); return; }
  const token = tokens.write || tokens.read;
  if (!token) { fail(503, "browser_api_unconfigured"); return; }
  if (path === "access") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ writable: Boolean(tokens.write) })); return;
  }
  if (write && !tokens.write) { fail(403, "browser_read_only"); return; }
  const previousUrl = request.url, authorization = request.headers.authorization;
  try {
    request.url = `/api/v1/${path}${url.search}`;
    request.headers.authorization = `Bearer ${token}`;
    // Direct dispatch retains native SSE flushing, disconnect and backpressure.
    await api.handle(request, response);
  } finally {
    request.url = previousUrl;
    if (authorization === undefined) delete request.headers.authorization;
    else request.headers.authorization = authorization;
  }
}
