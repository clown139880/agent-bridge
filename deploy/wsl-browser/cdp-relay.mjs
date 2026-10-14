// Relays WSL 127.0.0.1:<port> to the Windows host's 127.0.0.1:<port> without
// changing WSL networking. Each accepted connection spawns a Windows node.exe
// through WSL interop that connects to the Windows loopback and pipes bytes over
// stdio, so the shared Chrome keeps listening on Windows loopback only and the
// Host header (and therefore the returned webSocketDebuggerUrl) stays 127.0.0.1.
import { spawn } from "node:child_process";
import net from "node:net";
import pino from "pino";
import { windowsPump } from "./windows-pump.mjs";

const log = pino({ name: "cdp-relay" });
const port = Number(process.env.CDP_RELAY_PORT ?? 9222);
const windowsNode = process.env.CDP_RELAY_WINDOWS_NODE ?? "/mnt/c/Program Files/nodejs/node.exe";
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid CDP_RELAY_PORT: ${port}`);

const pump = windowsPump(port);
const children = new Set();

const server = net.createServer((client) => {
  // Bound a recursive localhost-forwarding failure even if Windows interop
  // itself stalls before the pump's handshake timer can run.
  if (children.size >= 32) { client.destroy(); return; }
  const child = spawn(windowsNode, ["-e", pump], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  const timer = setTimeout(() => { client.destroy(); child.kill(); }, 10000);
  child.stdout.once("data", () => clearTimeout(timer));
  child.stderr.on("data", (data) => log.warn({ detail: data.toString().trim() }, "Windows CDP relay error"));
  client.pipe(child.stdin);
  child.stdout.pipe(client);
  client.on("error", () => child.kill());
  client.on("close", () => child.kill());
  child.stdin.on("error", () => client.destroy());
  child.on("error", (error) => { log.warn({ error }, "Windows relay process failed to start"); client.destroy(); });
  child.on("close", () => { clearTimeout(timer); children.delete(child); client.destroy(); });
});

server.on("error", (error) => { log.error({ error }, "CDP relay listener failed"); process.exit(1); });
server.listen(port, "127.0.0.1", () => log.info({ port, windowsNode }, "CDP relay listening"));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    for (const child of children) child.kill();
    process.exit(0);
  });
}
