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

test("after a turn of an unnamed Pi or Codex session completes, it is titled once; Claude names its own", async () => {
  const { randomUUID } = await import("node:crypto");
  const { rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../packages/database/src/index.js");
  const { ControlPlane } = await import("../apps/control-plane/src/server.js");
  const path = join(tmpdir(), `title-${randomUUID()}.sqlite`), store = new Store(path);
  store.upsertMachine({ id: "hal", name: "HAL", platform: "linux", hostname: "hal", capabilities: [] });
  for (const [id, agentType] of [["p", "pi"], ["c", "claude-code"]] as const) store.createSession({ id, machineId: "hal", agentType, projectName: "x",
    projectPath: "/x", matrixRoomId: "", matrixThreadId: null, nativeSessionId: id, status: "working", createdAt: 1, updatedAt: 1 });
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0, sse: { keepaliveMs: 50, pollMs: 5, maxBackpressure: 3 } }) as any;
  const asked: string[][] = [];
  control.titler = async (prompts: string[]) => { asked.push(prompts); return "查日志"; };
  try {
    for (const id of ["p", "c"]) {
      await control.handleBridgeMessage("hal", { type: "session.event", sessionId: id, eventId: `${id}1`, eventType: "message.completed", turnId: "t",
        timestamp: 1, payload: { role: "user", text: "帮我看看日志" } });
      for (const n of [2, 3]) await control.handleBridgeMessage("hal", { type: "session.event", sessionId: id, eventId: `${id}${n}`, eventType: "turn.completed",
        turnId: `t${n}`, timestamp: n, payload: {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(asked, [["帮我看看日志"]], "once, and never for Claude");
    assert.equal(control.controlStore.session("p").title, "查日志");
  } finally { store.db.close(); rmSync(path, { force: true }); }
});

