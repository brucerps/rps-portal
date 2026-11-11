// RPS Portal service worker: always loads the latest portal online; shows a simple offline note when there's no connection.
const OFFLINE = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><body style='background:#05060A;color:#F2F1EC;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center'><div><h2>You're offline</h2><p>Connect to the internet and reopen the RPS Portal.</p></div>";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "content-type": "text/html" } })));
});
