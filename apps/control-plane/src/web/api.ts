import type { Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AgentControlApi, Principal } from "../api/router.js";

const PREFIX = "/control/api/v1/";
const SECURITY = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

// This browser entrance trusts network reachability (LAN / Cloudflare Access).
// The public /api/v1 entrance still requires its original Bearer credentials.
// Configured tokens only decide what the browser may do; it never sees them.
export function controlBrowserApi(api: AgentControlApi, tokens: { read?: string; write?: string }) {
  const principal: Principal | undefined = tokens.write ? { id: "control:write", read: true, write: true }
    : tokens.read ? { id: "control:read", read: true, write: false } : undefined;
  return async (c: Context<{ Bindings: HttpBindings }>): Promise<Response> => {
    const fail = (status: 403 | 404 | 503, code: string) => c.json({ error: { code, message: code } }, status, SECURITY);
    // A custom header requires cross-origin JavaScript to preflight. We never grant
    // CORS; additionally reject foreign browser origins and fetch metadata.
    const site = c.req.header("sec-fetch-site"), origin = c.req.header("origin");
    if (c.req.header("x-control-center") !== "1" || site && site !== "same-origin") return fail(403, "browser_origin_required");
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.host !== c.req.header("host")) throw new Error();
      } catch { return fail(403, "browser_origin_required"); }
    }
    const url = new URL(c.req.url), path = url.pathname.slice(PREFIX.length), method = c.req.method;
    const read = method === "GET" && /^(?:access|snapshot|workers|sessions|sessions\/[^/]+(?:\/events)?|actions\/[^/]+|approvals|user-input|stream)$/.test(path);
    const write = method === "POST" && /^(?:sessions|sessions\/[^/]+\/(?:turns|interrupt))$/.test(path);
    if (!read && !write) return fail(404, "not_found");
    if (!principal) return fail(503, "browser_api_unconfigured");
    if (path === "access") return c.json({ writable: principal.write }, 200, { "cache-control": "no-store" });
    if (write && !principal.write) return fail(403, "browser_read_only");
    // Direct dispatch retains native SSE flushing, disconnect and backpressure.
    await api.handle(c.env.incoming, c.env.outgoing, { principal, url: new URL(`/api/v1/${path}${url.search}`, url) });
    return RESPONSE_ALREADY_SENT;
  };
}
