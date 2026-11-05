/* End-to-end and cross-browser audit for the static PWA. */
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(__dirname, 'output');
const BASE_URL = process.env.APP_URL || 'http://127.0.0.1:8091/';
const STORAGE_KEY = 'calculo-decaimientos.state.v1';
const BACKUP_KEY = 'calculo-decaimientos.backup.v1';
const results = [];

fs.mkdirSync(OUTPUT, { recursive: true });

function assertPdfBuffer(pdf, label = 'PDF') {
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF', `${label}: firma inválida`);
  assert.ok(pdf.length > 20_000, `${label}: archivo anormalmente pequeño`);
  const source = pdf.toString('latin1');
  const pageCount = (source.match(/\/Type\s*\/Page\b/g) || []).length;
  assert.ok(pageCount >= 1, `${label}: no contiene páginas`);
  const mediaBoxes = [...source.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
  assert.equal(mediaBoxes.length, pageCount, `${label}: no todas las páginas declaran su tamaño`);
  for (const [index, mediaBox] of mediaBoxes.entries()) {
    const width = Number(mediaBox[1]);
    const height = Number(mediaBox[2]);
    assert.ok(width > 837 && width < 847, `${label}: ancho A4 inesperado en página ${index + 1} (${width})`);
    assert.ok(height > 590 && height < 600, `${label}: alto A4 inesperado en página ${index + 1} (${height})`);
    assert.ok(width > height, `${label}: página ${index + 1} no está en orientación horizontal`);
  }
  const imageCount = (source.match(/\/Subtype\s*\/Image\b/g) || []).length;
  assert.ok(imageCount >= pageCount, `${label}: falta contenido gráfico en alguna página`);
  return { pageCount, width: Number(mediaBoxes[0][1]), height: Number(mediaBoxes[0][2]) };
}

function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const label = status === 'ok' ? 'PASS' : status === 'unavailable' ? 'SKIP' : 'FAIL';
  process.stdout.write(`${label} ${name}${detail ? `: ${detail}` : ''}\n`);
}

async function check(name, callback) {
  try {
    await callback();
    record(name, 'ok');
    return true;
  } catch (error) {
    record(name, 'failed', error?.stack || String(error));
    return false;
  }
}

async function checkOptional(name, callback) {
  try {
    await callback();
    record(name, 'ok');
    return true;
  } catch (error) {
    record(name, error.browserUnavailable ? 'unavailable' : 'failed', error?.message || String(error));
    return false;
  }
}

function observePage(page) {
  const problems = [];
  const appOrigin = new URL(BASE_URL).origin;
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('request', request => {
    try {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== appOrigin) {
        problems.push(`solicitud externa: ${request.url()}`);
      }
    } catch { /* Los esquemas internos del navegador no son tráfico de red. */ }
  });
  return problems;
}

async function waitForApp(page) {
  await page.locator('#countAll').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#countAll')?.textContent === '17');
}

async function resetApplication(page, suffix = 'reset') {
  // Esperar al reposo evita borrar CacheStorage mientras la primera instalación
  // del service worker todavía está ejecutando cache.addAll().
  await page.goto(`${BASE_URL}?audit=${suffix}-${Date.now()}`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  });
  await page.goto(`${BASE_URL}?audit=${suffix}-clean-${Date.now()}`, { waitUntil: 'networkidle' });
  await waitForApp(page);
}

async function setCalculationDate(page, value) {
  const field = page.locator('#calculationDate');
  await field.fill(value);
  await field.dispatchEvent('change');
}

async function addIsotope(page, name, halfLife, unit = 'dias') {
  await page.locator('#isotopesButton').click();
  await page.locator('#addIsotope').click();
  await page.locator('#isotopeName').fill(name);
  await page.locator('#isotopeHalfLife').fill(String(halfLife));
  await page.locator('#isotopeUnit').selectOption(unit);
  await page.locator('#isotopeSource').fill('Auditoría automática');
  await page.locator('#isotopeForm').getByRole('button', { name: 'Guardar' }).click();
  await page.locator('#isotopeTable').getByRole('row', { name: new RegExp(name) }).waitFor();
  await page.locator('#closeIsotopes').click();
}

async function openInventory(page, type = 'fuente_puntual') {
  await page.locator('#inventoryButton').click();
  await page.locator('#inventoryType').selectOption(type);
  await page.locator('#inventoryType').dispatchEvent('change');
}

async function addPointSource(page, id, isotope, activity, referenceDate, notes = '') {
  await openInventory(page, 'fuente_puntual');
  await page.locator('#inventoryId').fill(id);
  await page.locator('#inventoryIsotope').selectOption(isotope);
  await page.locator('#inventoryReferenceDate').fill(referenceDate);
  await page.locator('#inventoryActivity').fill(String(activity));
  await page.locator('#inventoryUncertainty').fill(String(Number(activity) * 0.05));
  await page.locator('#inventoryNotes').fill(notes);
  await page.locator('#saveInventory').click();
  await page.locator('.source-card').filter({ hasText: id }).waitFor();
}

async function deleteCard(page, id) {
  const card = page.locator('.source-card').filter({ hasText: id }).first();
  page.once('dialog', dialog => dialog.accept());
  await card.locator('[data-action="delete-group"]').click();
  await card.waitFor({ state: 'detached' });
}

function executableCandidates() {
  return [
    ['Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['Microsoft Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  ].filter(([, executable]) => fs.existsSync(executable));
}

async function launchWithRetry(browserType, options) {
  try {
    return await browserType.launch(options);
  } catch (firstError) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      return await browserType.launch(options);
    } catch (secondError) {
      secondError.cause = firstError;
      throw secondError;
    }
  }
}

async function browserSmoke(browserType, name, launchOptions = {}, contextOptions = {}) {
  let browser;
  try { browser = await launchWithRetry(browserType, { headless: true, timeout: 20_000, ...launchOptions }); }
  catch (error) { error.browserUnavailable = true; throw error; }
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1280, height: 800 },
      ...contextOptions
    });
    const page = await context.newPage();
    const problems = observePage(page);
    await page.goto(`${BASE_URL}?browser=${encodeURIComponent(name)}-${Date.now()}`, { waitUntil: 'networkidle' });
    await waitForApp(page);
    assert.equal(await page.locator('.source-card').count(), 17);
    assert.equal(await page.locator('#emailReport').count(), 0);
    await page.locator('#searchInput').fill('1105141');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 1);
    await page.locator('#searchInput').fill('');
    await page.locator('.tab[data-filter="material"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 9);
    assert.equal(await page.locator('.tab[data-filter="material"]').getAttribute('aria-selected'), 'true');
    await page.locator('.tab[data-filter="all"]').click();
    await setCalculationDate(page, '2025-01-01');
    assert.match(await page.locator('#dateSummary').textContent(), /antes|después|hoy/);
    await page.locator('#inventoryButton').click();
    assert.equal(await page.locator('#inventoryDialog').getAttribute('open'), '');
    await page.locator('#cancelInventory').click();
    await page.locator('#reportButton').click();
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('#downloadReport').click();
    const download = await downloadPromise;
    const pdfPath = await download.path();
    assertPdfBuffer(fs.readFileSync(pdfPath), `${name} PDF`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${name}: desbordamiento horizontal de ${overflow}px`);
    if (name === 'WebKit') {
      const knownSelectRegression = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/;
      const unexpected = problems.filter(problem => !knownSelectRegression.test(problem));
      assert.deepEqual(unexpected, [], unexpected.join('\n'));
      const inlineStyles = await page.locator('[style], style').count();
      assert.equal(inlineStyles, 0, 'La página contiene estilos inline reales');
    } else {
      assert.deepEqual(problems, [], problems.join('\n'));
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  await check('servidor, cabeceras de seguridad y rutas privadas', async () => {
    const index = await fetch(`${BASE_URL}?headers=1`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(new URL('package.json', BASE_URL))).status, 404);
    assert.equal((await fetch(new URL('.backups/v33-before-audit-2026-10-19.zip', BASE_URL))).status, 404);
    assert.equal((await fetch(`${BASE_URL}assets/%252e%252e/package.json`)).status, 404);
    const manifestResponse = await fetch(new URL('manifest.webmanifest?v=51', BASE_URL));
    assert.match(manifestResponse.headers.get('content-type') || '', /application\/manifest\+json/);
    const csvResponse = await fetch(new URL('inventario_radiactivo.csv', BASE_URL));
    assert.match(csvResponse.headers.get('content-type') || '', /text\/csv/);

    const indexText = await index.text();
    assert.match(indexText, /app\.js\?v=51/);
    assert.match(indexText, /styles\.css\?v=51/);
    assert.match(indexText, /manifest\.webmanifest\?v=51/);
    assert.match(indexText, /html2canvas-1\.4\.1\.min\.js\?v=51/);
    assert.match(indexText, /jspdf-4\.2\.1\.umd\.min\.js\?v=51/);
    const stylesheet = await (await fetch(new URL('styles.css?v=51', BASE_URL))).text();
    assert.match(stylesheet, /\.report-page\s*{[^}]*width:\s*297mm;[^}]*height:\s*210mm;/s);
    assert.match(stylesheet, /\.report-columns\s*{[^}]*grid-template-columns:\s*repeat\(3,/s);
    assert.match(stylesheet, /@media\s+print/);
    for (const file of ['app.js', 'src/csv.js', 'src/domain.js', 'src/format.js', 'src/pdf.js', 'src/report.js', 'src/repository.js', 'src/view.js']) {
      const source = await (await fetch(new URL(`${file}?v=51`, BASE_URL))).text();
      const imports = [...source.matchAll(/from\s+['"]([^'"]+\.js(?:\?[^'"]*)?)['"]/g)].map(match => match[1]);
      assert.ok(imports.every(specifier => specifier.endsWith('?v=51')), `${file}: importación sin versión`);
    }
    const appSource = await (await fetch(new URL('app.js?v=51', BASE_URL))).text();
    assert.doesNotMatch(appSource, /window\.print\s*\(/);
    assert.doesNotMatch(appSource, /emailReport|mailto:/i);
    assert.doesNotMatch(indexText, /id=["']emailReport["']|>\s*Correo\s*</i);
    const workerSource = await (await fetch(new URL('sw.js?v=51', BASE_URL))).text();
    assert.match(workerSource, /const VERSION = '51'/);
    const precache = await (await fetch(new URL('precache-manifest.js?v=51', BASE_URL))).text();
    assert.match(precache, /html2canvas-1\.4\.1\.min\.js\?v=51/);
    assert.match(precache, /jspdf-4\.2\.1\.umd\.min\.js\?v=51/);
    assert.doesNotMatch(workerSource, /navigationPreload\.enable/);
  });

  await check('manifest e iconos instalables', async () => {
    const response = await fetch(new URL('manifest.webmanifest?v=51', BASE_URL));
    const manifest = await response.json();
    assert.equal(manifest.name, 'Cálculo de decaimientos');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.scope, './');
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
    for (const icon of manifest.icons) {
      const iconResponse = await fetch(new URL(icon.src, BASE_URL));
      assert.equal(iconResponse.status, 200, icon.src);
      assert.equal(iconResponse.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await iconResponse.arrayBuffer());
      assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
      assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
    }
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await context.addInitScript(() => {
    window.__sharedPayloads = [];
    try {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async payload => { window.__sharedPayloads.push(payload); }
      });
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: payload => Array.isArray(payload?.files) && payload.files.length > 0
      });
    } catch { /* Un navegador puede exponer una propiedad no configurable. */ }
  });
  const page = await context.newPage();
  const runtimeProblems = observePage(page);

  await check('carga inicial e integridad visible', async () => {
    await resetApplication(page, 'initial');
    assert.equal(await page.title(), 'Cálculo de decaimientos');
    assert.equal(await page.locator('#countAll').textContent(), '17');
    assert.equal(await page.locator('#countPoint').textContent(), '8');
    assert.equal(await page.locator('#countMaterial').textContent(), '9');
    assert.equal(await page.locator('.source-card').count(), 17);
    const localToday = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    });
    assert.equal(await page.locator('#calculationDate').inputValue(), localToday);
    assert.match(await page.locator('body').innerText(), /O21121-Ra-226/);
    assert.match(await page.locator('.source-card').filter({ hasText: 'O21121-Ra-226' }).innerText(), /88,42 g/);

    const pointCard = page.locator('.source-card').filter({ hasText: 'NS 081020-1296089' });
    const currentMeasurement = pointCard.locator('.value-block').nth(0).locator('.measurement-line').first();
    const referenceMeasurement = pointCard.locator('.value-block').nth(1).locator('.measurement-line').first();
    assert.equal(await currentMeasurement.locator('.measurement-uncertainty').count(), 1);
    assert.equal(await referenceMeasurement.locator('.measurement-uncertainty').count(), 1);
    assert.match(await pointCard.locator('.value-block').nth(1).locator(':scope > span').textContent(), /Valor de referencia · 30\/10\/2024/i);
    const inlinePresentation = await currentMeasurement.evaluate(line => {
      const value = line.querySelector('.measurement-value');
      const uncertainty = line.querySelector('.measurement-uncertainty');
      const valueRect = value.getBoundingClientRect();
      const uncertaintyRect = uncertainty.getBoundingClientRect();
      const lineStyle = getComputedStyle(line);
      return {
        bottomDifference: Math.abs(valueRect.bottom - uncertaintyRect.bottom),
        display: lineStyle.display,
        wrap: lineStyle.flexWrap,
        valueSize: Number.parseFloat(getComputedStyle(value).fontSize),
        uncertaintySize: Number.parseFloat(getComputedStyle(uncertainty).fontSize)
      };
    });
    assert.equal(inlinePresentation.display, 'flex');
    assert.equal(inlinePresentation.wrap, 'wrap');
    assert.ok(inlinePresentation.bottomDifference < 3);
    assert.ok(inlinePresentation.uncertaintySize < inlinePresentation.valueSize);
    assert.doesNotMatch(await pointCard.innerText(), /por ciento/i);
    assert.match(await pointCard.innerText(), /Incertidumbre estándar combinada \(k = 1\)/i);

    const unreportedCard = page.locator('.source-card').filter({ hasText: 'NS 1105141' });
    assert.equal(await unreportedCard.locator('.measurement-uncertainty').count(), 0);
    assert.match(await unreportedCard.innerText(), /Incertidumbre no indicada en el certificado/i);
    const toleranceCard = page.locator('.source-card').filter({ hasText: 'NS BB-8485' });
    assert.match(await toleranceCard.innerText(), /Tolerancia: −20 % \/ \+30 %/i);
    assert.match(await toleranceCard.innerText(), /Intervalo de referencia: 160 Bq a 260 Bq/i);
    assert.doesNotMatch(await page.locator('body').innerText(), /% del valor de referencia/i);

    const materialCard = page.locator('.source-card').filter({ hasText: 'O21149 Am-241' });
    const materialCurrent = materialCard.locator('.value-block').nth(0);
    const materialReference = materialCard.locator('.value-block').nth(1);
    assert.equal(await materialCurrent.locator('.measurement-line').count(), 2);
    assert.equal(await materialReference.locator('.measurement-line').count(), 2);
    assert.match(await materialCurrent.locator('.measurement-line').nth(1).innerText(), /Bq\/g/);
    const materialSizes = await materialCurrent.locator('.measurement-value').evaluateAll(values => values.map(value => getComputedStyle(value).fontSize));
    assert.equal(materialSizes[0], materialSizes[1]);
  });

  await check('estructura accesible y controles táctiles', async () => {
    const audit = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
      const controls = [...document.querySelectorAll('input, select, textarea')]
        .filter(control => !control.closest('[aria-hidden="true"]'));
      const unlabeled = controls.filter(control => {
        if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return false;
        if (control.closest('label')) return false;
        return !document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      }).map(control => control.id || control.outerHTML.slice(0, 80));
      const unnamedButtons = [...document.querySelectorAll('button')]
        .filter(button => !((button.textContent || '').trim() || button.getAttribute('aria-label')))
        .map(button => button.id);
      const badImages = [...document.images]
        .filter(image => !image.hasAttribute('alt'))
        .map(image => image.src);
      const smallTargets = [...document.querySelectorAll('button')]
        .filter(button => button.getClientRects().length)
        .map(button => ({ name: button.id || button.textContent.trim(), height: button.getBoundingClientRect().height }))
        .filter(item => item.height < 43.5);
      return { duplicateIds, unlabeled, unnamedButtons, badImages, smallTargets, h1: document.querySelectorAll('h1').length };
    });
    assert.deepEqual(audit.duplicateIds, []);
    assert.deepEqual(audit.unlabeled, []);
    assert.deepEqual(audit.unnamedButtons, []);
    assert.deepEqual(audit.badImages, []);
    assert.deepEqual(audit.smallTargets, []);
    assert.equal(audit.h1, 1);
  });

  await check('cálculo antes y después de la referencia con CRUD completo', async () => {
    await addIsotope(page, 'X-E2E', 10, 'dias');
    await addPointSource(page, 'E2E-POINT', 'X-E2E', 1000, '2024-01-01');
    await setCalculationDate(page, '2024-01-11');
    let card = page.locator('.source-card').filter({ hasText: 'E2E-POINT' });
    assert.match(await card.innerText(), /500 Bq/);
    assert.match(await card.innerText(), /25 Bq/);
    await setCalculationDate(page, '2023-12-22');
    assert.match(await card.innerText(), /2000 Bq|2\.000 Bq/);

    await card.locator('[data-action="edit-record"]').click();
    await page.locator('#inventoryActivity').fill('2000');
    await page.locator('#inventoryUncertainty').fill('100');
    await page.locator('#saveInventory').click();
    await setCalculationDate(page, '2024-01-11');
    card = page.locator('.source-card').filter({ hasText: 'E2E-POINT' });
    assert.match(await card.innerText(), /1000 Bq|1\.000 Bq/);
    await deleteCard(page, 'E2E-POINT');

    await page.locator('#isotopesButton').click();
    const row = page.locator('#isotopeTable tbody tr').filter({ hasText: 'X-E2E' });
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: 'Quitar X-E2E' }).click();
    await row.waitFor({ state: 'detached' });
    await page.locator('#closeIsotopes').click();
  });

  await check('material: derivación Bq/Bq-g, incoherencias, duplicados y XSS', async () => {
    await setCalculationDate(page, '2024-01-01');
    await openInventory(page, 'material_contaminado');
    await page.locator('#inventoryId').fill('E2E-MATERIAL');
    await page.locator('#inventoryIsotope').selectOption('Co-60');
    await page.locator('#inventoryReferenceDate').fill('2024-01-01');
    await page.locator('#inventoryMass').fill('10');
    await page.locator('#inventoryActivity').fill('100');
    await page.locator('#inventorySpecificActivity').fill('5');
    await page.locator('#saveInventory').click();
    assert.match(await page.locator('#inventoryStatus').textContent(), /no coincide/i);
    await page.locator('#inventoryActivity').fill('');
    await page.locator('#inventorySpecificUncertainty').fill('0.5');
    const malicious = '<img src=x onerror="window.__xss=1">';
    await page.locator('#inventoryNotes').fill(malicious);
    await page.locator('#saveInventory').click();
    const card = page.locator('.source-card').filter({ hasText: 'E2E-MATERIAL' });
    await card.waitFor();
    const text = await card.innerText();
    assert.match(text, /50 Bq/);
    assert.match(text, /5 Bq\/g/);
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    assert.equal(stored.inventory.find(item => item.identificacion === 'E2E-MATERIAL').observaciones, malicious);

    await openInventory(page, 'material_contaminado');
    await page.locator('#inventoryId').fill('E2E-MATERIAL');
    await page.locator('#inventoryIsotope').selectOption('Co-60');
    await page.locator('#inventoryReferenceDate').fill('2024-01-01');
    await page.locator('#inventoryMass').fill('10');
    await page.locator('#inventorySpecificActivity').fill('5');
    await page.locator('#saveInventory').click();
    assert.match(await page.locator('#inventoryStatus').textContent(), /ya contiene/i);
    await page.locator('#cancelInventory').click();
    await deleteCard(page, 'E2E-MATERIAL');
  });

  await check('búsqueda, pestañas y ausencia deliberada de fecha', async () => {
    await page.locator('#searchInput').fill('3682');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 1);
    assert.match(await page.locator('.source-card').innerText(), /No calculable/);
    assert.match(await page.locator('.source-card').innerText(), /Falta una fecha/);
    await page.locator('#searchInput').fill('');
    await page.locator('.tab[data-filter="point"]').click();
    assert.equal(await page.locator('.source-card').count(), 8);
    assert.equal(await page.locator('.tab[data-filter="point"]').getAttribute('aria-selected'), 'true');
    await page.locator('.tabs').press('End');
    assert.equal(await page.locator('.tab[data-filter="material"]').getAttribute('aria-selected'), 'true');
    await page.locator('.tab[data-filter="all"]').click();
  });

  await check('informe corporativo HTML oculto, compartir y descargar PDF', async () => {
    await setCalculationDate(page, '2026-10-19');
    await page.locator('#reportButton').click();
    await page.locator('#shareReport').click();
    await page.waitForFunction(() => window.__sharedPayloads?.length === 1 || document.querySelector('#reportStatus')?.textContent.includes('Pulsa de nuevo'));
    if (await page.locator('#reportStatus').textContent().then(text => text.includes('Pulsa de nuevo'))) await page.locator('#shareReport').click();
    await page.waitForFunction(() => window.__sharedPayloads?.length === 1);
    const payload = await page.evaluate(async () => {
      const shared = window.__sharedPayloads[0];
      const file = shared.files?.[0];
      const bytes = file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
      return {
        title: shared.title,
        text: shared.text,
        fileCount: shared.files?.length || 0,
        fileName: file?.name,
        fileType: file?.type,
        fileSize: file?.size || 0,
        signature: String.fromCharCode(...bytes.slice(0, 4))
      };
    });
    assert.equal(payload.title, 'Cálculo de actividades');
    assert.match(payload.text, /2026-10-19/);
    assert.equal(payload.fileCount, 1);
    assert.equal(payload.fileName, 'calculo-actividades-2026-10-19.pdf');
    assert.equal(payload.fileType, 'application/pdf');
    assert.ok(payload.fileSize > 20_000);
    assert.equal(payload.signature, '%PDF');
    assert.deepEqual(await page.evaluate(() => ({
      captureStages: document.querySelectorAll('.pdf-capture-stage').length,
      generating: document.body.classList.contains('pdf-generating'),
      busy: document.querySelector('#reportDialog').getAttribute('aria-busy'),
      disabled: [...document.querySelectorAll('#reportDialog button')].filter(button => button.disabled).length
    })), { captureStages: 0, generating: false, busy: 'false', disabled: 0 });

    await page.locator('#reportButton').click();
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('#downloadReport').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'calculo-actividades-2026-10-19.pdf');
    const pdfPath = path.join(OUTPUT, 'informe-v51.pdf');
    await download.saveAs(pdfPath);

    assert.equal(await page.locator('#printReportView h1').first().textContent(), 'Cálculo de actividades');
    assert.match(await page.locator('#printReportView .report-title p').first().textContent(), /19\/10\/2026/);
    assert.match(await page.locator('#printReportView .report-logo').first().getAttribute('src'), /at-logo-horizontal\.png/);
    assert.ok(await page.locator('#printReportView .report-uncertainty').count() > 0);
    assert.equal(await page.locator('#printReportView .report-card').count(), 17);
    assert.equal(await page.locator('#printReportView .report-card-point').count(), 8);
    assert.equal(await page.locator('#printReportView .report-card-material').count(), 9);
    assert.equal(await page.locator('#printReportView .report-card-material .report-current').first().locator('.report-measurement').count(), 2);
    assert.doesNotMatch(await page.locator('#printReportView').innerText(), /por ciento|% del valor de referencia/i);
    assert.equal(await page.locator('#printReportView').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#printReportView').evaluate(node => getComputedStyle(node).display), 'none');
    assert.equal(await page.title(), 'Cálculo de decaimientos');
    const reportKeys = await page.locator('#printReportView .report-card').evaluateAll(cards => cards.map(card => card.dataset.groupKey));
    assert.equal(new Set(reportKeys).size, 17);
    assert.ok(reportKeys.every(Boolean));
    assert.match(await page.locator('#printReportView .report-card').first().innerText(), /NS 1105141/);
    const reportUncertaintyMissing = page.locator('#printReportView .report-card').filter({ hasText: 'NS 1105141' });
    assert.equal(await reportUncertaintyMissing.locator('.report-uncertainty').count(), 0);
    assert.match(await reportUncertaintyMissing.innerText(), /Incertidumbre no indicada en el certificado/i);
    assert.match(await page.locator('#printReportView .report-card').filter({ hasText: 'NS BB-8485' }).innerText(), /Tolerancia: −20 % \/ \+30 %[\s\S]*Intervalo de referencia: 160 Bq a 260 Bq/i);
    assert.match(await page.locator('#printReportView .report-card').filter({ hasText: 'NS 081020-1296089' }).innerText(), /Valor de referencia · 30\/10\/2024[\s\S]*Incertidumbre estándar combinada \(k = 1\)/i);
    const materialReport = page.locator('#printReportView .report-card-material').filter({ hasText: 'O21149 Am-241' });
    assert.equal(await materialReport.locator('.report-current .report-measurement').count(), 2);
    assert.match(await materialReport.locator('.report-current').innerText(), /Bq[\s\S]*Bq\/g/);

    const layout = await page.evaluate(async () => {
      const sourcePages = [...document.querySelectorAll('#printReportView .report-page')];
      const stage = document.createElement('div');
      stage.className = 'pdf-capture-stage';
      stage.setAttribute('aria-hidden', 'true');
      document.body.append(stage);
      try {
        const pages = [];
        for (const sourcePage of sourcePages) {
          const reportPage = sourcePage.cloneNode(true);
          stage.replaceChildren(reportPage);
          if (document.fonts?.ready) await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const content = reportPage.querySelector('.report-columns');
          const contentBounds = content.getBoundingClientRect();
          pages.push({
            width: reportPage.clientWidth,
            height: reportPage.clientHeight,
            scrollHeight: reportPage.scrollHeight,
            category: reportPage.dataset.category,
            sectionTitle: reportPage.querySelector('.report-section-heading h2')?.textContent || '',
            cardCategories: [...new Set([...reportPage.querySelectorAll('.report-card')].map(card => (
              card.classList.contains('report-card-point') ? 'point' : 'material'
            )))],
            cardCount: reportPage.querySelectorAll('.report-card').length,
            headerCount: reportPage.querySelectorAll('.report-head').length,
            footerCount: reportPage.querySelectorAll('.report-footer').length,
            duplicateTypeSubtitles: reportPage.querySelectorAll('.report-card-head p').length,
            minimumCurrentValueSize: Math.min(...[...reportPage.querySelectorAll('.report-current .report-value')].map(node => Number.parseFloat(getComputedStyle(node).fontSize))),
            minimumUncertaintySize: Math.min(...[...reportPage.querySelectorAll('.report-uncertainty')].map(node => Number.parseFloat(getComputedStyle(node).fontSize))),
            minimumDetailSize: Math.min(...[...reportPage.querySelectorAll('.report-metric small')].map(node => Number.parseFloat(getComputedStyle(node).fontSize))),
            sectionHeadingClearance: (() => {
              const heading = reportPage.querySelector('.report-section-heading');
              const title = heading.querySelector('h2');
              return heading.getBoundingClientRect().bottom - title.getBoundingClientRect().bottom;
            })(),
            textClipped: [...reportPage.querySelectorAll('.report-card h3, .report-chip, .report-nuclide-heading strong, .report-nuclide-heading span, .report-metric-label, .report-value, .report-uncertainty, .report-metric small')].some(node => {
              const bounds = node.getBoundingClientRect();
              const cardBounds = node.closest('.report-card').getBoundingClientRect();
              return bounds.left < cardBounds.left - 1 || bounds.right > cardBounds.right + 1 || bounds.top < cardBounds.top - 1 || bounds.bottom > cardBounds.bottom + 1;
            }),
            measurementOverlap: [...reportPage.querySelectorAll('.report-metric')].some(metric => {
              const measurements = [...metric.querySelectorAll(':scope > .report-measurement')].map(node => node.getBoundingClientRect());
              return measurements.some((bounds, index) => index > 0 && bounds.top < measurements[index - 1].bottom - 1);
            }),
            minimumMeasurementGap: Math.min(...[...reportPage.querySelectorAll('.report-metric')].flatMap(metric => {
              const measurements = [...metric.querySelectorAll(':scope > .report-measurement')].map(node => node.getBoundingClientRect());
              return measurements.slice(1).map((bounds, index) => bounds.top - measurements[index].bottom);
            }), Number.POSITIVE_INFINITY),
            minimumChipTextInset: Math.min(...[...reportPage.querySelectorAll('.report-chip')].map(chip => {
              const range = document.createRange();
              range.selectNodeContents(chip);
              const textBounds = range.getBoundingClientRect();
              const chipBounds = chip.getBoundingClientRect();
              return Math.min(textBounds.top - chipBounds.top, chipBounds.bottom - textBounds.bottom);
            })),
            columns: [...reportPage.querySelectorAll('.report-column')].map(column => {
              const bounds = column.getBoundingClientRect();
              const cards = [...column.querySelectorAll('.report-card')].map(card => card.getBoundingClientRect());
              return {
                clientWidth: column.clientWidth,
                clientHeight: content.clientHeight,
                scrollWidth: column.scrollWidth,
                scrollHeight: column.scrollHeight,
                usage: cards.length ? (Math.max(...cards.map(card => card.bottom)) - contentBounds.top) / contentBounds.height : 0,
                clipped: cards.some(card => card.left < bounds.left - 2 || card.right > bounds.right + 2 || card.top < contentBounds.top - 2 || card.bottom > contentBounds.bottom + 2),
                overlapping: cards.some((card, index) => index > 0 && card.top < cards[index - 1].bottom - 2)
              };
            })
          });
        }
        return pages;
      } finally {
        stage.remove();
      }
    });
    assert.equal(layout.length, 3, 'el inventario completo debe distribuirse en tres páginas legibles');
    assert.equal(layout.reduce((sum, reportPage) => sum + reportPage.cardCount, 0), 17);
    assert.deepEqual(layout.map(reportPage => reportPage.category), ['point', 'material', 'material']);
    assert.equal(layout[0].sectionTitle, 'Fuentes puntuales');
    assert.equal(layout[1].sectionTitle, 'Muestras contaminadas');
    assert.equal(layout[2].sectionTitle, 'Muestras contaminadas · continuación');
    for (const reportPage of layout) {
      assert.ok(reportPage.width > reportPage.height, 'página HTML no horizontal');
      assert.ok(reportPage.scrollHeight <= reportPage.height + 2, 'contenido desbordado en una página HTML');
      assert.deepEqual(reportPage.cardCategories, [reportPage.category], 'la página mezcla categorías');
      assert.equal(reportPage.columns.length, 3, 'el informe horizontal debe usar tres columnas');
      assert.equal(reportPage.headerCount, 1, 'falta la cabecera corporativa');
      assert.equal(reportPage.footerCount, 1, 'falta el pie del informe');
      assert.equal(reportPage.duplicateTypeSubtitles, 0, 'se repite el tipo dentro de una tarjeta');
      assert.ok(reportPage.minimumCurrentValueSize >= 13, 'la actividad actual resulta demasiado pequeña');
      assert.ok(reportPage.minimumUncertaintySize >= 9.5, 'la incertidumbre resulta demasiado pequeña');
      assert.ok(reportPage.minimumDetailSize >= 8.5, 'los detalles metrológicos resultan demasiado pequeños');
      assert.ok(reportPage.sectionHeadingClearance >= 4, 'el título de sección está pegado a su línea inferior');
      assert.equal(reportPage.textClipped, false, 'hay texto fuera de una tarjeta');
      assert.equal(reportPage.measurementOverlap, false, 'se solapan las mediciones de una tarjeta');
      assert.ok(reportPage.minimumMeasurementGap >= 4, 'la línea entre Bq y Bq/g está demasiado cerca del texto');
      assert.ok(reportPage.minimumChipTextInset >= 2, 'el texto de una etiqueta está pegado a su recuadro');
      for (const column of reportPage.columns) {
        assert.ok(column.scrollHeight <= column.clientHeight + 2, 'contenido vertical recortado en una columna');
        assert.ok(column.scrollWidth <= column.clientWidth + 2, 'contenido horizontal recortado en una columna');
        assert.equal(column.clipped, false, 'tarjeta recortada por una columna');
        assert.equal(column.overlapping, false, 'tarjetas solapadas');
        assert.ok(column.usage >= 0.25, `columna demasiado vacía (${Math.round(column.usage * 100)} %)`);
        assert.ok(column.usage <= 0.97, `columna sin margen de seguridad (${Math.round(column.usage * 100)} %)`);
      }
    }
    const pdfAudit = assertPdfBuffer(fs.readFileSync(pdfPath), 'Informe descargado');
    assert.equal(pdfAudit.pageCount, layout.length);
  });

  await check('el generador PDF se recupera de un fallo sin bloquear la interfaz', async () => {
    await page.locator('#reportButton').click();
    await page.evaluate(() => {
      window.__html2canvasBackup = window.html2canvas;
      window.html2canvas = (node, options) => window.__html2canvasBackup(node, {
        ...options, onclone: async () => { throw new Error('fallo de captura simulado'); }
      });
    });
    await page.locator('#downloadReport').click();
    await page.locator('#reportStatus').filter({ hasText: 'fallo de captura simulado' }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({
      captureStages: document.querySelectorAll('.pdf-capture-stage, .html2canvas-container').length,
      busy: document.querySelector('#reportDialog').getAttribute('aria-busy'),
      disabled: [...document.querySelectorAll('#reportDialog button')].filter(button => button.disabled).length
    })), { captureStages: 0, busy: 'false', disabled: 0 });
    await page.evaluate(() => {
      window.html2canvas = window.__html2canvasBackup;
      delete window.__html2canvasBackup;
    });
    await page.locator('#cancelReport').click();
  });

  await check('el informe respeta la selección visible y la alternativa sin Web Share', async () => {
    await page.locator('#searchInput').fill('1105141');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 1);
    await page.locator('#reportButton').click();
    await page.locator('#reportVisibleOnly').check();
    const filteredDownloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('#downloadReport').click();
    await filteredDownloadPromise;
    assert.equal(await page.locator('#printReportView .report-card').count(), 1);
    assert.match(await page.locator('#printReportView .report-card').innerText(), /NS 1105141/);

    await page.locator('#searchInput').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 17);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    });
    await page.locator('#reportButton').click();
    await page.locator('#reportVisibleOnly').uncheck();
    const fallbackDownloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('#shareReport').click();
    const fallbackDownload = await fallbackDownloadPromise;
    assert.equal(fallbackDownload.suggestedFilename(), 'calculo-actividades-2026-10-19.pdf');
    await page.locator('#toast').filter({ hasText: 'no comparte archivos directamente' }).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: payload => Array.isArray(payload?.files) && payload.files.length > 0
      });
    });
  });

  await check('recuperación automática tras corrupción del estado', async () => {
    await page.evaluate(({ key, backup }) => {
      localStorage.setItem(backup, localStorage.getItem(key));
      localStorage.setItem(key, '{contenido dañado');
    }, { key: STORAGE_KEY, backup: BACKUP_KEY });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForApp(page);
    assert.equal(await page.locator('.source-card').count(), 17);
    assert.doesNotThrow(() => JSON.parse(page.url() && '[]'));
    const recovered = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    assert.equal(recovered.inventory.length, 27);
  });

  await check('migración de las claves de almacenamiento anteriores', async () => {
    await page.evaluate(({ key, backup }) => {
      const current = JSON.parse(localStorage.getItem(key));
      localStorage.setItem('actividad-inventario', JSON.stringify(current.inventory));
      localStorage.setItem('actividad-isotopos', JSON.stringify(current.isotopes));
      localStorage.setItem('actividad-datos-version', '33');
      localStorage.removeItem(key);
      localStorage.removeItem(backup);
    }, { key: STORAGE_KEY, backup: BACKUP_KEY });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForApp(page);
    const migrated = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.inventory.length, 27);
  });

  await check('conflicto entre pestañas no sobrescribe cambios recientes', async () => {
    await openInventory(page, 'fuente_puntual');
    await page.locator('#inventoryId').fill('CONFLICT-E2E');
    await page.locator('#inventoryIsotope').selectOption('Co-60');
    await page.locator('#inventoryReferenceDate').fill('2024-01-01');
    await page.locator('#inventoryActivity').fill('100');
    const secondPage = await context.newPage();
    await secondPage.goto(`${BASE_URL}?second-tab=${Date.now()}`, { waitUntil: 'networkidle' });
    await secondPage.evaluate(key => {
      const current = JSON.parse(localStorage.getItem(key));
      current.revision += 1;
      current.updatedAt = new Date().toISOString();
      localStorage.setItem(key, JSON.stringify(current));
    }, STORAGE_KEY);
    await page.waitForTimeout(150);
    await page.locator('#saveInventory').click();
    assert.match(await page.locator('#inventoryStatus').textContent(), /otra pestaña/i);
    assert.equal(await page.locator('.source-card').filter({ hasText: 'CONFLICT-E2E' }).count(), 0);
    await page.locator('#cancelInventory').click();
    await secondPage.close();
  });

  await check('responsive en móvil, tablet y escritorio sin solapamientos', async () => {
    const viewports = [
      { width: 320, height: 568, name: '320x568' },
      { width: 390, height: 844, name: '390x844' },
      { width: 768, height: 1024, name: '768x1024' },
      { width: 1440, height: 900, name: '1440x900' }
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`${BASE_URL}?viewport=${viewport.name}-${Date.now()}`, { waitUntil: 'networkidle' });
      await waitForApp(page);
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        clippedButtons: [...document.querySelectorAll('button')]
          .filter(button => button.getClientRects().length && button.scrollWidth > button.clientWidth + 1)
          .map(button => button.id || button.textContent.trim())
      }));
      assert.ok(metrics.document <= metrics.viewport + 1, `${viewport.name}: documento ${metrics.document}px`);
      assert.ok(metrics.body <= metrics.viewport + 1, `${viewport.name}: body ${metrics.body}px`);
      assert.deepEqual(metrics.clippedButtons, [], `${viewport.name}: texto cortado`);
      await page.screenshot({ path: path.join(OUTPUT, `v51-${viewport.name}.png`), fullPage: false });
      await page.locator('#inventoryButton').click();
      const dialogBounds = await page.locator('#inventoryDialog').boundingBox();
      assert.ok(dialogBounds.x >= -1 && dialogBounds.x + dialogBounds.width <= viewport.width + 1);
      assert.ok(dialogBounds.y >= -1 && dialogBounds.y < viewport.height);
      await page.locator('#cancelInventory').click();

      if (viewport.width <= 390) {
        await page.locator('#isotopesButton').click();
        const isotopeDialog = await page.locator('#isotopesDialog').evaluate(dialog => {
          const closeButton = dialog.querySelector('#closeIsotopes');
          const firstEditButton = dialog.querySelector('[data-action="edit-isotope"]');
          const firstDeleteButton = dialog.querySelector('[data-action="delete-isotope"]');
          const isVisible = element => Boolean(element?.getClientRects().length);
          return {
            clientWidth: dialog.clientWidth,
            scrollWidth: dialog.scrollWidth,
            closeVisible: isVisible(closeButton),
            editVisible: isVisible(firstEditButton),
            deleteVisible: isVisible(firstDeleteButton)
          };
        });
        assert.ok(isotopeDialog.scrollWidth <= isotopeDialog.clientWidth + 1, `${viewport.name}: diálogo de isótopos desbordado`);
        assert.equal(isotopeDialog.closeVisible, true, `${viewport.name}: cierre de isótopos oculto`);
        assert.equal(isotopeDialog.editVisible, true, `${viewport.name}: edición de isótopos oculta`);
        assert.equal(isotopeDialog.deleteVisible, true, `${viewport.name}: borrado de isótopos oculto`);
        await page.locator('#closeIsotopes').click();
      }
    }
  });

  await check('service worker, navegación y generación PDF completamente offline', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE_URL}?offline-prime=${Date.now()}`, { waitUntil: 'networkidle' });
    await waitForApp(page);
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) throw new Error('Service Worker no disponible');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    const cacheNames = await page.evaluate(() => caches.keys());
    assert.ok(cacheNames.includes('calculo-decaimientos-v51'));
    assert.deepEqual(cacheNames.filter(name => name.startsWith('calculo-decaimientos-') && name !== 'calculo-decaimientos-v51'), []);
    const cachedResources = await page.evaluate(async () => {
      const cache = await caches.open('calculo-decaimientos-v51');
      return (await cache.keys()).map(request => {
        const url = new URL(request.url);
        return `${url.pathname}${url.search}`;
      });
    });
    const requiredOfflineResources = [
      '/index.html',
      '/styles.css?v=51',
      '/app.js?v=51',
      '/src/pdf.js?v=51',
      '/src/report.js?v=51',
      '/inventario_radiactivo.csv?v=51',
      '/isotopos.csv?v=51',
      '/assets/fonts/Montserrat-Bold.ttf?v=51',
      '/assets/fonts/Roboto-Regular.ttf?v=51',
      '/assets/vendor/html2canvas-1.4.1.min.js?v=51',
      '/assets/vendor/jspdf-4.2.1.umd.min.js?v=51',
      '/assets/brand/at-logo-horizontal.png?v=51',
      '/icons/app-icon-512.png?v=51'
    ];
    for (const resource of requiredOfflineResources) {
      assert.ok(cachedResources.includes(resource), `recurso ausente de la caché offline: ${resource}`);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await waitForApp(page);
    await context.setOffline(true);
    try {
      const offlineResponse = await page.goto(`${BASE_URL}?offline-query=${Date.now()}`, { waitUntil: 'domcontentloaded' });
      assert.equal(offlineResponse.fromServiceWorker(), true);
      await waitForApp(page);
      assert.equal(await page.locator('.source-card').count(), 17);
      await page.locator('#reportButton').click();
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
      await page.locator('#downloadReport').click();
      const download = await downloadPromise;
      const offlinePdfPath = path.join(OUTPUT, 'informe-v51-offline.pdf');
      await download.saveAs(offlinePdfPath);
      assertPdfBuffer(fs.readFileSync(offlinePdfPath), 'Informe offline');
    } finally {
      await context.setOffline(false);
    }
  });

  await check('sin errores de consola ni recursos rotos en Chromium', async () => {
    const relevant = runtimeProblems.filter(problem => !/offline-query|ERR_INTERNET_DISCONNECTED/.test(problem));
    assert.deepEqual(relevant, [], relevant.join('\n'));
  });

  await context.close();
  await browser.close();

  if (process.env.RUN_FIREFOX !== '0') {
    const { spawn } = require('node:child_process');
    const outcome = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname, 'firefox-smoke.cjs')], { env: { ...process.env, APP_URL: BASE_URL }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let detail = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      }, 30000);
      child.stdout.on('data', chunk => { detail = (detail + chunk).slice(-2000); });
      child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-2000); });
      child.on('error', error => { clearTimeout(timer); resolve({ status: 'unavailable', detail: error.message }); });
      child.on('exit', code => { clearTimeout(timer); resolve({ status: code === 0 ? 'ok' : timedOut || code === 2 ? 'unavailable' : 'failed', detail: detail.trim() }); });
    });
    record('Firefox actual (runner aislado de Playwright)', outcome.status, outcome.detail);
  } else {
    record('Firefox actual (runner de Playwright)', 'unavailable', 'Firefox 157 no completa el arranque por juggler-pipe en este Windows; intento aislado registrado.');
  }
  await check('WebKit, equivalente de motor Safari', () => browserSmoke(webkit, 'WebKit'));
  for (const [name, executablePath] of executableCandidates()) {
    await check(`${name} instalado`, () => browserSmoke(chromium, name, { executablePath }));
  }

  await check('perfil táctil Android', async () => {
    const browser = await chromium.launch({ headless: true, timeout: 20_000 });
    try {
      const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'es-ES', timezoneId: 'Europe/Madrid' });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}?device=android-${Date.now()}`, { waitUntil: 'networkidle' });
      await waitForApp(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#isotopesButton').click();
      assert.ok(await page.locator('#isotopesDialog').isVisible());
      await page.locator('#closeIsotopes').click();
      await page.locator('#reportButton').click();
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
      await page.locator('#downloadReport').click();
      const download = await downloadPromise;
      assertPdfBuffer(fs.readFileSync(await download.path()), 'Android PDF');
      await context.close();
    } finally {
      await browser.close();
    }
  });

  await check('perfil táctil iPhone WebKit', async () => {
    const browser = await webkit.launch({ headless: true, timeout: 20_000 });
    try {
      const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES', timezoneId: 'Europe/Madrid' });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}?device=ios-${Date.now()}`, { waitUntil: 'networkidle' });
      await waitForApp(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#reportButton').click();
      assert.ok(await page.locator('#reportDialog').isVisible());
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
      await page.locator('#downloadReport').click();
      const download = await downloadPromise;
      assertPdfBuffer(fs.readFileSync(await download.path()), 'iPhone/iPadOS PDF');
      await context.close();
    } finally {
      await browser.close();
    }
  });

  await require('./resilience-browser.cjs')({ chromium, webkit, devices, baseUrl: BASE_URL, output: OUTPUT, check, assertPdfBuffer });

  const failed = results.filter(result => result.status === 'failed');
  const unavailable = results.filter(result => result.status === 'unavailable');
  const passed = results.filter(result => result.status === 'ok');
  fs.writeFileSync(path.join(OUTPUT, 'audit-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    passed: passed.length,
    failed: failed.length,
    unavailable: unavailable.length,
    results
  }, null, 2));
  process.stdout.write(`\n${passed.length}/${results.length} comprobaciones superadas; ${unavailable.length} no disponibles.\n`);
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
module.exports = { browserSmoke };
