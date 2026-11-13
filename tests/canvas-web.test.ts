import assert from "node:assert/strict";
import { mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { getRequestListener } from "../apps/control-plane/node_modules/@hono/node-server/dist/index.js";
import { Store } from "../packages/database/src/index.js";
import { CanvasService } from "../apps/control-plane/src/canvas.js";
import { createCanvasWeb } from "../apps/control-plane/src/canvas-web.js";
import { ToolHub } from "../apps/control-plane/src/tools.js";

test("canvas static files update in the same app without a build or restart; only named assets are served", async t => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-assets-")), canvas = new CanvasService({ dataDir: dir });
  t.after(async () => { canvas.stop(); await rm(dir, { recursive: true, force: true }); });
  const app = createCanvasWeb(canvas, true, dir), id = `cv_${"0".repeat(32)}`;
  for (const [file, path, type] of [["index.html", `/canvas/${id}/`, "text/html"],
    ["page.js", "/canvas/assets/page.js", "text/javascript"], ["page.css", "/canvas/assets/page.css", "text/css"]]) {
    await writeFile(join(dir, file!), "before");
    const before = await app.request(path!);
    assert.equal(before.status, 200); assert.equal(await before.text(), "before");
    assert.equal(before.headers.get("content-type"), `${type}; charset=utf-8`);
    assert.equal(before.headers.get("cache-control"), "no-store");
    assert.equal(before.headers.get("x-content-type-options"), "nosniff");
    if (file === "index.html") assert.match(before.headers.get("content-security-policy")!, /script-src 'self'/);
    await writeFile(join(dir, "next"), "after"); await rename(join(dir, "next"), join(dir, file!));
    assert.equal(await (await app.request(path!)).text(), "after", "the running app must reread replaced assets");
  }
  await writeFile(join(dir, "secret.txt"), "private");
  for (const path of ["/canvas/assets/secret.txt", "/canvas/assets/..%2Fsecret.txt", "/canvas/assets/page.js.map", "/canvas/invalid/"]) {
    const response = await app.request(path);
    assert.equal(response.status, 404); assert.ok(!(await response.text()).includes("private"));
  }
  await rm(join(dir, "page.js"));
  assert.equal((await app.request("/canvas/assets/page.js")).status, 503);
});

test("canvas tools use auto/review/human decisions and never store signed URLs in approvals", async t => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-hub-")), registry = join(dir, "registry.yaml");
  const registryText = "servers:\n  canvas:\n    title: 实时画布\n    transport: { builtin: canvas }\n    risk: { auto: [create], review: [push] }\n";
  await writeFile(registry, registryText);
  const canvas = new CanvasService({ dataDir: dir }), store = new Store(":memory:");
  const reviewed: any[] = [];
  const hub = new ToolHub(store.db, { registry, canvas, reviewer: async request => { reviewed.push(request); return { decision: "allow", reason: "ok" }; } });
  t.after(async () => { hub.stop(); canvas.stop(); store.db.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await hub.call(`canvas.${name}`, args, "agent:test") as any).content[0].text);
  const found = await hub.search("canvas", 30); assert.deepEqual(found.tools.map(t => t.name).sort(), ["canvas.create", "canvas.push"]);
  assert.deepEqual((found.tools.find(t => t.name === "canvas.push")!.inputSchema as any).properties.media_type.enum, ["image", "video"]);
  for (const name of ["list", "get", "set_status", "close", "open", "add_image", "update_image"]) await assert.rejects(call(name, {}), /unknown tool/);
  const created = await call("create", { title: "test", idempotency_key: "c" }), id = created.canvas_id;
  const signed = "https://image.example/private-secret/path?signature=do-not-log";
  await call("push", { canvas_id: id, idempotency_key: "a", url: signed, media_type: "video" });
  assert.equal(reviewed.length, 1); assert.equal(reviewed[0].args.url, "https://image.example/[redacted]");
  assert.ok(!JSON.stringify(hub.approvals()).includes("do-not-log"));
  assert.equal((await canvas.get(id)).images[0]!.url, signed, "the actual image URL stays intact");
  assert.equal((await canvas.get(id)).images[0]!.media_type, "video");
  const stamp = (await stat(registry)).mtimeMs;
  await writeFile(registry, registryText.replace("review: [push]", "human: [push]"));
  await utimes(registry, new Date(stamp + 1000), new Date(stamp + 1000));
  const args = { canvas_id: id, idempotency_key: "human", url: "https://image.example/second" };
  const denied = call("push", args);
  const rejection = assert.rejects(denied, /denied/);
  assert.equal((await canvas.get(id)).images.length, 1);
  hub.decide(hub.approvals("pending")[0]!.id, "deny", "control:write"); await rejection;
  const allowed = call("push", args);
  hub.decide(hub.approvals("pending")[0]!.id, "allow", "control:write"); await allowed;
  assert.equal((await canvas.get(id)).images.length, 2);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(hub.call("canvas.push", args, "agent:test", cancelled.signal), /abort/i);
  assert.equal(reviewed.length, 1, "human calls do not bypass to the local executor");
});

test("browser state/SSE are read-only and same-origin, resume only changes, and terminate on shutdown", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-http-")), canvas = new CanvasService({ dataDir: dir });
  const app = createCanvasWeb(canvas, true), server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`, headers = { "x-control-center": "1" };
  t.after(async () => { canvas.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const call = (name: string, args: Record<string, unknown>) => canvas.call(name, args, "agent:test") as Promise<any>;
  const { canvas_id: id } = await call("create", { title: "canvas", idempotency_key: "c" });
  const path = `${base}/canvas/${id}`;
  const page = await fetch(`${path}/`);
  assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy")!, /img-src http: https:/);
  assert.match(page.headers.get("content-security-policy")!, /media-src http: https:/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(`${path}/state`)).status, 403);
  assert.equal((await fetch(`${path}/state`, { headers: { ...headers, origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${path}/state`, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(`${path}/state`, { method: "POST", headers })).status, 404);
  assert.equal((await createCanvasWeb(canvas, false).request(`/canvas/${id}/`)).status, 503);
  const initial = await (await fetch(`${path}/state`, { headers })).json() as any;
  assert.equal(initial.meta.title, "canvas"); assert.equal(initial.owner, undefined); assert.equal(initial.idempotency, undefined);
  const a = await call("push", { canvas_id: id, idempotency_key: "a", url: "https://images.example/a" });
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`${path}/events?cursor=${a.seq}`, { headers, signal: abort.signal });
  const reader = response.body!.getReader(); let buffer = "";
  const next = async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); const line = frame.split("\n").find(s => s.startsWith("data: ")); if (line) return JSON.parse(line.slice(6)); }
      const chunk = await reader.read(); if (chunk.done) return null; buffer += new TextDecoder().decode(chunk.value);
    }
  };
  assert.deepEqual((await next()).images, []);
  const b = await call("push", { canvas_id: id, idempotency_key: "b", url: "https://images.example/b", media_type: "video" });
  const videoDelta = await next();
  assert.deepEqual(videoDelta.images.map((i: any) => i.id), [b.image_id]);
  assert.equal(videoDelta.images[0].media_type, "video");
  const changed = await (await fetch(`${path}/state?cursor=${a.seq}`, { headers })).json() as any;
  assert.deepEqual(changed.images.map((i: any) => i.id), [b.image_id]);
  assert.equal((await fetch(`${path}/events?cursor=9000`, { headers })).status, 409);
  canvas.stop(); assert.equal((await next()).error, "server_shutdown"); assert.equal(await next(), null);
});
