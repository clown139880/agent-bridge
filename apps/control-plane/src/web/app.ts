import { Hono, type MiddlewareHandler } from "hono";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = fileURLToPath(new URL("../../../control-center/dist/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8" };

export function createControlWeb(directory = DEFAULT_DIR) {
  const app = new Hono();
  // Scoped to the Control Center so the CSP never lands on API or MCP responses.
  const security: MiddlewareHandler = async (c, next) => {
    c.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  };
  app.use("/control", security);
  app.use("/control/*", security);
  app.on(["GET", "HEAD"], "/control", c => c.redirect("/control/sessions", 302));
  app.on(["GET", "HEAD"], "/control/", c => c.redirect("/control/sessions", 302));
  app.on(["GET", "HEAD"], "/control/*", async c => {
    const raw = c.req.path.slice("/control/".length);
    const page = /^(?:login|new|sessions(?:\/[^/]+)?)\/?$/.test(raw);
    let relative: string;
    try { relative = decodeURIComponent(raw); }
    catch { return c.text("Invalid path", 400); }
    if (relative.includes("\0") || relative.includes("\\")) return c.notFound();
    const root = resolve(directory), path = resolve(root, relative);
    if (!page && !path.startsWith(root + sep)) return c.notFound();
    const target = page ? resolve(root, "index.html") : path;
    try {
      const real = await realpath(target), realRoot = await realpath(root);
      if (!real.startsWith(realRoot + sep) || !(await stat(real)).isFile()) return c.notFound();
      const body = await readFile(real);
      c.header("Content-Type", MIME[extname(real)] ?? "application/octet-stream");
      c.header("Cache-Control", page ? (relative === "login" ? "no-store" : "no-cache")
        : relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      if (c.req.method === "HEAD") return c.body(null);
      return c.body(new Uint8Array(body));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return page ? c.text("Control Center 尚未构建，请先构建前端。", 503) : c.notFound();
    }
  });
  app.notFound(c => c.text("Not found", 404));
  return app;
}

