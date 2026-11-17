import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../packages/database/src/index.js";
import { ToolHub } from "../apps/control-plane/src/tools.js";
import { tokensapiCall } from "../apps/control-plane/src/tokensapi-media.js";
import type { SecretStore } from "../apps/control-plane/src/secrets.js";

const secrets = { value: async (key: string) => key === "TOKENSAPI_API_KEY" ? "sk-test" : undefined } as unknown as SecretStore;
const task = (status: string, extra: Record<string, unknown> = {}) => ({ task_id: "task_1", status, progress: status === "succeeded" ? 100 : 30, results: [], error: null, manifest: null, ...extra });
const done = task("succeeded", { results: [{ index: 0, url: "https://s3.example/out.png" }], manifest: { url: "https://s3.example/m.json" } });

/** Answers TokensAPI requests from a script, recording what was sent. */
function fakeFetch(answers: Array<Response | (() => Response)>) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("generate_image submits image2 with the idempotency key, waits on the server and answers with the URLs", async () => {
  const f = fakeFetch([Response.json(task("queued")), Response.json(task("running")), Response.json(done)]);
  try {
    const result = await tokensapiCall({ secrets, pollMs: 5 }, "generate_image",
      { prompt: "螺旋星核", idempotency_key: "k1", reference_urls: ["https://cdn.example/ref.png"] });
    assert.deepEqual(result, { task_id: "task_1", status: "succeeded", urls: ["https://s3.example/out.png"], manifest_url: "https://s3.example/m.json" });
    const [submit, ...polls] = f.seen;
    assert.equal(submit!.url, "https://tokensapi.ai/v1/tasks/images");
    assert.equal(submit!.headers["idempotency-key"], "k1");
    assert.equal(submit!.headers.authorization, "Bearer sk-test");
    assert.deepEqual(submit!.body, { model: "image2", prompt: "螺旋星核", n: 1, aspect_ratio: "1:1",
      input_references: [{ type: "image_url", slot_name: "reference_1", image_url: { url: "https://cdn.example/ref.png" } }] });
    assert.deepEqual(polls.map((item) => item.url), ["https://tokensapi.ai/v1/tasks/task_1", "https://tokensapi.ai/v1/tasks/task_1"]);
  } finally { f.restore(); }
});

test("generate_video answers with the task at once; get_task rides out a transient error and stops at the wait", async () => {
  const f = fakeFetch([Response.json(task("queued")), new Response("busy", { status: 503 }), Response.json(task("running")), () => Response.json(task("running"))]);
  try {
    const submitted = await tokensapiCall({ secrets }, "generate_video", { prompt: "海浪", idempotency_key: "k2", first_frame_url: "https://cdn.example/f.png", duration: 10 });
    assert.equal(submitted.status, "queued");
    assert.match(String(submitted.next), /get_task/);
    assert.deepEqual(f.seen[0]!.body, { model: "minimax_h3", prompt: "海浪", n: 1, aspect_ratio: "16:9", resolution: "480p", duration: 10, generate_audio: true,
      frame_images: [{ type: "image_url", frame_type: "first_frame", image_url: { url: "https://cdn.example/f.png" } }] });
    const polled = await tokensapiCall({ secrets, pollMs: 5 }, "get_task", { task_id: "task_1", wait_seconds: 0.012 });
    assert.equal(polled.status, "running");
    assert.equal(polled.urls, undefined);
  } finally { f.restore(); }
});

test("failures are TokensAPI's own codes; a missing key says so", async () => {
  const f = fakeFetch([Response.json({ error: { code: "E4001", type: "TASK_NOT_FOUND", message: "The task was not found." } }, { status: 404 }),
    Response.json(task("failed", { error: { code: "E5001", message: "GENERATION_FAILED" } }))]);
  try {
    await assert.rejects(tokensapiCall({ secrets }, "get_task", { task_id: "nope" }), { code: "TASK_NOT_FOUND", message: /404 E4001/ });
    const failed = await tokensapiCall({ secrets }, "get_task", { task_id: "task_1" });
    assert.deepEqual([failed.status, failed.error], ["failed", { code: "E5001", message: "GENERATION_FAILED" }]);
    await assert.rejects(tokensapiCall({ secrets: { value: async () => undefined } as unknown as SecretStore }, "get_task", { task_id: "x" }), { code: "key_missing" });
    await assert.rejects(tokensapiCall({ secrets }, "generate_image", { prompt: "x" }), { code: "invalid_arguments" });
  } finally { f.restore(); }
});

test("the library serves tokensapi as a builtin with the registry's risk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-hub-")), registry = join(dir, "registry.yaml");
  writeFileSync(registry, "servers:\n  tokensapi: { title: TokensAPI 出图与视频, transport: { builtin: tokensapi }, pinned: [_global], risk: { auto: ['*'] } }\n");
  const store = new Store(":memory:"), hub = new ToolHub(store.db, { registry, secrets });
  const f = fakeFetch([Response.json({ upload_url: "https://s3.example/put", upload_method: "PUT", required_headers: { "Content-Length": "3" }, access_url: "https://cdn.example/a.png" }),
    Response.json({ error: { type: "INVALID_FILE_SIZE", message: "bad size" } }, { status: 400 })]);
  try {
    assert.deepEqual(hub.pinned("anything"), ["tokensapi"]);
    const found = await hub.search("TokensAPI 出图");
    assert.deepEqual(found.tools.map((tool) => [tool.name, tool.risk]).sort(), [["tokensapi.create_upload", "auto"], ["tokensapi.generate_image", "auto"],
      ["tokensapi.generate_video", "auto"], ["tokensapi.get_task", "auto"]]);
    const upload = await hub.call("tokensapi.create_upload", { mime_type: "image/png", file_size: 3 }, "agent:codex") as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(upload.content[0]!.text).access_url, "https://cdn.example/a.png");
    const failed = await hub.call("tokensapi.create_upload", { mime_type: "image/png", file_size: 0 }, "agent:codex") as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0]!.text).error, "INVALID_FILE_SIZE");
    await assert.rejects(hub.call("tokensapi.nope", {}, "agent:codex"), /unknown tool/);
  } finally { f.restore(); hub.stop(); store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
