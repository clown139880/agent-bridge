import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono, type Context, type Handler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import pino from "pino";
import type { AgentControlApi } from "./api/router.js";
import { controlBrowserApi } from "./web/api.js";
import { createControlWeb } from "./web/app.js";

const log = pino({ name: "control-http" });

export type HttpEnv = { Bindings: HttpBindings };
type NodeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<unknown> | unknown;

export interface HttpAppDeps {
  health(): Record<string, unknown>;
  memoryBootstrap?: Handler<HttpEnv>;
  legacyMcp?: NodeHandler;
  controlApi: AgentControlApi;
  /** Whether the public /api/v1 entrance has any credential configured. */
  apiEnabled: boolean;
  browserTokens: { read?: string; write?: string };
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
  if (deps.legacyMcp) app.all("/mcp", nodeRoute("Conversation MCP", deps.legacyMcp));
  if (deps.apiEnabled) app.all("/api/v1/*", nodeRoute("Control API", (request, response) => deps.controlApi.handle(request, response)));
  app.all("/control/api/v1/*", controlBrowserApi(deps.controlApi, deps.browserTokens));
  app.route("/", createControlWeb(deps.webDirectory));
  app.notFound((c) => c.body(null, 404));
  app.onError((error, c) => {
    log.error({ error, path: c.req.path }, "HTTP request failed");
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
