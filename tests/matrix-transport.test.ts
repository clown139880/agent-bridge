import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SdkMatrixTransport } from "../apps/control-plane/src/matrix/transport.js";
import type { MatrixConfig } from "../apps/control-plane/src/matrix/config.js";

test("SDK transport persists its device, preserves transaction ids and downloads authenticated bounded media", { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-sdk-"));
  const requests: Array<{ path: string; method?: string; body: any; auth?: string }> = [];
  let large = false;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, "http://localhost").pathname;
    if (process.env.MATRIX_TEST_TRACE) process.stderr.write(`${req.method} ${path}\n`);
    requests.push({ path, method: req.method, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
    const json = (data: unknown): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path.endsWith("/login")) return json({ user_id: "@bot:test", access_token: "fixture-access-token", device_id: "device" });
    if (path.endsWith("/account/whoami")) return json({ user_id: "@bot:test", device_id: "device" });
    if (path.includes("/join/")) return json({ room_id: "!room:test" });
    if (path.endsWith("/sync")) return json({ next_batch: "next", rooms: { join: {} } });
    if (path.includes("/send/")) return json({ event_id: "$sent" });
    if (path.includes("/messages")) return json({ chunk: [], end: "end" });
    if (path.includes("/download/")) { const bytes = large ? Buffer.alloc(100) : Buffer.from("image"); res.writeHead(200, { "content-length": bytes.length }); res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const config: MatrixConfig = { homeserver: `http://127.0.0.1:${address.port}`, userId: "@bot:test", password: "fixture-password",
    stateFile: join(dir, "device.json"), rooms: [{ roomId: "!room:test", scopeId: "test", users: ["@human:test"], defaultTarget: "codex", targets: { codex: { workerId: "codex@dev", workspace: "/tmp" } } }] };
  const first = new SdkMatrixTransport(config), second = new SdkMatrixTransport(config);
  t.after(async () => { first.close(); second.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  await first.open();
  assert.equal(statSync(config.stateFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(config.stateFile, "utf8")).deviceId, "device");
  assert.equal((await first.sync("before")).next_batch, "next");
  assert.equal(await first.send("!room:test", "m.room.message", { body: "hello", msgtype: "m.notice" }, "stable-txn"), "$sent");
  assert.equal((await first.download("mxc://test/file", 20)).toString(), "image");
  large = true; await assert.rejects(first.download("mxc://test/file", 20), /too_large/);
  await assert.rejects(first.download("https://untrusted.test/file", 20), /invalid_matrix_media_uri/);
  first.close(); await second.open();
  await second.send("!room:test", "m.room.message", { body: "hello", msgtype: "m.notice" }, "stable-txn");
  assert.equal(requests.filter(r => r.path.endsWith("/login")).length, 1);
  const sends = requests.filter(r => r.path.includes("/send/"));
  assert.equal(sends[0]!.path, sends[1]!.path);
  assert.ok(requests.filter(r => r.path.includes("/download/")).every(r => r.auth === "Bearer fixture-access-token"));
});
