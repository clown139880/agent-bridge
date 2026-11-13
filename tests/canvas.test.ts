import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CanvasService, CanvasError, type CanvasDelta } from "../apps/control-plane/src/canvas.js";

const owner = "agent:canvas-test";
async function fixture(t: test.TestContext, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-test-"));
  const service = new CanvasService({ dataDir: dir, ...options });
  t.after(async () => { service.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = (tool: string, args: Record<string, unknown> = {}) => service.call(tool, args, owner) as Promise<any>;
  const created = await call("create", { title: "测试画布", idempotency_key: "create" });
  const id = created.canvas_id as string, path = join(service.directory, `${id}.json`);
  return { service, call, id, path, dir, created };
}

test("concurrent writes and retries survive restart in one private, atomically replaced JSON", async t => {
  const f = await fixture(t, { publicUrl: "https://control.example.com" });
  assert.equal(f.created.page_url, `https://control.example.com/canvas/${f.id}/`);
  const add = (i: number) => f.call("push", { canvas_id: f.id, idempotency_key: `image-${i}`, url: `https://images.example/${i}.png` });
  let observing = true;
  const observe = (async () => {
    while (observing) {
      const file = JSON.parse(await readFile(f.path, "utf8"));
      assert.equal(file.seq, file.images.length + 1, "readers must never see an intermediate state");
    }
  })();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => add(i)));
  observing = false; await observe;
  assert.equal(new Set(results.map(r => r.image_id)).size, 25);
  const repeated = await Promise.all([add(5), add(5), add(5)]);
  assert.ok(repeated.every(r => r.seq === results[5].seq));
  const fresh = new CanvasService({ dataDir: f.dir });
  t.after(() => fresh.stop());
  assert.deepEqual(await fresh.call("push", { canvas_id: f.id, idempotency_key: "image-5", url: "https://images.example/5.png" }, owner), results[5]);
  assert.equal((await fresh.get(f.id)).images.length, 25);
  assert.deepEqual(await f.call("create", { title: "测试画布", idempotency_key: "create" }), f.created);
  await assert.rejects(f.call("create", { title: "changed", idempotency_key: "create" }), /idempotency_conflict/);
  assert.deepEqual(await readdir(f.service.directory), [`${f.id}.json`]);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.service.directory)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(f.path, "utf8")).includes('"events"'));
});

test("revision conflicts prevent lost updates; cursors coalesce changes and subscription closes the read/subscribe race", async t => {
  const f = await fixture(t);
  const initial = await f.service.get(f.id);
  const a = await f.call("push", { canvas_id: f.id, idempotency_key: "a", url: "https://images.example/a" });
  const b = await f.call("push", { canvas_id: f.id, idempotency_key: "b", url: "https://images.example/b" });
  const events: CanvasDelta[] = [];
  const off = await f.service.subscribe(f.id, initial.seq, e => { if (!(e instanceof CanvasError)) events.push(e); });
  assert.deepEqual(events[0]!.images.map(i => i.id), [a.image_id, b.image_id]);
  assert.equal(events[0]!.meta, undefined);
  const update = (key: string, url: string, revision = a.revision) => f.call("push", { canvas_id: f.id, image_id: a.image_id, expected_revision: revision, url, idempotency_key: key });
  const competing = await Promise.allSettled([update("u1", "https://images.example/a2"), update("u2", "https://images.example/a3")]);
  assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
  const first = (competing[0] as PromiseFulfilledResult<any>).value;
  await assert.rejects(update("stale", "https://images.example/stale"), /revision_conflict/);
  await update("u3", "https://images.example/a4", first.revision);
  const delta = await f.service.get(f.id, b.seq);
  assert.equal(delta.images.length, 1); assert.equal(delta.images[0]!.url, "https://images.example/a4");
  assert.equal(events.length, 3);
  assert.deepEqual(await f.service.get(f.id, delta.seq), { id: f.id, seq: delta.seq, images: [] });
  await assert.rejects(f.service.get(f.id, delta.seq + 1), /invalid_cursor/);
  off(); await update("u4", "https://images.example/a5", delta.seq); assert.equal(events.length, 3);
});

test("identity, quotas and validation do not change the committed state; no image fetches", async t => {
  const f = await fixture(t, { maxImages: 1, maxUrlBytes: 64, maxDescriptionBytes: 6 });
  t.mock.method(globalThis, "fetch", () => { throw new Error("backend must never fetch images"); });
  const add = (url: string, key = "add", description = "") => f.call("push", { canvas_id: f.id, idempotency_key: key, url, description });
  for (const url of ["/tmp/a.png", "data:image/png;base64,abc", "file:///a", "javascript:alert(1)", "https://user:secret@example.com/a", "http://example.com/" + "a".repeat(64)]) await assert.rejects(add(url), /invalid_url/);
  await assert.rejects(add("https://img.example/a", "long", "中文中文"), /invalid_description/);
  await assert.rejects(f.service.call("push", { canvas_id: f.id, idempotency_key: "wrong", url: "https://img.example/a" }, "agent:other"), /canvas_gone/);
  await assert.rejects(f.call("push", { canvas_id: "../secret", idempotency_key: "path", url: "https://img.example/a" }), /invalid_canvas_id/);
  await assert.rejects(f.call("push", { canvas_id: f.id, owner: "agent:other" }), /invalid_arguments/);
  await assert.rejects(f.call("push", { canvas_id: f.id, idempotency_key: "bad-update", image_id: "missing", url: "https://img.example/a" }), /invalid_arguments/);
  for (const tool of ["list", "get", "set_status", "close", "open", "add_image", "update_image"]) await assert.rejects(f.call(tool), /invalid_arguments/);
  assert.equal((await f.service.get(f.id)).seq, 1);
  const added = await add("http://127.0.0.1:1/no-server", "ok", "中文");
  assert.deepEqual(await add("http://127.0.0.1:1/no-server", "ok", "中文"), added);
  await assert.rejects(add("https://img.example/b", "quota"), /image_limit/);
  assert.equal((await f.service.get(f.id)).seq, 2);
});

test("old files stay usable without task status; no-op, missing and corrupt files have explicit boundaries", async t => {
  const f = await fixture(t);
  const old = JSON.parse(await readFile(f.path, "utf8"));
  await writeFile(f.path, JSON.stringify({ ...old, status: "complete", description: "old task", closed: true, status_at: 123, meta_seq: 1 }));
  const push = (key: string) => f.call("push", { canvas_id: f.id, idempotency_key: key, url: "https://img.example/a" });
  const image = await push("image");
  const unchanged = await f.call("push", { canvas_id: f.id, idempotency_key: "same", image_id: image.image_id, expected_revision: image.revision, url: "https://img.example/a" });
  assert.equal(unchanged.seq, image.seq);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  for (const field of ["closed", "status", "status_at", "meta_seq"]) assert.equal(saved[field], undefined);
  assert.equal((await f.service.get(f.id)).images.length, 1);
  await unlink(f.path);
  await assert.rejects(f.service.get(f.id), /canvas_gone/);
  await assert.rejects(push("gone"), /canvas_gone/);
  assert.deepEqual(await readdir(f.service.directory), []);
  await writeFile(f.path, "{broken");
  await assert.rejects(push("corrupt"), /canvas_corrupt/);
  assert.equal(await readFile(f.path, "utf8"), "{broken");
});

test("shutdown also rejects a subscription still waiting on its initial file read", async t => {
  const f = await fixture(t);
  const pending = f.service.subscribe(f.id, 0, () => { assert.fail("cannot open a stream after shutdown"); });
  f.service.stop();
  await assert.rejects(pending, /server_shutdown/);
});

test("video URLs use the same metadata, idempotency and revision path without fetching media", async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("backend must never fetch media"); });
  const args = { canvas_id: f.id, idempotency_key: "video", url: "https://media.example/opaque?signature=private", media_type: "video" };
  const added = await f.call("push", args);
  assert.deepEqual(await f.call("push", args), added);
  const fresh = new CanvasService({ dataDir: f.dir }); t.after(() => fresh.stop());
  assert.equal((await fresh.get(f.id)).images[0]!.media_type, "video");
  for (const media_type of ["audio", "auto", "", null, 42]) await assert.rejects(f.call("push", { ...args, idempotency_key: "invalid", media_type }), /invalid_media_type/);
  assert.equal((await f.service.get(f.id)).seq, added.seq);
  const changed = await f.call("push", { canvas_id: f.id, image_id: added.image_id, expected_revision: added.revision,
    idempotency_key: "image", media_type: "image", url: "https://media.example/still.png" });
  const delta = await f.service.get(f.id, added.seq);
  assert.equal(delta.images.length, 1); assert.equal(delta.images[0]!.media_type, "image");
  assert.equal(delta.images[0]!.order, 0); assert.equal(delta.images[0]!.updated_seq, changed.revision);
  await assert.rejects(f.call("push", { ...args, idempotency_key: "stale", image_id: added.image_id, expected_revision: added.revision }), /revision_conflict/);
  const legacy = await f.call("push", { canvas_id: f.id, idempotency_key: "legacy", url: "https://media.example/old.mp4" });
  assert.equal((await f.service.get(f.id, changed.seq)).images[0]!.media_type, undefined, "old records need no migration; the browser infers video from the URL");
  assert.equal(legacy.seq, changed.seq + 1);
});
