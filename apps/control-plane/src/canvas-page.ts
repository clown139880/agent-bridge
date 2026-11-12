// Static assets stay alongside the route so tsc is the only build step this page needs.
export const CANVAS_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>实时画布</title><link rel="stylesheet" href="/canvas/assets/page.css"><script src="/canvas/assets/page.js" defer></script></head>
<body><main><div id="stage"><img id="back" alt=""><img id="front" alt=""></div>
<div id="empty" role="status">等待第一张图片</div>
<header><a href="/control/" aria-label="返回控制中心">CANVAS</a><span id="connection" role="status">连接中</span></header>
<footer><div id="details"><h1 id="title">实时画布</h1><p id="progress"></p><p id="caption"></p></div>
<nav aria-label="画布导航"><button id="previous" aria-label="上一张">←</button><span id="count">0 / 0</span><button id="next" aria-label="下一张">→</button>
<button id="play" aria-pressed="false">播放</button><button id="follow" aria-pressed="true">跟随新图</button><button id="reconnect">重新连接</button><button id="fullscreen">全屏</button></nav></footer>
</main></body></html>`;

export const CANVAS_CSS = `:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;color:#f0f0f0;background:#101114}
*{box-sizing:border-box}body{margin:0}main{height:100dvh;min-height:320px;position:relative;overflow:hidden}
#stage{position:absolute;inset:0}#stage img{position:absolute;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .4s ease}#stage img.visible{opacity:1}
header,footer{position:absolute;left:0;right:0;padding:24px 30px}header{top:0;display:flex;justify-content:space-between;background:linear-gradient(#0009,transparent);pointer-events:none}
header a{color:#fff;text-decoration:none;font-size:12px;letter-spacing:.2em;pointer-events:auto}#connection{font-size:12px;color:#aeb6c2}
footer{bottom:0;background:linear-gradient(transparent,#000e);padding-top:55px}h1{font-size:21px;margin:0 0 4px;font-weight:550}
p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}#caption{max-height:18vh;overflow:auto;color:#ddd}#progress{color:#b7c1d0;font-size:13px;max-height:12vh;overflow:auto}
nav{display:flex;align-items:center;gap:8px;margin-top:18px;flex-wrap:wrap}button{font:inherit;font-size:13px;background:#ffffff12;border:1px solid #ffffff30;border-radius:6px;color:inherit;padding:7px 12px;cursor:pointer}
button:hover,button[aria-pressed=true]{background:#ffffff2b}button:disabled{opacity:.35;cursor:default}button:focus-visible{outline:2px solid #91b9ff;outline-offset:3px}#count{font-variant-numeric:tabular-nums;min-width:64px;text-align:center;font-size:13px}
#empty{position:absolute;top:45%;left:0;right:0;text-align:center;color:#9ca5b5;padding:20px;pointer-events:none}[hidden]{display:none!important}
@media(max-width:600px){header,footer{padding:16px}footer{padding-top:45px}h1{font-size:18px}nav{gap:6px}button{padding:8px}#count{min-width:48px}}
@media(prefers-reduced-motion:reduce){#stage img{transition:none}}`;

export const CANVAS_JS = String.raw`"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const base = location.pathname.replace(/\/$/, ""), images = new Map();
  let seq = 0, meta = {}, selected = null, following = true, playing = false, gone = false;
  let controller, retryTimer, playTimer, displayed = "", generation = 0;
  let front = $("front"), back = $("back");
  const rows = () => [...images.values()].sort((a,b) => a.order - b.order);
  const status = text => { $("connection").textContent = text; };
  function show() {
    const list = rows();
    if (!selected && list.length) selected = list[list.length - 1].id;
    const index = list.findIndex(i => i.id === selected), item = list[index];
    $("count").textContent = (item ? index + 1 : 0) + " / " + list.length;
    $("previous").disabled = list.length < 2; $("next").disabled = list.length < 2;
    $("caption").textContent = item?.description || "";
    $("title").textContent = meta.title || "实时画布";
    document.title = meta.title || "实时画布";
    $("progress").textContent = ({working:"进行中",complete:"已完成",failed:"失败"}[meta.status] || "") + (meta.description ? " · " + meta.description : "");
    if (!item) { $("empty").hidden = false; return; }
    if (displayed === item.url) return;
    displayed = item.url;
    const revision = ++generation, next = back;
    next.classList.remove("visible");
    next.onload = () => {
      if (revision !== generation) return;
      $("empty").hidden = true; next.classList.add("visible"); front.classList.remove("visible");
      const previous = front; front = next; back = previous;
    };
    next.onerror = () => {
      if (revision !== generation) return;
      front.classList.remove("visible"); $("empty").textContent = "图片暂时无法加载，等待来源更新"; $("empty").hidden = false;
    };
    next.alt = item.description || "画布图片";
    next.referrerPolicy = "no-referrer";
    if (location.protocol === "https:" && !item.url.startsWith("https:")) { next.onerror(); return; }
    next.src = item.url;
  }
  function follow(value) { following = value; $("follow").setAttribute("aria-pressed", String(value)); }
  function step(direction) {
    const list = rows(); if (!list.length) return;
    follow(false); const index = list.findIndex(i => i.id === selected);
    selected = list[(index + direction + list.length) % list.length].id; show();
  }
  function playback() {
    clearInterval(playTimer);
    if (playing && !document.hidden) playTimer = setInterval(() => step(1), 5000);
    $("play").textContent = playing ? "暂停" : "播放"; $("play").setAttribute("aria-pressed", String(playing));
  }
  function apply(delta) {
    if (delta.seq < seq) return;
    if (delta.meta) meta = delta.meta;
    for (const item of delta.images) {
      if (!images.has(item.id) || images.get(item.id).updated_seq < item.updated_seq) images.set(item.id, item);
    }
    if (following && images.size) selected = rows().at(-1).id;
    show(); seq = delta.seq;
    if (meta.closed) { status("画布已关闭"); controller?.abort(); }
  }
  async function connect() {
    if (controller || document.hidden || gone || meta.closed) return;
    clearTimeout(retryTimer);
    const active = controller = new AbortController();
    status("连接中");
    try {
      const response = await fetch(base + "/events?cursor=" + seq, {headers:{"x-control-center":"1"}, signal:active.signal, cache:"no-store"});
      if (!response.ok) {
        if (response.status === 404) { gone = true; status("画布已失效"); return; }
        if (response.status === 409) { seq = 0; images.clear(); selected = null; displayed = ""; }
        if (response.status === 403 || response.status === 503) { status("当前入口无法访问画布"); }
        throw new Error("connect");
      }
      status("实时连接");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const {done,value} = await reader.read(); if (done) break;
        buffer += decoder.decode(value,{stream:true});
        if (buffer.length > 16 * 1024 * 1024) throw new Error("oversized stream");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary + 2);
          const line = frame.split("\n").find(line => line.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            if (data.error === "canvas_gone" || data.error === "canvas_corrupt") { gone = true; status("画布已失效"); }
            throw new Error(data.error);
          }
          apply(data);
        }
      }
    } catch (_) { /* Resume with the last successfully applied cursor. */ }
    finally {
      active.abort(); if (controller === active) controller = undefined;
      if (!document.hidden && !gone && !meta.closed) { status("连接中断，正在重连"); retryTimer = setTimeout(connect, 3000); }
    }
  }
  $("previous").onclick = () => step(-1); $("next").onclick = () => step(1);
  $("follow").onclick = () => { follow(!following); if (following) { selected = rows().at(-1)?.id; show(); } };
  $("play").onclick = () => { playing = !playing; playback(); };
  $("reconnect").onclick = () => location.reload();
  $("fullscreen").onclick = () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    action?.catch(() => {});
  };
  document.addEventListener("keydown", event => {
    if (event.target instanceof HTMLButtonElement || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    if (event.code === "Space") { event.preventDefault(); playing = !playing; playback(); }
  });
  document.addEventListener("visibilitychange", () => {
    playback();
    if (document.hidden) { clearTimeout(retryTimer); controller?.abort(); } else connect();
  });
  window.addEventListener("pagehide", () => { clearTimeout(retryTimer); clearInterval(playTimer); controller?.abort(); });
  connect();
})();`;
