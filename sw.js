'use strict';
/*
 * Service worker do app. Serve a página e os ícones do cache na hora e atualiza em segundo plano,
 * então o app abre instantaneamente mesmo quando o servidor do Render (plano grátis) está dormindo.
 * Os dados (/api/) nunca passam pelo cache aqui: a própria página guarda o último resultado e o mostra enquanto atualiza.
 * Uma versão nova do app aparece na segunda abertura depois do deploy.
 */
const CACHE = 'compass-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/') || u.pathname === '/healthz') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(r, { ignoreSearch: true });
    const net = fetch(r)
      .then((resp) => { if (resp && resp.ok) cache.put(r, resp.clone()); return resp; })
      .catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const resp = await net;
    return resp || (r.mode === 'navigate' ? await cache.match('/') : null) || new Response('Sem conexão', { status: 503 });
  })());
});
