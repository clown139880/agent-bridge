import { Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { HttpEnv } from "./http.js";
import { CanvasError, type CanvasService } from "./canvas.js";
import { CANVAS_HTML, CANVAS_CSS, CANVAS_JS } from "./canvas-page.js";
import { sameOriginBrowser } from "./web/api.js";

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export function createCanvasWeb(service: CanvasService, enabled: boolean) {
  const app = new Hono<HttpEnv>();
  app.use("/canvas/*", async (c, next) => { for (const [key, value] of Object.entries(HEADERS)) c.header(key, value); await next(); });
  app.get("/canvas/assets/page.js", c => c.body(CANVAS_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/canvas/assets/page.css", c => c.body(CANVAS_CSS, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/canvas/:id/", c => {
    if (!enabled) return c.json({ error: "browser_api_unconfigured" }, 503);
    if (!/^cv_[a-f0-9]{32}$/.test(c.req.param("id"))) return c.body(null, 404);
    return c.html(CANVAS_HTML, 200, { "content-security-policy": CSP });
  });
  for (const kind of ["state", "events"] as const) app.get(`/canvas/:id/${kind}`, async c => {
    if (!sameOriginBrowser(c)) return c.json({ error: "browser_origin_required" }, 403);
    if (!enabled) return c.json({ error: "browser_api_unconfigured" }, 503);
    const cursorText = c.req.header("last-event-id") ?? c.req.query("cursor") ?? "0";
    if (!/^\d+$/.test(cursorText) || !Number.isSafeInteger(Number(cursorText))) return c.json({ error: "invalid_cursor" }, 409);
    const id = c.req.param("id"), cursor = Number(cursorText);
    try {
      if (kind === "state") return c.json(await service.get(id, cursor));
      const response = c.env.outgoing;
      let unsubscribe: (() => void) | undefined, timer: NodeJS.Timeout | undefined, ended = false, checking = false;
      const cleanup = () => { ended = true; if (timer) clearInterval(timer); unsubscribe?.(); response.off("close", cleanup); };
      const close = () => { cleanup(); response.end(); };
      const send = (data: unknown, seq?: number) => {
        if (ended || response.destroyed) return;
        if (!response.headersSent) response.writeHead(200, { ...HEADERS, "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
        // At most one bounded full snapshot plus the writable high-water mark. Slow viewers reconnect by seq.
        if (response.writableNeedDrain || response.writableLength > 16 * 1024 * 1024) { cleanup(); response.destroy(); return; }
        response.write(`${seq === undefined ? "" : `id: ${seq}\n`}event: canvas\ndata: ${JSON.stringify(data)}\n\n`);
      };
      response.on("close", cleanup);
      try {
        unsubscribe = await service.subscribe(id, cursor, event => {
          if (event instanceof CanvasError) { send({ error: event.code }); close(); return; }
          send(event, event.seq); if (event.meta?.closed) close();
        });
      } catch (e) { cleanup(); throw e; }
      if (ended || response.destroyed) { cleanup(); return RESPONSE_ALREADY_SENT; }
      timer = setInterval(() => {
        if (checking || ended) return; checking = true;
        void service.exists(id).then(() => {
          if (!ended) { if (response.writableNeedDrain) { cleanup(); response.destroy(); } else response.write(": keepalive\n\n"); }
        }, e => { send({ error: e instanceof CanvasError ? e.code : "canvas_storage_error" }); close(); }).finally(() => { checking = false; });
      }, 15_000);
      timer.unref();
      return RESPONSE_ALREADY_SENT;
    } catch (error) {
      return c.json({ error: error instanceof CanvasError ? error.code : "canvas_storage_error" }, (error instanceof CanvasError ? error.status : 500) as 400);
    }
  });
  return app;
}
