const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function ({ chromium, webkit, devices, baseUrl, output, check, assertPdfBuffer }) {
  const browser = await chromium.launch({ headless: true });
  const key = 'calculo-decaimientos.state.v1';
  async function scenario(name, callback, init, options = {}) {
    await check(name, async () => {
      const context = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid', ...options });
      try {
        if (init) await context.addInitScript(init);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#countAll')?.textContent === '17' && !document.querySelector('#inventoryButton').disabled);
        await callback(page, context);
        assert.deepEqual(errors, [], 'Errores JavaScript no controlados');
      } finally { await context.close(); }
    });
  }
  async function readyOffline(page) {
    await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })); });
    await page.locator('#offlineStatus').filter({ hasText: 'Lista para usar' }).waitFor();
  }
  async function fillSource(page, id) {
    await page.locator('#inventoryButton').click();
    await page.locator('#inventoryId').fill(id);
    await page.locator('#inventoryIsotope').selectOption('Co-60');
    await page.locator('#inventoryReferenceDate').fill('2024-01-01');
    await page.locator('#inventoryActivity').fill('100');
  }
  async function download(page, filename) {
    const pending = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('#downloadReport').click();
    const file = await pending;
    const target = path.join(output, filename);
    await file.saveAs(target);
    assertPdfBuffer(fs.readFileSync(target), filename);
    return target;
  }

  await scenario('el informe se bloquea si el HTML pierde sus estilos', async page => {
    await page.locator('#reportButton').click();
    let downloaded = false;
    page.once('download', () => { downloaded = true; });
    await page.evaluate(() => {
      const stylesheet = document.querySelector('link[rel="stylesheet"]');
      stylesheet.disabled = true;
      document.querySelector('#downloadReport').click();
    });
    await page.waitForFunction(() => /estilos (?:corporativos|locales)/i.test(document.querySelector('#reportStatus')?.textContent || ''));
    await page.waitForTimeout(100);
    assert.equal(downloaded, false, 'No debe descargarse un PDF sin estilos');
  });

  await scenario('edición histórica conserva fecha desconocida y descriptor original', async page => {
    await page.locator('#searchInput').fill('3682');
    await page.locator('[data-action="edit-record"]').click();
    await page.locator('#inventoryNotes').fill('Revisión sin asignar fecha');
    await page.locator('#saveInventory').click();
    await page.locator('#inventoryDialog').waitFor({ state: 'hidden' });
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const record = stored.inventory.find(record => record.identificacion === '3682');
    assert.equal(record.fecha_referencia, '');
    assert.equal(record.tipo_incertidumbre, 'nominal_mas_menos_20_por_ciento');
    assert.match(await page.locator('.source-card').textContent(), /No calculable/);
  });

  await scenario('dos escrituras simultáneas conservan todos los cambios confirmados', async (page, context) => {
    const second = await context.newPage();
    await second.goto(baseUrl, { waitUntil: 'networkidle' });
    await Promise.all([fillSource(page, 'RACE-A'), fillSource(second, 'RACE-B')]);
    await Promise.all([page.locator('#saveInventory').click(), second.locator('#saveInventory').click()]);
    await page.waitForTimeout(200);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.equal(stored.inventory.length, 28);
    assert.equal(stored.inventory.filter(record => /^RACE-/.test(record.identificacion)).length, 1);
    assert.match(`${await page.locator('#inventoryStatus').textContent()} ${await second.locator('#inventoryStatus').textContent()} ${await page.locator('#toast').textContent()} ${await second.locator('#toast').textContent()}`, /otra pestaña/);
  });

  await scenario('sin Web Locks se serializa mediante IndexedDB', async page => {
    await fillSource(page, 'IDB-FALLBACK');
    await page.locator('#saveInventory').click();
    await page.locator('#inventoryDialog').waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.source-card').filter({ hasText: 'IDB-FALLBACK' }).waitFor();
  }, () => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));

  await scenario('cuota agotada mantiene datos y permite descargar una copia', async page => {
    const before = await page.evaluate(key => localStorage.getItem(key), key);
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('Sin espacio', 'QuotaExceededError'); }; });
    await fillSource(page, 'QUOTA');
    await page.locator('#saveInventory').click();
    await page.locator('#toast').filter({ hasText: 'No hay espacio' }).waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), before);
    await page.locator('#cancelInventory').click();
    const pending = page.waitForEvent('download');
    await page.locator('#backupButton').click();
    const file = await pending;
    const exported = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    assert.equal(exported.model.inventory.length, 27);
    assert.equal(exported.storage[key], before);
  });

  await scenario('almacenamiento bloqueado: aviso permanente y sesión funcional', async page => {
    await page.locator('#storageStatus').filter({ hasText: 'solo hasta cerrar' }).waitFor();
    await fillSource(page, 'MEMORY');
    await page.locator('#saveInventory').click();
    await page.locator('.source-card').filter({ hasText: 'MEMORY' }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#countAll').textContent === '17');
  }, () => { Storage.prototype.getItem = () => { throw new Error('Bloqueado'); }; Storage.prototype.setItem = () => { throw new Error('Bloqueado'); }; });

  await scenario('APIs opcionales ausentes: diálogo accesible y descarga PDF', async page => {
    await page.locator('#inventoryButton').click();
    assert.equal(await page.locator('#inventoryDialog').getAttribute('aria-modal'), 'true');
    await page.locator('#saveInventory').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'closeInventory');
    await page.keyboard.press('Escape');
    await page.locator('#inventoryDialog').waitFor({ state: 'hidden' });
    await page.locator('#reportButton').click();
    await download(page, 'informe-v51-apis-opcionales.pdf');
  }, () => {
    HTMLDialogElement.prototype.showModal = undefined;
    HTMLDialogElement.prototype.close = undefined;
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    window.File = undefined;
  });

  await scenario('caché incompleta offline: recuperación comprensible y reparación sin pérdida', async (page, context) => {
    await readyOffline(page);
    const before = await page.evaluate(key => localStorage.getItem(key), key);
    await page.evaluate(async () => { const cache = await caches.open('calculo-decaimientos-v51'); await cache.delete(new URL('./src/domain.js?v=51', location.href)); });
    await context.setOffline(true);
    try {
      const response = await page.goto(`${baseUrl}?damaged=1`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 503);
      assert.match(await page.locator('body').textContent(), /datos guardados se conservan/);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), before);
    } finally { await context.setOffline(false); }
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#countAll')?.textContent === '17');
    await readyOffline(page);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), before);
  });

  await scenario('datos guardados accesibles aunque fallen los CSV originales', async (page, context) => {
    await context.route('**/isotopos.csv*', route => route.abort());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#countAll')?.textContent === '17');
    await page.locator('#storageStatus').filter({ hasText: 'Se usan tus datos guardados' }).waitFor();
  }, null, { serviceWorkers: 'block' });

  await scenario('impresión horizontal y paginación real de una agrupación grande', async page => {
    await page.evaluate(key => {
      const current = JSON.parse(localStorage.getItem(key));
      const template = current.inventory[0];
      for (let index = 0; index < 18; index += 1) {
        const name = `TEST-${index}`;
        current.isotopes.push({ isotopo: name, semivida_valor: '10', semivida_unidad: 'dias', fuente: 'Prueba' });
        current.inventory.push({ ...template, record_id: `large-${index}`, identificacion: 'GRUPO GRANDE', radionuclido: name, tipo_incertidumbre: 'Texto metrológico largo para probar los saltos de línea '.repeat(2) });
      }
      current.revision += 1;
      localStorage.setItem(key, JSON.stringify(current));
    }, key);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#searchInput').fill('GRUPO GRANDE');
    await page.locator('#reportButton').click();
    await page.locator('#reportVisibleOnly').check();
    await download(page, 'informe-v51-grupo-grande.pdf');
    assert.equal(await page.locator('#printReportView .report-nuclide').count(), 18);
    assert.ok(await page.locator('#printReportView .report-card').count() > 1);
    await page.emulateMedia({ media: 'print' });
    const printed = await page.pdf({ path: path.join(output, 'impresion-v51.pdf'), preferCSSPageSize: true, printBackground: true });
    assert.ok(printed.subarray(0, 4).toString() === '%PDF');
    const printLayout = await page.evaluate(() => ({
      records: document.querySelectorAll('#printReportView .report-nuclide').length,
      overflowing: [...document.querySelectorAll('#printReportView .report-column')].some(column => column.scrollHeight > column.parentElement.clientHeight + 2)
    }));
    assert.equal(printLayout.records, 45, 'La impresión debe conservar todos los registros originales y de prueba');
    assert.equal(printLayout.overflowing, false, 'La impresión recorta una agrupación extensa');
    await page.emulateMedia({ media: 'screen' });
  });

  await check('actualización real entre dos pestañas conserva datos, borrador y PDF offline anterior', () => require('./update-browser.cjs')(browser, output));
  await browser.close();
  await check('perfil iPad WebKit con informe PDF', async () => {
    const browser = await webkit.launch({ headless: true, timeout: 20000 });
    try {
      const context = await browser.newContext({ ...devices['iPad Pro 11'], locale: 'es-ES' });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.locator('#reportButton:not([disabled])').waitFor();
      await page.locator('#reportButton').click();
      await download(page, 'informe-v51-ipad.pdf');
      assert.equal(await page.locator('.report-nuclide').count(), 27);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    } finally { await browser.close(); }
  });
};
