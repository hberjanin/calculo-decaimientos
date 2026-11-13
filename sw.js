const VERSION = '53';
importScripts(`./precache-manifest.js?v=${VERSION}`);
const RELEASE = self.DECAIMIENTO_RELEASE;
if (RELEASE?.version !== VERSION) throw new Error('El inventario de recursos pertenece a otra publicación.');
const CACHE_PREFIX = 'calculo-decaimientos-';
const CACHE_NAME = `${CACHE_PREFIX}v${VERSION}`;
const META_URL = new URL('./__offline_release__', self.registration.scope).href;
const required = RELEASE.resources.map(entry => ({ ...entry, url: new URL(entry.url, self.registration.scope).href }));
const byUrl = new Map(required.map(entry => [entry.url, entry]));
let repairing;

async function complete(cache, entries = required) {
  const responses = await Promise.all(entries.map(entry => cache.match(entry.url)));
  if (!responses.every(response => response?.ok)) return false;
  return (await Promise.all(responses.map((response, index) => matchesHash(response, entries[index])))).every(Boolean);
}

async function matchesHash(response, entry) {
  if (!entry.sha256) return false;
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') === entry.sha256;
}

async function verifiedResponse(entry) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(entry.url, { cache: 'reload', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (!response.ok || response.type !== 'basic') throw new Error('Recurso local no disponible');
    if (!await matchesHash(response, entry)) throw new Error('La versión del recurso no coincide con la publicación');
    return response;
  } finally { clearTimeout(timer); }
}

async function installShell() {
  // Validar toda la publicación impide instalar una mezcla de versiones.
  const responses = await Promise.all(required.map(verifiedResponse));
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(META_URL);
  for (let index = 0; index < required.length; index += 1) await cache.put(required[index].url, responses[index]);
  await cache.put(META_URL, new Response(JSON.stringify({ version: VERSION, resources: required }), { headers: { 'Content-Type': 'application/json' } }));
  return cache;
}

function repairShell() {
  if (!repairing) repairing = installShell().finally(() => { repairing = null; });
  return repairing;
}

async function notifyStatus(client, isComplete) {
  const message = { type: 'SHELL_STATUS', complete: isComplete, version: VERSION };
  if (client?.postMessage) client.postMessage(message);
  else (await self.clients.matchAll()).forEach(item => item.postMessage(message));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try { await repairShell(); }
    catch (error) { await caches.delete(CACHE_NAME); throw error; }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Las pestañas abiertas pueden seguir ejecutando una publicación anterior.
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    if (!clients.length) {
      const names = (await caches.keys()).filter(name => /^calculo-decaimientos-v\d+$/.test(name));
      const previous = names.filter(name => name !== CACHE_NAME).sort((a, b) => Number(b.split('-v')[1]) - Number(a.split('-v')[1]))[0];
      await Promise.all(names.filter(name => name !== CACHE_NAME && name !== previous).map(name => caches.delete(name)));
    }
    try { await self.registration.navigationPreload?.disable(); } catch { /* Optimización opcional. */ }
    await self.clients.claim();
    await notifyStatus(null, await complete(await caches.open(CACHE_NAME)));
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') { event.waitUntil(self.skipWaiting()); return; }
  if (event.data?.type === 'GET_RUNTIME_STATUS') {
    event.waitUntil((async () => {
      const ready = await complete(await caches.open(CACHE_NAME));
      event.ports[0]?.postMessage({ type: 'RUNTIME_STATUS', version: VERSION, complete: ready });
    })());
    return;
  }
  if (!['CHECK_SHELL', 'REPAIR_SHELL'].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    let ready = await complete(cache);
    // Una caché íntegra ya está reparada, también si el usuario está offline.
    if (!ready) {
      try { await repairShell(); ready = true; } catch { ready = false; }
    }
    await notifyStatus(event.source, ready);
  })());
});

function unavailable(navigation = false) {
  const message = 'Faltan recursos para usar la aplicación sin conexión. Los datos guardados se conservan. Reconecta con el servidor y vuelve a cargar la aplicación.';
  return new Response(navigation
    ? `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recuperar modo offline</title><main><h1>Recuperar modo offline</h1><p>${message}</p><a href="./">Volver a cargar</a></main></html>`
    : message, { status: 503, headers: { 'Content-Type': navigation ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function navigationResponse() {
  let cache = await caches.open(CACHE_NAME);
  if (!await complete(cache)) {
    try { cache = await repairShell(); }
    catch {
      await notifyStatus(null, false);
      // Solo se recupera una publicación completa; nunca se mezclan shells.
      const names = (await caches.keys()).filter(name => /^calculo-decaimientos-v\d+$/.test(name) && name !== CACHE_NAME)
        .sort((a, b) => Number(b.split('-v')[1]) - Number(a.split('-v')[1]));
      for (const name of names) {
        const previous = await caches.open(name);
        const metadata = await previous.match(META_URL);
        if (!metadata) continue;
        try {
          const release = await metadata.json();
          if (Array.isArray(release.resources) && await complete(previous, release.resources)) {
            const index = await previous.match(new URL('./index.html', self.registration.scope));
            if (index) return index;
          }
        } catch { /* Una caché incompleta no sirve como recuperación. */ }
      }
      return unavailable(true);
    }
  }
  return (await cache.match(new URL('./index.html', self.registration.scope))) || unavailable(true);
}

async function staticResponse(request) {
  const url = new URL(request.url);
  const requestedVersion = url.searchParams.get('v');
  const cacheName = requestedVersion && /^\d+$/.test(requestedVersion) ? `${CACHE_PREFIX}v${requestedVersion}` : CACHE_NAME;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached && (requestedVersion !== VERSION || !byUrl.has(request.url) || await matchesHash(cached, byUrl.get(request.url)))) return cached;
  if (requestedVersion && requestedVersion !== VERSION) { await notifyStatus(null, false); return unavailable(); }
  const entry = byUrl.get(request.url);
  if (!entry) return fetch(request);
  try {
    const response = await verifiedResponse(entry);
    // Poder leer no depende de que quede cuota para reparar la caché.
    try { await cache.put(request, response.clone()); } catch { await notifyStatus(null, false); }
    return response;
  } catch { await notifyStatus(null, false); return unavailable(); }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.headers.has('range') || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith(request.mode === 'navigate' ? navigationResponse() : staticResponse(request));
});
