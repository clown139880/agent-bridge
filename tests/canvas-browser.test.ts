import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { getRequestListener } from "../apps/control-plane/node_modules/@hono/node-server/dist/index.js";
import { CanvasService } from "../apps/control-plane/src/canvas.js";
import { createCanvasWeb } from "../apps/control-plane/src/canvas-web.js";

test("canvas browser: lazy direct images, live updates, cursor resume, safe text, image errors and page reload", {
  skip: !existsSync("/usr/bin/chromium"), timeout: 40_000,
}, async t => {
  await mkdir(resolve(".runtime/tests"), { recursive: true });
  const directory = await mkdtemp(resolve(".runtime/tests/canvas-browser-"));
  const canvas = new CanvasService({ dataDir: directory }), app = getRequestListener(createCanvasWeb(canvas, true).fetch, { overrideGlobalObjects: false });
  const imageRequests: string[] = [], streamRequests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url!.startsWith("/images/")) {
      imageRequests.push(req.url!); assert.equal(req.headers.referer, undefined); assert.equal(req.headers.authorization, undefined);
      if (req.url!.includes("broken")) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#284b63"/><circle cx="500" cy="300" r="150" fill="#b8dae8"/></svg>'); return;
    }
    if (req.url!.includes("/events?")) streamRequests.push(req.url!);
    void app(req, res);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { canvas.stop(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (tool: string, args: Record<string, unknown>) => canvas.call(tool, args, "agent:test") as Promise<any>;
  const created = await call("create", { title: "实时画布 · 浏览器验收", idempotency_key: "c" }), id = created.canvas_id;
  const image = (n: number) => call("push", { canvas_id: id, idempotency_key: `a${n}`, url: `${base}/images/${n}`, description: `第 ${n} 张` });
  for (let n = 1; n <= 5; n++) await image(n);
  const chrome = spawn("/usr/bin/chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0",
    "--no-proxy-server", `--user-data-dir=${directory}/profile`, `--disk-cache-dir=${directory}/cache`, "--no-first-run", "--no-default-browser-check", "about:blank"], {
    env: { ...process.env, TMPDIR: directory, XDG_CONFIG_HOME: `${directory}/config`, XDG_CACHE_HOME: `${directory}/cache` }, stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { chrome.kill("SIGTERM"); });
  const endpoint = await new Promise<string>((done, fail) => {
    let output = "";
    const timer = setTimeout(() => fail(new Error("Chromium timeout")), 10_000);
    chrome.stderr.on("data", chunk => { output += chunk; const found = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) { clearTimeout(timer); done(found[1]!); } });
    chrome.on("error", fail);
  });
  const socket = new WebSocket(endpoint); await new Promise<void>(r => socket.once("open", r)); t.after(() => socket.close());
  let next = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>(), exceptions: unknown[] = [];
  socket.on("message", raw => {
    const m = JSON.parse(raw.toString()); if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params);
    if (m.id) { const callback = pending.get(m.id); pending.delete(m.id); m.error ? callback?.reject(new Error(m.error.message)) : callback?.resolve(m.result); }
  });
  const cdp = (method: string, params: any = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const target = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const command = (method: string, params: any = {}) => cdp(method, params, sessionId);
  const js = async (expression: string) => {
    const r = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  };
  const wait = async (expression: string) => {
    const end = Date.now() + 6000;
    while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 30)); }
    throw new Error(`UI timed out: ${expression}; ${await js("document.body.innerText")}`);
  };
  await command("Runtime.enable"); await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command("Page.navigate", { url: `${base}/canvas/${id}/` });
  await wait("document.querySelector('#count')?.textContent === '5 / 5' && !!document.querySelector('img.visible')");
  assert.deepEqual(imageRequests, ["/images/5"], "opening the page must not download every source image");
  await js("document.getElementById('previous').click()");
  await wait("document.getElementById('count').textContent === '4 / 5'");
  await image(6); await wait("document.getElementById('count').textContent === '4 / 6'");
  await js("document.getElementById('follow').click()");
  await wait("document.getElementById('count').textContent === '6 / 6'");
  await js("Object.defineProperty(document,'hidden',{configurable:true,get:()=>!!window.__hidden});window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'))");
  await new Promise(r => setTimeout(r, 50));
  const added = await image(7);
  const injection = "<img src=x onerror=alert(1)>";
  await call("push", { canvas_id: id, image_id: added.image_id, expected_revision: added.revision, idempotency_key: "description", description: injection });
  await js("window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'))");
  await wait("document.getElementById('count').textContent === '7 / 7'");
  assert.equal(await js("document.getElementById('caption').textContent"), injection);
  assert.equal(await js("document.getElementById('caption').children.length"), 0);
  assert.match(streamRequests.at(-1)!, /cursor=7$/);
  const mobile = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(directory, "mobile.png"), Buffer.from(mobile.data, "base64"));
  const revision = (await canvas.get(id)).images.at(-1)!.updated_seq;
  await call("push", { canvas_id: id, image_id: added.image_id, expected_revision: revision, idempotency_key: "broken", url: `${base}/images/broken` });
  await wait("!document.getElementById('empty').hidden && document.getElementById('empty').textContent.includes('无法加载')");
  assert.equal(await js("document.getElementById('progress')"), null);
  assert.equal(await js("document.getElementById('reconnect')"), null);
  await command("Page.reload"); await wait("document.getElementById('connection').textContent === '实时连接'");
  await image(8); await wait("document.getElementById('count').textContent === '8 / 8' && document.getElementById('empty').hidden");
  assert.deepEqual(exceptions, []);
  console.log(`Canvas browser screenshot: ${directory}/mobile.png`);
});
