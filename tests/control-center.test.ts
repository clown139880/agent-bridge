import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createControlWeb } from "../apps/control-plane/src/web/app.js";
import { ControlClient, ApiError } from "../apps/control-center/src/api/client.js";
import { consumeStream, SseParser, StreamLimitError } from "../apps/control-center/src/api/stream.js";
import { ControlState, mergeTail } from "../apps/control-center/src/state.js";
import type { Envelope, Session, Snapshot } from "../apps/control-center/src/api/types.js";

const event = (id: string, type = "session.event.appended", data: unknown = { eventId: id, cursor: `e:${id}`, sessionId: "s", type: "message.completed", payload: { text: id } }): Envelope =>
  ({ cursor: `c:${id}:0`, eventId: id, type, sessionId: "s", resource: { kind: "session", id: "s" }, data });
const frame = (e: Envelope) => `id: ${e.cursor}\nevent: bridge.event\ndata: ${JSON.stringify(e)}\n\n`;
const session: Session = { sessionId: "s", workerId: "claude@test", machineId: "test", agent: "claude-code", title: "Test",
  promptSummary: null, projectName: "repo", workspace: "/repo", status: "idle", activeTurnId: null, createdAt: 1, updatedAt: 2,
  pendingApprovalCount: 0, pendingUserInputCount: 0, capabilities: ["session-actions", "turn-interrupt", "turn-steer"] };
const snapshot: Snapshot = { sessions: [session], workers: [{ id: "claude@test", name: "Test worker", status: "online", capabilities: session.capabilities!, workspaces: ["/repo"] }],
  approvals: [], userInput: [], streamCursor: "c:0:0", truncated: { sessions: false } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const flush = () => new Promise<void>(r => setTimeout(r, 15));

test("web routes constrain SPA fallback, traversal, caching, missing build and security headers", async () => {
  await mkdir(resolve(".runtime/tests"), { recursive: true });
  const directory = await mkdtemp(resolve(".runtime/tests/web-"));
  await mkdir(resolve(directory, "assets"));
  await writeFile(resolve(directory, "index.html"), "<!doctype html><title>test shell</title>");
  await writeFile(resolve(directory, "assets/test-abc.js"), "console.log('test')");
  const app = createControlWeb(directory);
  for (const path of ["/control/login", "/control/sessions", "/control/sessions/s", "/control/sessions/a%2Fb%3Ac", "/control/new"]) {
    const response = await app.request(path);
    assert.equal(response.status, 200); assert.match(await response.text(), /test shell/);
    assert.match(response.headers.get("content-security-policy")!, /connect-src 'self'/);
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal((await app.request("/control/login")).headers.get("cache-control"), "no-store");
  const asset = await app.request("/control/assets/test-abc.js");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.match(asset.headers.get("content-type")!, /javascript/);
  for (const path of ["/api/v1/sessions", "/control/assets/missing.js", "/control/unknown", "/control/%2e%2e%2fpackage.json", "/control/%5cpackage.json"]) {
    assert.equal((await app.request(path, { headers: { accept: "text/html" } })).status, 404, path);
  }
  assert.equal((await app.request("/control/sessions", { method: "POST" })).status, 404);
  assert.equal(await (await app.request("/control/sessions", { method: "HEAD" })).text(), "");
  assert.equal((await createControlWeb(resolve(directory, "not-built")).request("/control/sessions")).status, 503);
});

test("SSE parser handles split CRLF, UTF text, comments, retry and multi-line data without partial acknowledgement", () => {
  const events: Envelope[] = [], retries: number[] = [];
  const parser = new SseParser(e => events.push(e), ms => retries.push(ms));
  parser.push(": keepalive\r"); parser.push("\nretry: 3000\r\n\r\n");
  const e = event("1"), source = `id: ${e.cursor}\r\nevent: bridge.event\r\ndata: {\r\ndata: ${JSON.stringify(e).slice(1)}\r\n\r\n`;
  for (const char of source.slice(0, -1)) parser.push(char);
  assert.equal(events.length, 0);
  parser.push("\n"); assert.deepEqual(events, [e]); assert.deepEqual(retries, [3000]);
  parser.push(frame(event("2")).slice(0, -1)); assert.equal(events.length, 1);
  parser.push("\n"); assert.equal(events.length, 2);
  assert.throws(() => new SseParser(() => {}, () => {}, 20).push("data: " + "x".repeat(21)), StreamLimitError);
});

test("HTTP credentials stay in headers and writes replay the same idempotency key", async t => {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: String(init.body ?? "") });
    return json({ actionId: "a", status: "accepted" });
  });
  const client = new ControlClient("memory-only-secret", () => {});
  await client.post("/sessions/s/interrupt", { expectedTurnId: "t" }, "stable-key");
  await client.post("/sessions/s/interrupt", { expectedTurnId: "t" }, "stable-key");
  assert.equal(calls[0].headers.get("authorization"), "Bearer memory-only-secret");
  assert.equal(calls[0].headers.get("idempotency-key"), calls[1].headers.get("idempotency-key"));
  assert.equal(calls[0].body, calls[1].body); assert.ok(!calls.some(c => c.url.includes("secret")));
  client.dispose();
});

test("stream decoder preserves split UTF-8 and refuses an oversized unapplied queue", async () => {
  const e = event("1", "session.event.appended", { text: "跨块中文" });
  const bytes = new TextEncoder().encode(frame(e));
  const split = bytes.findIndex(v => v > 127) + 1, received: Envelope[] = [];
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close(); } }));
  await assert.rejects(consumeStream(response, new AbortController().signal, e => received.push(e), () => {}), /连接中断/);
  assert.deepEqual(received, [e]);
  const burst = new TextEncoder().encode(Array.from({ length: 501 }, (_, i) => frame(event(String(i)))).join(""));
  const large = new Response(new ReadableStream({ start(c) { c.enqueue(burst); c.close(); } }));
  let applied = 0;
  await assert.rejects(consumeStream(large, new AbortController().signal, () => applied++, () => {}), StreamLimitError);
  assert.equal(applied, 0, "unapplied cursors must remain available for replay");
});

function fixture(t: test.TestContext, options: { live?: boolean; write?: (init: RequestInit) => Response | Promise<Response>; detail?: () => Promise<Response>; action?: () => Promise<Response> } = {}) {
  let wire: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamCalls = 0, cancels = 0, current = { ...session, ...(options.live ? { status: "active", activeTurnId: "t1" } : {}) };
  const requests: { path: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    if (path === "/api/v1/stream") {
      streamCalls++;
      return new Response(new ReadableStream<Uint8Array>({ start(c) { wire = c; }, cancel() { cancels++; } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (init.method === "POST") return options.write ? options.write(init) : json({ actionId: "a", kind: "submit_turn", status: "succeeded", sessionId: "s", turnId: "new-turn" });
    if (path.includes("/snapshot")) return json({ ...snapshot, sessions: [current] });
    if (path === "/api/v1/sessions/s") return options.detail ? options.detail() : json(current);
    if (path.includes("/events")) return json({ data: [{ eventId: "history", cursor: "e:1", sessionId: "s", type: "message.completed", payload: { role: "assistant", text: "History" } }], nextCursor: null, hasMore: false });
    if (path.startsWith("/api/v1/sessions?")) return json({ data: [current], hasMore: false, nextCursor: null });
    if (path === "/api/v1/workers") return json({ workers: snapshot.workers });
    if (path.startsWith("/api/v1/actions/")) return options.action ? options.action() : json({ actionId: "a", kind: "submit_turn", status: "accepted", sessionId: "s" });
    return json({ data: [], hasMore: false, nextCursor: null });
  });
  const state = new ControlState("test-token", true, snapshot, () => {}, () => {});
  t.after(() => state.dispose());
  return { state, requests, setSession: (s: Partial<Session>) => { current = { ...current, ...s }; },
    emit: (e: Envelope) => wire!.enqueue(new TextEncoder().encode(frame(e))),
    stats: () => ({ streamCalls, cancels }) };
}

test("active detail merges SSE with history, keeps pending, and stops all streaming while hidden", async t => {
  const f = fixture(t, { live: true });
  await f.state.open({ page: "detail", id: "s" });
  f.emit(event("1")); f.emit(event("2", "approval.upserted", { id: "p", sessionId: "s", status: "pending", summary: "Approve" }));
  await flush(); assert.equal(f.state.snapshot().events.length, 2); assert.equal(f.state.snapshot().approvals.length, 1);
  f.emit(event("1")); await flush(); assert.equal(f.state.snapshot().events.length, 2);
  f.state.setVisible(false); await flush(); assert.equal(f.stats().cancels, 1);
  assert.equal(f.state.snapshot().connection, "后台已暂停");
  f.state.setVisible(true); await flush(); assert.equal(f.stats().streamCalls, 2);
  const streamRequests = f.requests.filter(v => v.path === "/api/v1/stream");
  assert.equal(new Headers(streamRequests[1].init.headers).get("last-event-id"), "c:2:0");
});

test("GET baseline never overwrites newer SSE status or loses pending fetched before a concurrent session update", async t => {
  let complete!: (r: Response) => void;
  const f = fixture(t, { detail: () => new Promise(resolve => { complete = resolve; }) });
  const opening = f.state.open({ page: "detail", id: "s" }); await flush();
  f.emit(event("1", "session.updated", { ...session, status: "active", activeTurnId: "t1" }));
  f.emit(event("2", "approval.upserted", { id: "p", sessionId: "s", status: "pending" })); await flush();
  complete(json(session)); await opening;
  assert.equal(f.state.snapshot().session?.status, "active"); assert.equal(f.state.snapshot().approvals.length, 1);
});

test("idle detail does not leave a permanent stream and a successful start retains observation until projection arrives", async t => {
  const f = fixture(t);
  await f.state.open({ page: "detail", id: "s" }); await flush();
  assert.equal(f.stats().cancels, 1);
  f.state.setDraft("s", "Hello");
  await f.state.submit("/sessions/s/turns", { input: "Hello", delivery: "start_turn" }, "s"); await flush();
  assert.equal(f.state.snapshot().intent?.receipt?.status, "succeeded");
  assert.equal(f.stats().cancels, 1, "do not close on the old idle projection immediately after POST succeeds");
  f.setSession({ status: "active", activeTurnId: "new-turn" });
  f.emit(event("2", "session.updated", { ...session, status: "active", activeTurnId: "new-turn" })); await flush();
  f.setSession({ status: "idle", activeTurnId: null });
  f.emit(event("3", "session.updated", session)); await flush();
  assert.equal(f.stats().cancels, 2); assert.equal(f.state.snapshot().drafts.s, "");
});

test("a reconcile answer older than action.updated cannot undo the action's result", async t => {
  let answer!: (r: Response) => void;
  const accepted = { actionId: "a", kind: "submit_turn", status: "accepted", sessionId: "s" };
  const f = fixture(t, { live: true, write: () => json(accepted, 202),
    action: () => new Promise(resolve => { answer = resolve; }) });
  await f.state.open({ page: "detail", id: "s" });
  const submitting = f.state.submit("/sessions/s/turns", { input: "more", delivery: "steer", expectedTurnId: "t1" }, "s");
  await flush(); // POST answered "accepted"; the reconcile GET is in flight
  f.emit(event("9", "action.updated", { ...accepted, status: "succeeded" })); await flush();
  assert.equal(f.state.snapshot().intent?.receipt?.status, "succeeded");
  answer(json(accepted)); await submitting; await flush();
  assert.equal(f.state.snapshot().intent?.receipt?.status, "succeeded");
});

test("uncertain POST retries preserve the body/key; turn conflict refreshes without issuing another interrupt", async t => {
  let writes = 0;
  const f = fixture(t, { live: true, write: () => {
    if (++writes === 1) throw new TypeError("Connection lost");
    return json({ error: { code: "turn_changed", message: "changed" } }, 409);
  } });
  await f.state.open({ page: "detail", id: "s" });
  await f.state.submit("/sessions/s/interrupt", { expectedTurnId: "t1" });
  assert.equal(f.state.snapshot().intent?.uncertain, true);
  await f.state.retry();
  const posts = f.requests.filter(r => r.init.method === "POST");
  assert.equal(posts.length, 2); assert.equal(posts[0].init.body, posts[1].init.body);
  assert.equal(new Headers(posts[0].init.headers).get("idempotency-key"), new Headers(posts[1].init.headers).get("idempotency-key"));
  assert.equal(f.state.snapshot().intent?.uncertain, false); assert.match(f.state.snapshot().intent?.error ?? "", /turn 已变化/);
  assert.equal(writes, 2);
});

test("uploads are sent as refs, cleared only after the turn succeeds, and the model catalog is fetched once", async t => {
  const f = fixture(t);
  t.mock.method(URL, "createObjectURL", () => "blob:preview"); t.mock.method(URL, "revokeObjectURL", () => {});
  const original = globalThis.fetch as unknown as (path: string, init: RequestInit) => Promise<Response>;
  let catalogCalls = 0;
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    if (path === "/api/v1/attachments") {
      const body = JSON.parse(String(init.body));
      assert.equal(new Headers(init.headers).get("idempotency-key"), null);
      return json({ id: "sha", filename: body.filename, mimeType: body.mimeType, size: 3 }, 201);
    }
    if (path.endsWith("/models")) { catalogCalls++; return json({ models: [{ id: "m", model: "m", displayName: "M" }] }); }
    return original(path, init);
  });
  await f.state.open({ page: "detail", id: "s" });
  f.state.addFiles("s", [new File(["png"], "a.png", { type: "image/png" }), new File(["x"], "a.txt", { type: "text/plain" })]);
  await flush();
  assert.deepEqual(f.state.snapshot().uploads.s.map(u => u.status), ["ready", "error"]);
  await Promise.all([f.state.loadModels("claude@test"), f.state.loadModels("claude@test")]);
  assert.equal(catalogCalls, 1); assert.equal(f.state.snapshot().models["claude@test"].models[0].model, "m");
  const ref = f.state.snapshot().uploads.s[0].ref!;
  f.state.setDraft("s", "看图");
  await f.state.submit("/sessions/s/turns", { input: "看图", delivery: "start_turn", model: "m", attachments: [ref] }, "s"); await flush();
  const post = f.requests.find(r => r.path === "/api/v1/sessions/s/turns")!;
  assert.deepEqual(JSON.parse(String(post.init.body)).attachments, [ref]);
  assert.deepEqual(f.state.snapshot().uploads.s.map(u => u.status), ["error"], "sent uploads clear; rejected ones stay visible");
  assert.equal(f.state.snapshot().drafts.s, "");
});

test("approval decisions and answers go through the tracked action flow", async t => {
  const f = fixture(t, { write: () => json({ actionId: "a", kind: "resolve_approval", status: "succeeded", sessionId: "s", turnId: null }) });
  await f.state.open({ page: "detail", id: "s" });
  await f.state.submit("/approvals/p%201/decision", { choice: "allow" });
  const post = f.requests.find(r => r.init.method === "POST")!;
  assert.equal(post.path, "/api/v1/approvals/p%201/decision"); assert.deepEqual(JSON.parse(String(post.init.body)), { choice: "allow" });
  assert.ok(new Headers(post.init.headers).get("idempotency-key"));
  assert.equal(f.state.snapshot().intent?.receipt?.status, "succeeded");
});

test("read mode refuses writes without probing server permission", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return json({}); });
  const state = new ControlState("read", false, snapshot, () => {}, () => {}); t.after(() => state.dispose());
  await state.submit("/sessions", { workerId: "claude@test", workspace: "/repo" }); assert.equal(calls, 0);
});

test("final tail fills a missing event between known anchors without moving loaded older history", () => {
  const events = ["old", "a", "b", "c", "new"].map(id => event(id).data as import("../apps/control-center/src/api/types.js").SessionEvent);
  assert.deepEqual(mergeTail([events[0], events[1], events[3]], [events[1], events[2], events[3], events[4]]).map(e => e.eventId), ["old", "a", "b", "c", "new"]);
});

test("unauthorized response invalidates authentication, forbidden remains a scope error", async t => {
  let logout = 0; const client = new ControlClient("read", () => logout++); t.after(() => client.dispose());
  t.mock.method(globalThis, "fetch", async () => json({ error: { code: "forbidden", message: "write required" } }, 403));
  await assert.rejects(client.post("/sessions/s/interrupt", {}, "a"), (e: ApiError) => e.status === 403);
  assert.equal(logout, 0);
  t.mock.method(globalThis, "fetch", async () => json({ error: { code: "unauthorized", message: "expired" } }, 401));
  await assert.rejects(client.request("/workers"), ApiError); assert.equal(logout, 1);
});

test("stale-build check compares the running entry with the served one", async () => {
  const { entryOf, newerBuild } = await import("../apps/control-center/src/build.js");
  const html = (name: string) => `<!doctype html><script type="module" crossorigin src="/control/assets/${name}.js"></script>`;
  assert.equal(entryOf(html("index-new")), "/control/assets/index-new.js");
  assert.equal(entryOf("<title>dev</title><script type=\"module\" src=\"/src/main.tsx\"></script>"), undefined);
  const serve = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch;
  assert.equal(await newerBuild("/control/assets/index-old.js", serve(html("index-new"))), true);
  assert.equal(await newerBuild("/control/assets/index-new.js", serve(html("index-new"))), false);
  assert.equal(await newerBuild("/control/assets/index-old.js", serve(html("index-new"), 503)), false);
  assert.equal(await newerBuild("/control/assets/index-old.js", (async () => { throw new TypeError("redirect"); }) as typeof fetch), false);
});

test("installable app: manifest and service worker are served with their types and allowed by the CSP", async () => {
  await mkdir(resolve(".runtime/tests"), { recursive: true });
  const directory = await mkdtemp(resolve(".runtime/tests/pwa-"));
  await writeFile(resolve(directory, "index.html"), "<!doctype html><title>shell</title>");
  await writeFile(resolve(directory, "manifest.webmanifest"), "{}");
  await writeFile(resolve(directory, "sw.js"), "self.addEventListener('fetch', () => {});");
  const app = createControlWeb(directory);
  const manifest = await app.request("/control/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type")!, /^application\/manifest\+json/);
  const worker = await app.request("/control/sw.js");
  assert.match(worker.headers.get("content-type")!, /javascript/);
  assert.equal(worker.headers.get("cache-control"), "no-cache");
  const csp = (await app.request("/control/sessions")).headers.get("content-security-policy")!;
  assert.match(csp, /manifest-src 'self'/); assert.match(csp, /worker-src 'self'/);
});

test("agent markdown renders GFM and CJK emphasis but keeps raw HTML as text", async () => {
  const { createElement, renderToStaticMarkup } = await import("../apps/control-center/test/render.js");
  const { MessageText } = await import("../apps/control-center/src/markdown.js");
  const html = renderToStaticMarkup(createElement(MessageText, { markdown: true,
    text: "<img src=x onerror=alert(1)> **结论。**后文 [a](https://example.com)\n\n| x |\n|---|\n| 1 |" }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong>结论。<\/strong>后文/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<table>/);
  const plain = renderToStaticMarkup(createElement(MessageText, { markdown: false, text: "**as typed**" }));
  assert.match(plain, /\*\*as typed\*\*/);
});
