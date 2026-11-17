const CACHE = 'citytrace-shell-v3';
const SHELL = ['/', '/static/app.css', '/static/app.js', '/static/v2.js', '/static/manifest.json', '/static/icon.svg'];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('citytrace-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only the public shell is cached; API aliases and photos always require server authorization.
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || !SHELL_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(url.pathname, response.clone());
      return response;
    } catch {
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      return new Response('资源暂不可用，请联网后重试。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
