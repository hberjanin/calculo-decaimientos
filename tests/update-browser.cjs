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
  const currentVersion = manifestContext.self.DECAIMIENTO_RELEASE.version;
  const nextVersion = String(Number(currentVersion) + 1);
  const releases = {};
  for (const version of [currentVersion, nextVersion]) {
    const files = new Map();
    const resources = [];
    const transform = buffer => Buffer.from(buffer.toString('utf8').replace(/\?v=\d+/g, `?v=${version}`).replace(/(APP_VERSION = |const VERSION = )'\d+'/g, `$1'${version}'`));
    for (const entry of manifestContext.self.DECAIMIENTO_RELEASE.resources) {
      const filename = entry.url.replace(/^\.\//, '').split('?')[0];
      let bytes = fs.readFileSync(path.join(root, filename));
      if (/\.(?:js|css|html|webmanifest)$/.test(filename)) bytes = transform(bytes);
      files.set(`/${filename}`, bytes);
      resources.push({ url: entry.url.replace(/\?v=\d+/, `?v=${version}`), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    files.set('/sw.js', transform(fs.readFileSync(path.join(root, 'sw.js'))));
    files.set('/precache-manifest.js', Buffer.from(`self.DECAIMIENTO_RELEASE = ${JSON.stringify({ version, resources })};`));
    files.set('/', files.get('/index.html'));
    releases[version] = files;
  }
  let version = currentVersion;
  let brokenDownload = false;
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.ttf': 'font/ttf', '.csv': 'text/csv', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://localhost').pathname;
    const bytes = releases[version].get(filename);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'text/html', 'Cache-Control': 'no-store' });
    response.end(brokenDownload && filename === '/app.js' ? 'descarga incompleta' : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let context = await browser.newContext({ locale: 'es-ES' });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => { page.__updateError = error.message; });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('#offlineStatus').filter({ hasText: 'Lista para usar' }).waitFor();
    await page.locator('#updateStatus').filter({ hasText: 'última versión publicada' }).waitFor();
    assert.equal(await page.locator('#updateBanner').isVisible(), false, 'Una instalación inicial no debe anunciar una actualización');
    await context.setOffline(true);
    await page.locator('#checkUpdates').click();
    await page.locator('#updateStatus').filter({ hasText: 'Sin conexión' }).waitFor();
    assert.equal(await page.locator('#countAll').textContent(), '17');
    await context.setOffline(false);
    await page.locator('#checkUpdates').click();
    await page.locator('#updateStatus').filter({ hasText: 'última versión publicada' }).waitFor();
    const second = await context.newPage();
    await second.goto(url, { waitUntil: 'networkidle' });
    await second.locator('#inventoryButton').click();
    await second.locator('#inventoryId').fill('BORRADOR CONSERVADO');
    const before = await page.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1'));
    version = nextVersion;
    brokenDownload = true;
    await page.locator('#checkUpdates').click();
    await page.locator('#updateStatus').filter({ hasText: 'reintentarlo' }).waitFor();
    assert.equal(await page.locator('#updateBanner').isVisible(), false, 'Una descarga inválida no se ofrece para instalar');
    assert.equal(await page.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1')), before);
    brokenDownload = false;
    await page.locator('#checkUpdates').click();
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
    await page.locator('#updateBanner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('script[type="module"]').getAttribute('src'), `app.js?v=${currentVersion}`, 'La descarga necesita permiso antes de reiniciar');
    await page.locator('#postponeUpdate').click();
    assert.equal(await page.locator('#updateBanner').isVisible(), false);
    await context.setOffline(true);
    await page.locator('#checkUpdates').click();
    await page.locator('#updateBanner').waitFor({ state: 'visible' });
    await context.setOffline(false);
    await page.locator('#inventoryButton').click();
    await page.evaluate(() => document.querySelector('#updateButton').click());
    await page.locator('#toast').filter({ hasText: 'Guarda o cierra' }).waitFor();
    assert.ok(await page.locator('#inventoryDialog').isVisible());
    await page.locator('#cancelInventory').click();
    await page.locator('#inventoryDialog').waitFor({ state: 'hidden' });
    await page.locator('#reportButton').click();
    await page.evaluate(() => document.querySelector('#updateButton').click());
    await page.locator('#toast').filter({ hasText: 'Guarda o cierra' }).waitFor();
    assert.ok(await page.locator('#reportDialog').isVisible());
    await page.locator('#cancelReport').click();
    await page.locator('#updateButton').click();
    await page.waitForFunction(version => document.querySelector('script[type="module"]')?.getAttribute('src') === `app.js?v=${version}`, nextVersion, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('#countAll')?.textContent === '17');
    assert.equal(await page.locator('script[type="module"]').getAttribute('src'), `app.js?v=${nextVersion}`);
    assert.equal(await page.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1')), before);
    assert.equal(await second.locator('#inventoryId').inputValue(), 'BORRADOR CONSERVADO');
    const names = await page.evaluate(() => caches.keys());
    assert.ok(names.includes(`calculo-decaimientos-v${currentVersion}`) && names.includes(`calculo-decaimientos-v${nextVersion}`));
    await context.setOffline(true);
    const oldCss = await second.evaluate(async version => (await fetch(`./styles.css?v=${version}`)).text(), currentVersion);
    assert.ok(oldCss.includes(`?v=${currentVersion}`));
    await second.locator('#cancelInventory').click();
    await second.locator('#reportButton').click();
    await second.locator('#downloadReport').click();
    await second.locator('#reportStatus').filter({ hasText: /otra versión|recarga/i }).waitFor();
    assert.equal(await second.locator('#reportDialog').isVisible(), true, 'La pestaña antigua debe explicar cómo actualizarse');
    await second.locator('#cancelReport').click();
    await second.locator('#updateBanner').waitFor({ state: 'visible' });
    await second.locator('#updateButton').click();
    await second.waitForFunction(version => document.querySelector('script[type="module"]')?.getAttribute('src') === `app.js?v=${version}`, nextVersion);

    await context.close();
    version = currentVersion;
    context = await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 } });
    const startup = await context.newPage();
    const errors = [];
    startup.on('pageerror', error => errors.push(error.message));
    await startup.goto(url, { waitUntil: 'networkidle' });
    await startup.locator('#offlineStatus').filter({ hasText: 'Lista para usar' }).waitFor();
    await startup.locator('#updateStatus').filter({ hasText: 'última versión publicada' }).waitFor();
    const startupData = await startup.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1'));
    version = nextVersion;
    await startup.reload({ waitUntil: 'networkidle' });
    await startup.locator('#updateBanner').waitFor({ state: 'visible' });
    assert.equal(await startup.locator('script[type="module"]').getAttribute('src'), `app.js?v=${currentVersion}`, 'Al arrancar se pide permiso antes del reinicio');
    await startup.locator('#postponeUpdate').click();
    await startup.reload({ waitUntil: 'networkidle' });
    await startup.locator('#updateBanner').waitFor({ state: 'visible' });
    assert.ok(await startup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'El aviso debe caber en móvil');
    await startup.screenshot({ path: path.join(output, `updates-v${currentVersion}-${browser.browserType().name()}-mobile.png`) });

    // Pausamos la activación para reproducir una edición iniciada después de aceptar.
    await startup.evaluate(() => {
      window.previousController = navigator.serviceWorker.controller;
      const postMessage = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, ...rest) {
        if (message?.type === 'SKIP_WAITING') {
          window.resumeActivation = () => postMessage.call(this, message, ...rest);
          return;
        }
        return postMessage.call(this, message, ...rest);
      };
    });
    await startup.locator('#updateButton').click();
    await startup.waitForFunction(() => typeof window.resumeActivation === 'function');
    await startup.locator('#inventoryButton').click();
    await startup.locator('#inventoryId').fill('EDICIÓN DURANTE LA ACTIVACIÓN');
    await startup.evaluate(() => window.resumeActivation());
    await startup.waitForFunction(() => navigator.serviceWorker.controller !== window.previousController);
    await startup.locator('#updateStatus').filter({ hasText: 'preparada' }).waitFor();
    assert.equal(await startup.locator('#inventoryId').inputValue(), 'EDICIÓN DURANTE LA ACTIVACIÓN');
    assert.equal(await startup.locator('script[type="module"]').getAttribute('src'), `app.js?v=${currentVersion}`);
    await startup.locator('#cancelInventory').click();
    await startup.locator('#updateButton').click();
    await startup.waitForFunction(version => document.querySelector('script[type="module"]')?.getAttribute('src') === `app.js?v=${version}`, nextVersion);
    assert.equal(await startup.evaluate(() => localStorage.getItem('calculo-decaimientos.state.v1')), startupData);
    assert.deepEqual(errors, [], 'La actualización no debe producir errores JavaScript');
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
