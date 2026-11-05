const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function main() {
  let server;
  let url = process.env.APP_URL;
  if (!url) {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    url = `http://127.0.0.1:${port}/`;
    server = spawn(process.env.PYTHON || 'python', ['dev_server.py', '--port', String(port), '--directory', root], { cwd: root, windowsHide: true, stdio: 'ignore' });
    let startupError;
    server.on('error', error => { startupError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (startupError) throw startupError;
      try { ready = (await fetch(url)).ok; } catch { /* El servidor todavía está arrancando. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) { server.kill(); throw new Error('El servidor de pruebas no arrancó.'); }
  }
  try {
    const child = spawn(process.execPath, ['tests/audit.cjs'], { cwd: root, env: { ...process.env, APP_URL: url }, windowsHide: true, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    process.exitCode = code ?? 1;
  } finally { server?.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
