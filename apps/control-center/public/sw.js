// Makes the Control Center installable. It deliberately caches nothing: every
// request still goes to the network, so an installed app never runs a stale
// build and Cloudflare Access keeps seeing each request.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
