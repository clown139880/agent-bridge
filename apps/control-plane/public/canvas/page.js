"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const base = location.pathname.replace(/\/$/, ""), images = new Map();
  let seq = 0, meta = {}, selected = null, following = true, playing = false, gone = false;
  let controller, retryTimer, playTimer, displayed = "", generation = 0, resumeVideo = false;
  let front = $("front"), back = $("back");
  const video = $("video");
  const rows = () => [...images.values()].sort((a,b) => a.order - b.order);
  const status = text => { $("connection").textContent = text; };
  const mediaType = item => item.media_type || (/\.(mp4|webm|ogv|mov|m4v)$/i.test(new URL(item.url).pathname) ? "video" : "image");
  function releaseVideo() {
    video.onloadeddata = video.onerror = video.onended = null;
    video.pause(); video.hidden = true; resumeVideo = false;
    if (video.hasAttribute("src")) { video.removeAttribute("src"); video.load(); }
  }
  function playVideo() {
    if (!video.hidden && !document.hidden) video.play().catch(() => {});
  }
  function show() {
    const list = rows();
    if (!selected && list.length) selected = list[list.length - 1].id;
    const index = list.findIndex(i => i.id === selected), item = list[index];
    $("count").textContent = (item ? index + 1 : 0) + " / " + list.length;
    $("previous").disabled = list.length < 2; $("next").disabled = list.length < 2;
    $("caption").textContent = item?.description || "";
    $("title").textContent = meta.title || "实时画布";
    document.title = meta.title || "实时画布";
    if (!item) { $("empty").hidden = false; return; }
    const type = mediaType(item), key = item.id + ":" + type + ":" + item.url;
    if (displayed === key) return;
    displayed = key;
    const revision = ++generation;
    releaseVideo(); playback(); document.querySelector("main").classList.toggle("video", type === "video");
    if (type === "video") {
      for (const img of [front, back]) { img.onload = img.onerror = null; img.classList.remove("visible"); img.removeAttribute("src"); }
      $("empty").textContent = "正在加载视频"; $("empty").hidden = false;
      video.hidden = false; resumeVideo = document.hidden;
      video.onloadeddata = () => { if (revision === generation) { $("empty").hidden = true; playVideo(); } };
      video.onerror = () => { if (revision === generation) { $("empty").textContent = "视频暂时无法播放，请检查来源或浏览器格式支持"; $("empty").hidden = false; } };
      video.onended = () => { if (revision === generation && playing && !document.hidden) step(1); };
      if (location.protocol === "https:" && !item.url.startsWith("https:")) { video.onerror(); return; }
      video.src = item.url; video.load(); playVideo();
      return;
    }
    const next = back;
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
    if (playing && !document.hidden) playTimer = setInterval(() => { if (video.hidden) step(1); }, 5000);
    $("play").textContent = playing ? "暂停切换" : "自动切换"; $("play").setAttribute("aria-pressed", String(playing));
  }
  function apply(delta) {
    if (delta.seq < seq) return;
    if (delta.meta) meta = delta.meta;
    for (const item of delta.images) {
      if (!images.has(item.id) || images.get(item.id).updated_seq < item.updated_seq) images.set(item.id, item);
    }
    if (following && images.size) selected = rows().at(-1).id;
    show(); seq = delta.seq;
  }
  async function connect() {
    if (controller || document.hidden || gone) return;
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
      if (!document.hidden && !gone) { status("连接中断，正在重连"); retryTimer = setTimeout(connect, 3000); }
    }
  }
  $("previous").onclick = () => step(-1); $("next").onclick = () => step(1);
  $("follow").onclick = () => { follow(!following); if (following) { selected = rows().at(-1)?.id; show(); } };
  function togglePlayback() { playing = !playing; follow(false); playback(); if (playing) playVideo(); }
  $("play").onclick = togglePlayback;
  $("fullscreen").onclick = () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    action?.catch(() => {});
  };
  document.addEventListener("keydown", event => {
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLVideoElement || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
  });
  document.addEventListener("visibilitychange", () => {
    playback();
    if (document.hidden) { resumeVideo = !video.hidden && !video.paused; video.pause(); clearTimeout(retryTimer); controller?.abort(); }
    else { if (resumeVideo) playVideo(); resumeVideo = false; connect(); }
  });
  window.addEventListener("pagehide", () => { releaseVideo(); clearTimeout(retryTimer); clearInterval(playTimer); controller?.abort(); });
  window.addEventListener("pageshow", event => { if (event.persisted) { displayed = ""; show(); playback(); connect(); } });
  connect();
})();
