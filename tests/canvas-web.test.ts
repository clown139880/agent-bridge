import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { getRequestListener } from "../apps/control-plane/node_modules/@hono/node-server/dist/index.js";
import { Store } from "../packages/database/src/index.js";
import { CanvasService } from "../apps/control-plane/src/canvas.js";
import { createCanvasWeb } from "../apps/control-plane/src/canvas-web.js";
import { ToolHub } from "../apps/control-plane/src/tools.js";

test("canvas tools use auto/review/human decisions and never store signed URLs in approvals", async t => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-hub-")), registry = join(dir, "registry.yaml");
  await writeFile(registry, "servers:\n  canvas:\n    title: 实时画布\n    transport: { builtin: canvas }\n    risk: { auto: ['*'], review: [add_image], human: [close, open] }\n");
  const canvas = new CanvasService({ dataDir: dir }), store = new Store(":memory:");
  const reviewed: any[] = [];
  const hub = new ToolHub(store.db, { registry, canvas, reviewer: async request => { reviewed.push(request); return { decision: "allow", reason: "ok" }; } });
  t.after(async () => { hub.stop(); canvas.stop(); store.db.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await hub.call(`canvas.${name}`, args, "agent:test") as any).content[0].text);
  const found = await hub.search("canvas", 30); assert.equal(found.tools.length, 8);
  const created = await call("create", { title: "test", idempotency_key: "c" }), id = created.canvas_id;
  const signed = "https://image.example/private-secret/path?signature=do-not-log";
  await call("add_image", { canvas_id: id, idempotency_key: "a", url: signed });
  assert.equal(reviewed.length, 1); assert.equal(reviewed[0].args.url, "https://image.example/[redacted]");
  assert.ok(!JSON.stringify(hub.approvals()).includes("do-not-log"));
  assert.equal((await canvas.get(id)).images[0]!.url, signed, "the actual image URL stays intact");
  const denied = call("close", { canvas_id: id, idempotency_key: "close" });
  const rejection = assert.rejects(denied, /denied/);
  assert.equal((await canvas.get(id)).meta!.closed, false);
  hub.decide(hub.approvals("pending")[0]!.id, "deny", "control:write"); await rejection;
  const allowed = call("close", { canvas_id: id, idempotency_key: "close" });
  hub.decide(hub.approvals("pending")[0]!.id, "allow", "control:write"); await allowed;
  assert.equal((await canvas.get(id)).meta!.closed, true);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(hub.call("canvas.get", { canvas_id: id }, "agent:test", cancelled.signal), /abort/i);
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
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(`${path}/state`)).status, 403);
  assert.equal((await fetch(`${path}/state`, { headers: { ...headers, origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${path}/state`, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(`${path}/state`, { method: "POST", headers })).status, 404);
  assert.equal((await createCanvasWeb(canvas, false).request(`/canvas/${id}/`)).status, 503);
  const initial = await (await fetch(`${path}/state`, { headers })).json() as any;
  assert.equal(initial.meta.title, "canvas"); assert.equal(initial.owner, undefined); assert.equal(initial.idempotency, undefined);
  const a = await call("add_image", { canvas_id: id, idempotency_key: "a", url: "https://images.example/a" });
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
  const b = await call("add_image", { canvas_id: id, idempotency_key: "b", url: "https://images.example/b" });
  assert.deepEqual((await next()).images.map((i: any) => i.id), [b.image_id]);
  const changed = await (await fetch(`${path}/state?cursor=${a.seq}`, { headers })).json() as any;
  assert.deepEqual(changed.images.map((i: any) => i.id), [b.image_id]);
  assert.equal((await fetch(`${path}/events?cursor=9000`, { headers })).status, 409);
  canvas.stop(); assert.equal((await next()).error, "server_shutdown"); assert.equal(await next(), null);
});
