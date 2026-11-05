import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://test.invalid/app/';
const hash = text => createHash('sha256').update(text).digest('hex');
const release = { version: '51', resources: [{ url: './index.html', sha256: hash('html51') }, { url: './app.js?v=51', sha256: hash('js51') }] };
function harness({ failFetch = false, badHash = false, quota = false, clients = 1 } = {}) {
  const stores = new Map();
  const handlers = new Map();
  const messages = [];
  let skipped = false;
  let online = !failFetch;
  let corrupt = badHash;
  const absolute = key => new URL(typeof key === 'string' || key instanceof URL ? key : key.url, scope).href;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        match: async key => store.get(absolute(key))?.clone(),
        put: async (key, response) => { if (quota) throw new Error('QuotaExceededError'); store.set(absolute(key), response.clone()); },
        delete: async key => store.delete(absolute(key))
      };
    }
  };
  const clientList = Array.from({ length: clients }, () => ({ postMessage: value => messages.push(value) }));
  const context = vm.createContext({
    URL, Response, Map, Promise, Uint8Array, crypto: webcrypto, caches,
    fetch: async url => {
      if (!online) throw new Error('offline');
      const text = corrupt ? 'otra-publicación' : String(url).includes('app.js') ? 'js51' : 'html51';
      const response = new Response(text);
      Object.defineProperty(response, 'type', { value: 'basic' });
      return response;
    },
    importScripts() {},
    self: { DECAIMIENTO_RELEASE: release, location: { origin: 'https://test.invalid' }, registration: { scope },
      clients: { matchAll: async () => clientList, claim: async () => {} }, skipWaiting: async () => { skipped = true; },
      addEventListener: (name, handler) => handlers.set(name, handler) }
  });
  vm.runInContext(source, context);
  async function event(name, data = {}) {
    let promise;
    handlers.get(name)({ ...data, waitUntil: value => { promise = value; }, respondWith: value => { promise = value; } });
    return await promise;
  }
  const navigate = () => event('fetch', { request: { url: scope, mode: 'navigate', method: 'GET', headers: new Headers() } });
  return { caches, stores, messages, event, navigate, setOnline: value => { online = value; }, setCorrupt: value => { corrupt = value; }, get skipped() { return skipped; } };
}

test('instalación incompleta o con mezcla de versiones no deja una caché utilizable', async () => {
  for (const options of [{ failFetch: true }, { badHash: true }, { quota: true }]) {
    const worker = harness(options);
    await assert.rejects(worker.event('install'));
    assert.deepEqual(await worker.caches.keys(), []);
  }
});

test('instalación completa funciona offline y no activa una actualización sin aceptación', async () => {
  const worker = harness();
  await worker.event('install');
  assert.equal(worker.skipped, false);
  worker.setOnline(false);
  assert.equal(await (await worker.navigate()).text(), 'html51');
  await worker.event('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(worker.skipped, true);
});

test('una caché dañada ofrece recuperación y se repara al volver la conexión', async () => {
  const worker = harness();
  await worker.event('install');
  const cache = await worker.caches.open('calculo-decaimientos-v51');
  await cache.put(`${scope}app.js?v=51`, new Response('contenido corrupto'));
  worker.setOnline(false);
  assert.equal((await worker.navigate()).status, 503);
  worker.setOnline(true);
  assert.equal(await (await worker.navigate()).text(), 'html51');
});

test('activar conserva versiones usadas por pestañas y cachés ajenas', async () => {
  const worker = harness();
  await worker.event('install');
  await worker.caches.open('calculo-decaimientos-v49');
  await worker.caches.open('otra-aplicación');
  await worker.event('activate');
  assert.ok((await worker.caches.keys()).includes('calculo-decaimientos-v49'));
  assert.ok((await worker.caches.keys()).includes('otra-aplicación'));
});

test('una pestaña antigua recibe sus recursos y no el código nuevo del servidor', async () => {
  const worker = harness();
  await worker.event('install');
  const cache = await worker.caches.open('calculo-decaimientos-v49');
  await cache.put(`${scope}app.js?v=49`, new Response('js49'));
  const request = url => ({ request: { url: `${scope}${url}`, mode: 'cors', method: 'GET', headers: new Headers() } });
  assert.equal(await (await worker.event('fetch', request('app.js?v=49'))).text(), 'js49');
  assert.equal((await worker.event('fetch', request('src/ausente.js?v=49'))).status, 503);
});

test('recuperación utiliza una publicación anterior únicamente cuando está completa', async () => {
  const worker = harness();
  await worker.event('install');
  const cache = await worker.caches.open('calculo-decaimientos-v49');
  const resources = [{ url: `${scope}index.html`, sha256: hash('html49') }, { url: `${scope}app.js?v=49`, sha256: hash('js49') }];
  await cache.put(`${scope}index.html`, new Response('html49'));
  await cache.put(`${scope}app.js?v=49`, new Response('js49'));
  await cache.put(`${scope}__offline_release__`, new Response(JSON.stringify({ resources })));
  await (await worker.caches.open('calculo-decaimientos-v51')).delete(`${scope}app.js?v=51`);
  worker.setOnline(false);
  assert.equal(await (await worker.navigate()).text(), 'html49');
  await cache.delete(`${scope}app.js?v=49`);
  assert.equal((await worker.navigate()).status, 503);
});

test('informa a la pestaña de la versión activa y de la integridad del shell', async () => {
  const worker = harness();
  await worker.event('install');
  let reply;
  await worker.event('message', {
    data: { type: 'GET_RUNTIME_STATUS', appVersion: '51' },
    ports: [{ postMessage: value => { reply = value; } }]
  });
  assert.equal(reply.type, 'RUNTIME_STATUS');
  assert.equal(reply.version, '51');
  assert.equal(reply.complete, true);
});
