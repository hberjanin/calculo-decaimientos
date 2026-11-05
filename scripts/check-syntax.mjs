import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['app.js', 'sw.js', 'precache-manifest.js'];
for (const folder of ['src', 'scripts', 'tests']) {
  files.push(...(await readdir(folder)).filter(name => /\.(?:js|mjs|cjs)$/.test(name)).map(name => `${folder}/${name}`));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr}`);
}
console.log(`Sintaxis válida: ${files.length} archivos JavaScript.`);
