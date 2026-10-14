import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { windowsPump } from "../deploy/wsl-browser/windows-pump.mjs";

async function listen(t, host, port = 0, handler = () => {}) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  server.listen({ host, port, ipv6Only: true });
  await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server.address().port;
}

function pump(t, port, timeout = 1000) {
  const child = spawn(process.execPath, ["-e", windowsPump(port, timeout)]);
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const done = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
  t.after(() => child.kill());
  return { child, done };
}

test("prefers Chrome on IPv6 over the WSL IPv4 forwarding listener", { timeout: 5000 }, async t => {
  const port = await listen(t, "::1", 0, socket => socket.once("data", data => socket.end(data)));
  let ipv4Connections = 0;
  await listen(t, "127.0.0.1", port, () => { ipv4Connections++; });
  const { child, done } = pump(t, port);
  const payload = Buffer.from([0, 255, 10, 13, 128]);
  child.stdin.write(payload);
  const result = await done;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, payload.toString());
  assert.equal(ipv4Connections, 0);
});

test("falls back to Chrome on IPv4 when no IPv6 listener exists", { timeout: 5000 }, async t => {
  const port = await listen(t, "127.0.0.1", 0, socket => socket.once("data", data => socket.end(data)));
  const { child, done } = pump(t, port);
  child.stdin.write("CDP response");
  assert.deepEqual(await done, { code: 0, stdout: "CDP response", stderr: "" });
});

test("exits when the Windows endpoint accepts but never responds", { timeout: 5000 }, async t => {
  const port = await listen(t, "::1");
  const { child, done } = pump(t, port, 150);
  child.stdin.write("GET /json/version HTTP/1.1\r\n\r\n");
  assert.match((await done).stderr, /handshake timed out/);
});

test("disconnecting the WSL client closes an idle Windows connection", { timeout: 5000 }, async t => {
  const port = await listen(t, "::1");
  const { child, done } = pump(t, port);
  child.stdin.end();
  assert.equal((await done).stderr, "");
});
