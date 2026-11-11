import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { transcriber } from "../apps/control-plane/src/transcribe.js";

test("without TokensAPI the fallback server transcribes; /api/v1/transcriptions returns the words", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { seen.push(`${request.url} ${body.includes('name="model"\r\n\r\nsensevoice-small') ? "model" : ""} ${body.includes("OggS") ? "file" : ""}`);
      response.end(JSON.stringify({ text: " 你好 " })); });
  }).listen(0);
  const port = (server.address() as { port: number }).port;
  const transcribe = transcriber({ model: "qwen3-asr", fallbackUrl: `http://127.0.0.1:${port}/v1/`, fallbackModel: "sensevoice-small", timeoutMs: 5_000 });
  try {
    assert.equal(await transcribe({ bytes: Buffer.from("OggS"), mimeType: "audio/ogg", filename: "v.ogg" }), "你好");
    assert.deepEqual(seen, ["/v1/audio/transcriptions model file"]);
    await assert.rejects(transcriber({ model: "qwen3-asr", fallbackModel: "x", timeoutMs: 1_000 })({ bytes: Buffer.from("a"), mimeType: "audio/ogg", filename: "v" }),
      /no speech-to-text configured/);

    const { randomUUID } = await import("node:crypto");
    const { rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Store } = await import("../packages/database/src/index.js");
    const { ControlPlane } = await import("../apps/control-plane/src/server.js");
    const path = join(tmpdir(), `asr-${randomUUID()}.sqlite`), store = new Store(path);
    const control = new ControlPlane(store, { host: "127.0.0.1", port: 0, controlApiWriteToken: "w", sse: { keepaliveMs: 50, pollMs: 5, maxBackpressure: 3 },
      transcribe: { model: "", fallbackUrl: `http://127.0.0.1:${port}/v1`, fallbackModel: "sensevoice-small", timeoutMs: 5_000 } }) as any;
    await control.start();
    try {
      const post = (body: unknown) => fetch(`http://127.0.0.1:${control.http.address().port}/api/v1/transcriptions`, { method: "POST",
        headers: { authorization: "Bearer w", "content-type": "application/json" }, body: JSON.stringify(body) });
      const ok = await post({ mimeType: "audio/ogg", content: Buffer.from("OggS").toString("base64") });
      assert.deepEqual([ok.status, await ok.json()], [200, { text: "你好" }]);
      assert.equal((await post({ mimeType: "image/png", content: "aGk=" })).status, 400);
    } finally { await control.stop(); store.db.close(); rmSync(path, { force: true }); }
  } finally { server.close(); }
});
