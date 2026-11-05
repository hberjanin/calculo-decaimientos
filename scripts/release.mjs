import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(path.join(root, name), 'utf8');
const check = process.argv.includes('--check');
const current = (await read('src/config.js')).match(/APP_VERSION = '(\d+)'/)[1];
const version = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : current;
if (!/^\d+$/.test(version)) throw new Error('La versión debe ser un entero.');
const modules = (await readdir(path.join(root, 'src'))).filter(name => name.endsWith('.js')).map(name => `src/${name}`);
const runtimeText = ['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', ...modules];
if (!check) {
  for (const name of runtimeText) {
    let text = (await read(name)).replace(/\?v=\d+/g, `?v=${version}`);
    text = text.replace(/(APP_VERSION = |const VERSION = )'\d+'/g, `$1'${version}'`);
    await writeFile(path.join(root, name), text);
  }
  for (const name of ['package.json', 'package-lock.json']) {
    const data = JSON.parse(await read(name));
    data.version = `${version}.0.0`;
    if (data.packages?.['']) data.packages[''].version = data.version;
    await writeFile(path.join(root, name), `${JSON.stringify(data, null, 2)}\n`);
  }
}
const assets = [
  'index.html', `styles.css?v=${version}`, `app.js?v=${version}`,
  ...modules.map(name => `${name}?v=${version}`),
  ...['inventario_radiactivo.csv', 'isotopos.csv', 'manifest.webmanifest',
    'assets/brand/at-logo-horizontal.png', 'assets/brand/at-logo-stacked.png',
    'assets/fonts/Montserrat-SemiBold.ttf', 'assets/fonts/Montserrat-Bold.ttf', 'assets/fonts/Roboto-Regular.ttf', 'assets/fonts/Roboto-Medium.ttf',
    'assets/vendor/html2canvas-1.4.1.min.js', 'assets/vendor/jspdf-4.2.1.umd.min.js',
    'icons/app-icon.png', 'icons/app-icon-192.png', 'icons/app-icon-512.png', 'icons/app-icon-maskable-512.png', 'icons/apple-touch-icon.png'].map(name => `${name}?v=${version}`)
];
const resources = [];
for (const name of assets) resources.push({ url: `./${name}`, sha256: createHash('sha256').update(await readFile(path.join(root, name.split('?')[0]))).digest('hex') });
const manifest = `// Generado por scripts/release.mjs; publicar junto con todos los recursos.\nself.DECAIMIENTO_RELEASE = ${JSON.stringify({ version, resources }, null, 2)};\n`;
if (check) {
  if (manifest !== await read('precache-manifest.js')) throw new Error('Hay recursos modificados sin regenerar la publicación: ejecuta npm run release.');
} else await writeFile(path.join(root, 'precache-manifest.js'), manifest);
console.log(`Publicación v${version}: ${resources.length} recursos locales ${check ? 'verificados' : 'versionados con huellas SHA-256'}.`);
