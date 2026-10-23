import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { getRequestListener } from "../apps/control-plane/node_modules/@hono/node-server/dist/index.js";
import { createControlWeb } from "../apps/control-plane/src/web/app.js";

// Browser validation uses only fixture HTTP data and a repository-local Chromium profile.
test("mobile browser on non-secure HTTP: no-login entry, paging, history/SSE, send, steer, interrupt, create, and server-only credentials", {
  skip: !existsSync("/usr/bin/chromium") || !existsSync("apps/control-center/dist/index.html"), timeout: 60_000,
}, async t => {
  await mkdir(resolve(".runtime/tests"), { recursive: true });
  const directory = await mkdtemp(resolve(".runtime/tests/browser-"));
  const writes: { path: string; body: any; key?: string }[] = [], streams = new Set<import("node:http").ServerResponse>();
  const actions = new Map<string, Record<string, unknown>>();
  let streamId = 0, turn = "turn-one", busy = true, writable = true, slowDetailMs = 0;
  const worker = { id: "claude@test", name: "Claude @ Test", status: "online", capabilities: ["session-actions", "turn-steer", "turn-interrupt"],
    workspaces: ["/work/repo"], recentWorkspaces: [{ name: "repo", path: "/work/repo" }] };
  const summary = (id = "s-active") => ({ sessionId: id, workerId: worker.id, machineId: "test", agent: "claude-code",
    title: id === "s-active" ? "移动端验收会话" : id === "created" ? "新建验收会话" : `历史会话 ${id}`, projectName: "repo", workspace: "/work/repo",
    status: busy ? "active" : "idle", activeTurnId: busy ? turn : null, pendingApprovalCount: 0, pendingUserInputCount: 0,
    createdAt: 1000, updatedAt: 2000, capabilities: worker.capabilities, historyCompleteness: "full", source: "fixture" });
  const sessions = Array.from({ length: 53 }, (_, i) => summary(i === 0 ? "s-active" : `s-${i}`));
  const events: any[] = Array.from({ length: 130 }, (_, i) => ({ eventId: `msg-${i}`, cursor: `e:${i}`, sessionId: "s-active", type: "message.completed", turnId: "old-turn",
    timestamp: 2000 + i, payload: { role: i % 2 ? "assistant" : "user", text: i === 129 ? "历史尾页最后一条" : `历史消息 ${i}` } }));
  const emit = (type: string, data: any, sessionId: string | null = "s-active") => {
    const cursor = `c:${++streamId}:0`, value = { cursor, eventId: `wire-${streamId}`, type, sessionId, resource: { kind: "session", id: sessionId ?? "global" }, data };
    streams.forEach(r => r.write(`id: ${cursor}\nevent: bridge.event\ndata: ${JSON.stringify(value)}\n\n`));
  };
  const web = getRequestListener(createControlWeb().fetch, { overrideGlobalObjects: false });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://test");
    if (!url.pathname.startsWith("/control/api/v1/")) { void web(req, res); return; }
    url.pathname = url.pathname.replace("/control/api/v1/", "/api/v1/");
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    assert.equal(req.headers.authorization, undefined, "browser must never send a Control token");
    assert.equal(req.headers["x-control-center"], "1");
    if (url.pathname === "/api/v1/access") return send({ writable });
    if (url.pathname === "/api/v1/stream") {
      assert.ok(!url.search.includes("token")); assert.ok(req.headers["last-event-id"]);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
      res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return;
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()); writes.push({ path: url.pathname, body, key: req.headers["idempotency-key"] as string });
        const actionId = `action-${writes.length}`, kind = url.pathname.endsWith("/interrupt") ? "interrupt_turn" : url.pathname.endsWith("/turns") ? "submit_turn" : "create_session";
        actions.set(actionId, { actionId, kind, status: "accepted", sessionId: kind === "create_session" ? null : "s-active", turnId: turn });
        send(actions.get(actionId), 202);
        setTimeout(() => {
          busy = kind !== "interrupt_turn";
          if (kind === "create_session") turn = "created-turn";
          const id = kind === "create_session" ? "created" : "s-active";
          emit("session.updated", summary(id), id);
          actions.set(actionId, { actionId, kind, status: "succeeded", sessionId: id, turnId: turn });
          emit("action.updated", actions.get(actionId), id);
          if (kind === "interrupt_turn") emit("session.event.appended", { eventId: "interrupted", cursor: "e:999", type: "turn.interrupted", turnId: turn, sessionId: id, timestamp: 4000, payload: {} }, id);
        }, 80).unref();
      }); return;
    }
    if (url.pathname.endsWith("/snapshot")) return send({ sessions, workers: [worker], approvals: [], userInput: [], streamCursor: `c:${streamId}:0`, truncated: { sessions: true } });
    if (url.pathname.endsWith("/workers")) return send({ workers: [worker] });
    if (url.pathname === "/api/v1/sessions") {
      const start = url.searchParams.has("cursor") ? 50 : 0, q = url.searchParams.get("q");
      const filtered = q ? sessions.filter(s => s.title.includes(q)) : sessions;
      return send({ data: filtered.slice(start, start + 50), hasMore: start === 0 && filtered.length > 50, nextCursor: start === 0 ? "page-two" : null });
    }
    if (url.pathname.endsWith("/events")) {
      const end = url.searchParams.has("before") ? 30 : events.length;
      const start = Math.max(0, end - 100);
      return send({ data: events.slice(start, end), hasMore: start > 0, nextCursor: start > 0 ? "before-30" : null });
    }
    if (url.pathname.startsWith("/api/v1/sessions/")) { setTimeout(() => send(summary(url.pathname.split("/")[4])), slowDetailMs); return; }
    // Like the Control Plane: the client reconciles here when action.updated beats the POST response.
    if (url.pathname.startsWith("/api/v1/actions/")) return send(actions.get(url.pathname.split("/").at(-1)!) ?? { actionId: url.pathname.split("/").at(-1), status: "accepted", kind: "submit_turn", sessionId: "s-active" });
    return send({ data: [], hasMore: false, nextCursor: null });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { streams.forEach(r => r.end()); server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const chrome = spawn("/usr/bin/chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0",
    "--host-resolver-rules=MAP control-center.test 127.0.0.1", "--no-proxy-server",
    `--user-data-dir=${directory}/profile`, `--disk-cache-dir=${directory}/cache`, "--no-first-run", "--no-default-browser-check", "about:blank"], {
    env: { ...process.env, TMPDIR: directory, XDG_CONFIG_HOME: `${directory}/config`, XDG_CACHE_HOME: `${directory}/cache` }, stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { chrome.kill("SIGTERM"); });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not start: " + output.slice(-1000))), 15_000);
    chrome.stderr.on("data", chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on("error", reject);
  });
  const socket = new WebSocket(endpoint); await new Promise<void>(r => socket.once("open", r)); t.after(() => socket.close());
  let sequence = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(), exceptions: string[] = [];
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === "Runtime.exceptionThrown") exceptions.push(JSON.stringify(message.params));
    if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback?.reject(new Error(message.error.message)) : callback?.resolve(message.result); }
  });
  const cdp = (method: string, params: any = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const target = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const command = (method: string, params?: any) => cdp(method, params, sessionId);
  const js = async (expression: string) => {
    const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const wait = async (expression: string) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`UI condition timed out: ${expression}\n${await js("document.body.innerText")}\n${exceptions.join("\n")}`);
  };
  const fill = (selector: string, value: string, textarea = false) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${textarea ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const tap = async (selector: string) => {
    // Let the scroll event land before measuring: until it does, the transcript still
    // follows new content and may scroll the target away between measure and touch.
    const point = await js(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,disabled:el.disabled,hit:el.contains(document.elementFromPoint(x,y))};})()`);
    assert.equal(point.disabled, false, `${selector} must be enabled`);
    assert.equal(point.hit, true, `${selector} must not be covered`);
    await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const capture = async (name: string) => {
    const image = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(directory, name), Buffer.from(image.data, "base64"));
  };
  await command("Runtime.enable"); await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command("Emulation.setTouchEmulationEnabled", { enabled: true });
  await command("Page.navigate", { url: `http://control-center.test:${address.port}/control/login` });
  await wait("document.querySelectorAll('.session-row').length===50");
  assert.equal(await js("window.isSecureContext"), false);
  assert.equal(await js("typeof crypto.randomUUID"), "undefined", "must reproduce remote HTTP, unlike trustworthy localhost");
  assert.equal(await js("!!document.querySelector('#token')"), false, "entry must not ask for a token");
  console.log("390px HTTP entry: no login or browser token; touch hit targets checked");
  await wait("document.querySelectorAll('.session-row').length===50");
  await capture("sessions.png");
  await js("document.querySelector('.load-more').click()"); await wait("document.querySelectorAll('.session-row').length===53");
  await fill("#search", "移动端"); await js("document.querySelector('.filters').requestSubmit()"); await wait("document.querySelectorAll('.session-row').length===1");
  await js("document.querySelector('.session-row').click()"); await wait("document.body.innerText.includes('历史尾页最后一条') && document.body.innerText.includes('实时已连接')");
  const newest = { eventId: "live-msg", cursor: "e:130", sessionId: "s-active", type: "message.completed", turnId: turn, timestamp: 4000, payload: { role: "assistant", text: "SSE 实时消息已到达" } };
  events.push(newest); emit("session.event.appended", newest); await wait("document.body.innerText.includes('SSE 实时消息已到达')");
  await js("document.querySelector('.transcript .load-more').click()"); await wait("document.body.innerText.includes('历史消息 0')");
  // Switching back and forth (list and detail, background and foreground) keeps the page: no reload state, same place.
  // Sampled before every painted frame: what the user would actually see.
  const flashWatch = "window.__flash=false;window.__frames=0;requestAnimationFrame(function f(){window.__frames++;if(location.pathname.includes('/sessions/')&&(document.body.innerText.includes('正在读取会话')||!document.querySelector('.message')))window.__flash=true;if(window.__frames<120)requestAnimationFrame(f)});";
  await js("window.scrollTo(0,400)"); await wait("Math.round(scrollY)===400");
  await js("document.querySelector('.back').click()"); await wait("!!document.querySelector('a[href=\"/control/sessions/s-active\"]')");
  slowDetailMs = 1500;
  await js(`${flashWatch}document.querySelector('a[href="/control/sessions/s-active"]').click()`);
  await wait("document.body.innerText.includes('历史消息 0') && document.body.innerText.includes('正在同步')");
  await wait("!document.body.innerText.includes('正在同步')");
  assert.equal(await js("window.__flash"), false, "a revisited detail must render from cache, not from an empty loading page");
  assert.equal(await js("Math.round(scrollY)"), 400, "a revisited detail keeps its scroll position");
  await js("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__vis||'visible'});window.__vis='hidden';document.dispatchEvent(new Event('visibilitychange'))");
  await wait("document.body.innerText.includes('后台已暂停')");
  await js(`window.__vis='visible';${flashWatch}document.dispatchEvent(new Event('visibilitychange'))`);
  await wait("document.body.innerText.includes('实时已连接')");
  assert.equal(await js("window.__flash"), false, "returning to the foreground must not reload the page");
  assert.equal(await js("Math.round(scrollY)"), 400);
  slowDetailMs = 0;
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true, "390px layout must not overflow horizontally");
  await fill("#message", " \n ", true);
  assert.equal(await js("document.querySelector('.composer button.primary').disabled"), true, "whitespace draft must stay disabled");
  await fill("#message", "补充一个要求", true); await tap(".composer button.primary");
  await wait("document.body.innerText.includes('操作已被接受')"); assert.equal(writes[0].body.expectedTurnId, "turn-one"); assert.equal(writes[0].body.delivery, "steer");
  await wait("!document.querySelector('.interrupt').disabled");
  await tap(".interrupt"); await wait("document.body.innerText.includes('本轮已打断')");
  assert.equal(writes[1].body.expectedTurnId, "turn-one");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
  await fill("#message", "继续已空闲的会话", true);
  await wait("document.querySelector('.composer button.primary').textContent.includes('发送') && !document.querySelector('.composer button.primary').disabled");
  await tap(".composer button.primary"); await wait("!document.querySelector('#message').value");
  assert.equal(writes[2].body.delivery, "start_turn"); assert.equal(writes[2].body.expectedTurnId, undefined);
  await js("document.querySelector('.back').click()"); await wait("!!document.querySelector('a[href=\"/control/new\"]')");
  await js("document.querySelector('a[href=\"/control/new\"]').click()"); await wait("!!document.querySelector('#new-worker')");
  assert.equal(await js("document.querySelector('.new-form button.primary').disabled"), true, "new session needs worker and workspace");
  await js("(()=>{const e=document.querySelector('#new-worker');e.value='claude@test';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await fill("#workspace", "/work/repo"); await fill("#first-message", "创建验收", true);
  await tap(".new-form button.primary"); await wait("location.pathname.endsWith('/created') && !!document.querySelector('.composer')");
  assert.equal(writes[3].body.workerId, worker.id); assert.equal(writes[3].body.workspace, "/work/repo");
  await fill("#message", "新会话的追加指令", true);
  await wait("!document.querySelector('.composer button.primary').disabled");
  await tap(".composer button.primary"); await wait("!document.querySelector('#message').value");
  assert.equal(writes[4].path, "/api/v1/sessions/created/turns");
  assert.equal(writes[4].body.delivery, "steer"); assert.equal(writes[4].body.expectedTurnId, "created-turn");
  assert.ok(writes.every(w => w.key));
  assert.ok(writes.every(w => /^[\x21-\x7e]{1,128}$/.test(w.key!)), "keys must satisfy the API contract, even on HTTP");
  assert.equal(new Set(writes.map(w => w.key)).size, writes.length, "separate actions need distinct idempotency keys");
  await fill("#message", "等待待办后发送", true);
  emit("session.updated", { ...summary("created"), status: "waiting_for_approval", pendingApprovalCount: 1 }, "created");
  await wait("document.querySelector('.composer button.primary').disabled && document.body.innerText.includes('等待处理待办')");
  emit("session.updated", { ...summary("created"), status: "waiting_for_input", pendingUserInputCount: 1 }, "created");
  await wait("document.body.innerText.includes('等待回答') && document.querySelector('.composer button.primary').disabled");
  assert.equal(writes.length, 5, "pending interactions must not submit messages");
  assert.equal(await js("localStorage.length+sessionStorage.length"), 0); assert.equal(await js("document.cookie"), "");
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true);
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(directory, "mobile.png"), Buffer.from(screenshot.data, "base64"));
  writable = false; slowDetailMs = 3000;
  await command("Page.reload");
  // Recent conversations come back from IndexedDB before the slow detail GET answers.
  await wait("!!document.querySelector('.message') && document.body.innerText.includes('正在同步')");
  slowDetailMs = 0;
  await wait("!!document.querySelector('#message') && document.body.innerText.includes('只读模式')");
  assert.equal(await js("!!document.querySelector('#token')"), false, "reload connects without login");
  await fill("#message", "只读不能发送", true);
  assert.equal(await js("document.querySelector('.composer button.primary').disabled"), true);
  assert.equal(await js("document.querySelector('.interrupt').disabled"), true);
  assert.equal(writes.length, 5, "read-only server configuration must not submit writes");
  assert.deepEqual(exceptions, []);
  console.log(`Mobile screenshot: ${directory}/mobile.png`);
});
