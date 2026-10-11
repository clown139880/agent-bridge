import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { managedAppServerUrl, stopManagedAppServer } from "../apps/bridge/src/managed-app-server.js";

test("managed loopback endpoint avoids a listening foreign server and preserves unmanaged addresses", async () => {
  const foreign = createServer();
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  try {
    const address = foreign.address();
    assert.ok(address && typeof address !== "string");
    const configured = `ws://127.0.0.1:${address.port}`;
    const endpoint = await managedAppServerUrl(configured);
    assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+$/);
    const allocated = new URL(endpoint);
    assert.notEqual(Number(allocated.port), address.port);
    assert.equal(allocated.hostname, "127.0.0.1");
    assert.equal(foreign.listening, true);
    assert.equal(await managedAppServerUrl("ws://192.0.2.1:4500"), "ws://192.0.2.1:4500");
  } finally { await new Promise<void>(resolve => foreign.close(() => resolve())); }
});

test("stopping an owned launcher also releases its native child's listener", { timeout: 15_000 }, async () => {
  const native = `const net=require('node:net');process.on('SIGTERM',()=>{});const server=net.createServer();server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`;
  const launcher = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(native)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", launcher], { detached: process.platform !== "win32", windowsHide: true });
  try {
    const [data] = await once(child.stdout!, "data");
    const port = Number(data.toString().trim());
    assert.ok(port > 0);
    await stopManagedAppServer(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    const probe = createServer();
    // Process exit notifications and the descendant's final socket close can differ slightly.
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);probe.listen(port, "127.0.0.1", resolve);
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await new Promise<void>(resolve => probe.close(() => resolve()));
  } finally { await stopManagedAppServer(child); }
});
