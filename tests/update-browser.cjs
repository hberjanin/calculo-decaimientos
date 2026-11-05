const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');

// Dos publicaciones reales, servidas solo en localhost y en perfiles temporales.
module.exports = async function (browser, output) {
  const root = path.resolve(__dirname, '..');
  const manifestContext = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'precache-manifest.js'), 'utf8'), manifestContext);
  const releases = {};
  for (const version of ['51', '52']) {
    const files = new Map();
    const resources = [];
    const transform = buffer => Buffer.from(buffer.toString('utf8').replace(/\?v=51/g, `?v=${version}`).replace(/(APP_VERSION = |const VERSION = )'51'/g, `$1'${version}'`));
    for (const entry of manifestContext.self.DECAIMIENTO_RELEASE.resources) {
      const filename = entry.url.replace(/^\.\//, '').split('?')[0];
      let bytes = fs.readFileSync(path.join(root, filename));
      if (/\.(?:js|css|html|webmanifest)$/.test(filename)) bytes = transform(bytes);
      files.set(`/${filename}`, bytes);
      resources.push({ url: entry.url.replace('?v=51', `?v=${version}`), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    files.set('/sw.js', transform(fs.readFileSync(path.join(root, 'sw.js'))));
    files.set('/precache-manifest.js', Buffer.from(`self.DECAIMIENTO_RELEASE = ${JSON.stringify({ version, resources })};`));
    files.set('/', files.get('/index.html'));
    releases[version] = files;
  }
  let version = '51';
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.ttf': 'font/ttf', '.csv': 'text/csv', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://localhost').pathname;
    const bytes = releases[version].get(filename);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'text/html', 'Cache-Control': 'no-store' });
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const context = await browser.newContext({ locale: 'es-ES' });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => { page.__updateError = error.message; });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('#offlineStatus').filter({ hasText: 'Lista para usar' }).waitFor();
    assert.equal(await page.locator('#updateBanner').isVisible(), false, 'Una instalación inicial no debe anunciar una actualización');
    const second = await context.newPage();
    await second.goto(url, { waitUntil: 'networkidle' });
    await second.locator('#inventoryButton').click();
    await second.locator('#inventoryId').fill('BORRADOR CONSERVADO');
    const before = await page.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1'));
    version = '52';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
    await page.locator('#updateBanner').waitFor({ state: 'visible' });
    await page.locator('#inventoryButton').click();
    await page.evaluate(() => document.querySelector('#updateButton').click());
    await page.locator('#toast').filter({ hasText: 'Guarda o cierra' }).waitFor();
    assert.ok(await page.locator('#inventoryDialog').isVisible());
    await page.locator('#cancelInventory').click();
    await page.locator('#inventoryDialog').waitFor({ state: 'hidden' });
    await page.locator('#updateButton').click();
    await page.waitForFunction(() => document.querySelector('script[type="module"]')?.getAttribute('src') === 'app.js?v=52', null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('#countAll')?.textContent === '17');
    assert.equal(await page.locator('script[type="module"]').getAttribute('src'), 'app.js?v=52');
    assert.equal(await page.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1')), before);
    assert.equal(await second.locator('#inventoryId').inputValue(), 'BORRADOR CONSERVADO');
    const names = await page.evaluate(() => caches.keys());
    assert.ok(names.includes('calculo-decaimientos-v51') && names.includes('calculo-decaimientos-v52'));
    await context.setOffline(true);
    const oldCss = await second.evaluate(async () => (await fetch('./styles.css?v=51')).text());
    assert.ok(oldCss.includes('?v=51'));
    await second.locator('#cancelInventory').click();
    await second.locator('#reportButton').click();
    await second.locator('#downloadReport').click();
    await second.locator('#reportStatus').filter({ hasText: /otra versión|recarga/i }).waitFor();
    assert.equal(await second.locator('#reportDialog').isVisible(), true, 'La pestaña antigua debe explicar cómo actualizarse');
  } catch (error) {
    const state = await context.pages()[0]?.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { url: location.href, script: document.querySelector('script[type="module"]')?.src, dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id), toast: document.querySelector('#toast')?.textContent, waiting: registration?.waiting?.state, active: registration?.active?.state, cacheNames: await caches.keys() };
    }).catch(() => null);
    error.updateState = state;
    error.pageError = context.pages()[0]?.__updateError;
    error.workerState = await Promise.all(context.serviceWorkers().map(worker => worker.evaluate(() => ({ version: VERSION, scope: self.registration.scope, waiting: self.registration.waiting?.state, active: self.registration.active?.state })).catch(error => error.message)));
    throw error;
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
