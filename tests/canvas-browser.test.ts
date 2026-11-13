import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { getRequestListener } from "../apps/control-plane/node_modules/@hono/node-server/dist/index.js";
import { CanvasService } from "../apps/control-plane/src/canvas.js";
import { createCanvasWeb } from "../apps/control-plane/src/canvas-web.js";

test("canvas browser: image actions, mixed video playback and cleanup, live updates, resume and reload", {
  skip: !existsSync("/usr/bin/chromium"), timeout: 60_000,
}, async t => {
  await mkdir(resolve(".runtime/tests"), { recursive: true });
  const directory = await mkdtemp(resolve(".runtime/tests/canvas-browser-"));
  const canvas = new CanvasService({ dataDir: directory }), app = getRequestListener(createCanvasWeb(canvas, true).fetch, { overrideGlobalObjects: false });
  // Eight-second VP8 fixture generated with ffmpeg's color source; no remote media or runtime encoder needed.
  const clip = await readFile(new URL("./fixtures/canvas-video.webm", import.meta.url));
  const imageRequests: string[] = [], videoRequests: string[] = [], streamRequests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url!.startsWith("/videos/")) {
      videoRequests.push(req.url!); assert.equal(req.headers.referer, undefined); assert.equal(req.headers.authorization, undefined);
      if (req.url!.includes("broken")) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "video/webm", "content-length": clip.length }); res.end(clip); return;
    }
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
    throw new Error(`UI timed out: ${expression}; ${await js("document.body.innerText")}; media=${await js("JSON.stringify((()=>{const v=document.getElementById('video');return {paused:v.paused,ended:v.ended,time:v.currentTime,duration:v.duration,ready:v.readyState,network:v.networkState,error:v.error?.message}})())")}`);
  };
  const checkImageActions = async (number: number) => {
    const expected = `${base}/images/${number}`;
    await wait(`document.querySelector('img.visible')?.src === ${JSON.stringify(expected)}`);
    const hit = await js("document.elementFromPoint(195, 400)?.src");
    assert.equal(hit, expected, "a transparent image must not intercept the current image's pointer actions");
    await js("window.__context=null;window.__drag=null;document.addEventListener('contextmenu',e=>{window.__context=e.target.src;e.preventDefault()},{once:true});document.addEventListener('dragstart',e=>{window.__drag={src:e.target.src,uri:e.dataTransfer.getData('text/uri-list')};e.preventDefault()},{once:true})");
    await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 195, y: 400, button: "right", buttons: 2, clickCount: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 195, y: 400, button: "right", buttons: 0, clickCount: 1 });
    assert.equal(await js("window.__context"), expected, "the context menu's image must be the displayed image");
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: 195, y: 400 });
    await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 195, y: 400, button: "left", buttons: 1, clickCount: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: 235, y: 420, button: "left", buttons: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 235, y: 420, button: "left", buttons: 0, clickCount: 1 });
    const drag = await js("window.__drag");
    assert.equal(drag?.src, expected); assert.ok(drag.uri.includes(expected), "native drag data must contain the current image URL");
  };
  await command("Runtime.enable"); await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command("Page.navigate", { url: `${base}/canvas/${id}/` });
  await wait("document.querySelector('#count')?.textContent === '5 / 5' && !!document.querySelector('img.visible')");
  assert.deepEqual(imageRequests, ["/images/5"], "opening the page must not download every source image");
  await checkImageActions(5);
  await js("document.getElementById('previous').click()");
  await wait("document.getElementById('count').textContent === '4 / 5'");
  await checkImageActions(4);
  await js("document.getElementById('previous').click()");
  await checkImageActions(3);
  await js("document.getElementById('next').click()");
  await checkImageActions(4);
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

  await js("document.getElementById('follow').click()");
  await call("push", { canvas_id: id, idempotency_key: "video-extension", url: `${base}/videos/clip.WEBM?signature=test`, description: "视频" });
  await call("push", { canvas_id: id, idempotency_key: "video-explicit", url: `${base}/videos/opaque`, media_type: "video" });
  await wait("document.getElementById('count').textContent === '8 / 10'");
  assert.deepEqual(videoRequests, [], "unselected videos must not fetch metadata or content");
  await js("document.getElementById('next').click()");
  await wait("document.getElementById('count').textContent === '9 / 10' && !document.getElementById('video').paused && document.getElementById('video').currentTime > 0.1");
  assert.equal(await js("document.getElementById('video').muted && document.getElementById('video').controls && document.getElementById('video').playsInline"), true);
  assert.equal(await js("document.querySelectorAll('#stage img[src]').length"), 0, "video selection releases old image sources");
  assert.equal(await js("(()=>{const r=document.getElementById('video').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.bottom-12)?.id})()"), "video", "the footer must not cover native video controls");
  await js("Object.defineProperty(document,'hidden',{configurable:true,get:()=>!!window.__hidden});window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await js("document.getElementById('video').paused"), true);
  const pausedAt = await js("document.getElementById('video').currentTime");
  await js("window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'))");
  await wait(`!document.getElementById('video').paused && document.getElementById('video').currentTime > ${pausedAt}`);
  await js("document.getElementById('video').pause();window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await js("document.getElementById('video').paused"), true, "returning to a tab must preserve a user's pause");
  await js("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  assert.equal(await js("document.getElementById('video').hasAttribute('src')"), false);
  await js("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await wait("!document.getElementById('video').paused && document.getElementById('video').currentTime > 0.1");
  const videoScreenshot = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(directory, "video-mobile.png"), Buffer.from(videoScreenshot.data, "base64"));
  await js("document.getElementById('video').currentTime=0;document.getElementById('play').click()");
  await wait("!document.getElementById('video').paused && document.getElementById('video').currentTime > 0.1");
  await new Promise(r => setTimeout(r, 5200));
  assert.equal(await js("document.getElementById('count').textContent"), "9 / 10", "slideshow must not cut a video off after five seconds");
  await wait("document.getElementById('count').textContent === '10 / 10' && document.getElementById('video').currentSrc.endsWith('/videos/opaque') && !document.getElementById('video').paused");
  await js("document.getElementById('play').click();document.getElementById('previous').click();document.getElementById('previous').click()");
  await wait("document.getElementById('count').textContent === '8 / 10' && !!document.querySelector('img.visible')");
  assert.equal(await js("document.getElementById('video').hidden && document.getElementById('video').paused && !document.getElementById('video').hasAttribute('src')"), true, "leaving video must stop playback and release its source");
  await checkImageActions(8);
  await js("document.getElementById('follow').click()");
  await call("push", { canvas_id: id, idempotency_key: "video-broken", url: `${base}/videos/broken.mp4` });
  await wait("!document.getElementById('empty').hidden && document.getElementById('empty').textContent.includes('视频暂时无法播放')");
  await image(12); await wait("document.getElementById('count').textContent === '12 / 12' && document.getElementById('empty').hidden");
  assert.deepEqual(exceptions, []);
  console.log(`Canvas browser screenshot: ${directory}/mobile.png`);
});
