import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono, type Context, type Handler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import pino from "pino";
import type { AgentControlApi } from "./api/router.js";
import { controlBrowserApi } from "./web/api.js";
import { createControlWeb } from "./web/app.js";

const log = pino({ name: "control-http" });
const HOOK_MAX_BYTES = 1024 * 1024;

export type HttpEnv = { Bindings: HttpBindings };
type NodeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<unknown> | unknown;

export interface HttpAppDeps {
  health(): Record<string, unknown>;
  memoryBootstrap?: Handler<HttpEnv>;
  legacyMcp?: NodeHandler;
  /** SDK MCP endpoints, served at /mcp/<name>. */
  mcp?: Record<string, Handler<HttpEnv>>;
  controlApi: AgentControlApi;
  /** POST /hooks/<id>: webhook-triggered automations, authenticated by each hook's own signature. */
  hooks?: (id: string, headers: Record<string, string | string[] | undefined>, body: Buffer) => { status: number; body: Record<string, unknown> };
  /** Whether the public /api/v1 entrance has any credential configured. */
  apiEnabled: boolean;
  browserTokens: { read?: string; write?: string };
  /** Shown by the Control Center next to its own build version. */
  version?: string;
  webDirectory?: string;
}

/**
 * Run a node:http handler inside Hono. Handlers that stream (SSE) or read the raw
 * body keep owning the response; Hono is told it has already been sent.
 */
export function nodeRoute(name: string, handler: NodeHandler) {
  return async (c: Context<HttpEnv>): Promise<Response> => {
    const { incoming, outgoing } = c.env;
    try { await handler(incoming, outgoing); }
    catch (error) {
      log.error({ error }, `${name} request failed`);
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        outgoing.end(JSON.stringify({ error: "internal_error" }));
      } else outgoing.end();
    }
    return RESPONSE_ALREADY_SENT;
  };
}

/** The single HTTP entrance: health, memory, MCP, the Control API and the Control Center. */
export function createHttpApp(deps: HttpAppDeps) {
  const app = new Hono<HttpEnv>();
  app.get("/health", (c) => c.json(deps.health()));
  if (deps.memoryBootstrap) app.get("/memory/bootstrap", deps.memoryBootstrap);
  for (const [name, route] of Object.entries(deps.mcp ?? {})) app.all(`/mcp/${name}`, route);
  if (deps.legacyMcp) app.all("/mcp", nodeRoute("Conversation MCP", deps.legacyMcp));
  if (deps.hooks) {
    const hooks = deps.hooks;
    app.post("/hooks/:id", async (c) => {
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > HOOK_MAX_BYTES) return c.json({ error: "payload_too_large" }, 413);
      const body = Buffer.from(await c.req.arrayBuffer());
      if (body.length > HOOK_MAX_BYTES) return c.json({ error: "payload_too_large" }, 413);
      const result = hooks(c.req.param("id"), c.env.incoming.headers, body);
      return c.json(result.body, result.status as 202);
    });
  }
  if (deps.apiEnabled) app.all("/api/v1/*", nodeRoute("Control API", (request, response) => deps.controlApi.handle(request, response)));
  app.all("/control/api/v1/*", controlBrowserApi(deps.controlApi, deps.browserTokens, deps.version));
  app.route("/", createControlWeb(deps.webDirectory));
  app.notFound((c) => c.body(null, 404));
  app.onError((error, c) => {
    log.error({ error, path: c.req.path }, "HTTP request failed");
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
