/* Weave service worker: lets the app open with no network.
 *
 * - On install, precaches the app shell and every built asset listed in /precache.json
 *   (written by the build), so lazily loaded chunks such as the editor work offline too.
 * - Navigations are network-first, falling back to the cached index.html.
 * - Static assets are cache-first (their names are content-hashed).
 * - /api is never cached here; the app keeps its own offline copies in IndexedDB.
 */
const VERSION = "weave-v1";
const SHELL = ["/", "/index.html", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(SHELL);
      try {
        const res = await fetch("/precache.json", { cache: "no-store" });
        if (res.ok) {
          const files = await res.json();
          await cache.addAll(files.map((f) => "/" + f));
        }
      } catch {
        /* dev server or missing manifest: runtime caching still applies */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(VERSION);
          cache.put("/index.html", res.clone());
          return res;
        } catch {
          return (await caches.match("/index.html")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
      return res;
    })(),
  );
});
