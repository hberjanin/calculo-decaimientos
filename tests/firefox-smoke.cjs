process.env.PLAYWRIGHT_BROWSERS_PATH ||= '0';
const { firefox } = require('playwright');
const { browserSmoke } = require('./audit.cjs');
browserSmoke(firefox, 'Firefox', { env: { ...process.env, MOZ_DISABLE_SAFE_MODE_KEY: '1' } })
  .then(() => { process.stdout.write('Firefox: carga, búsqueda, filtros y PDF verificados.'); process.exit(0); })
  .catch(error => { process.stderr.write(String(error.message).slice(0, 1200)); process.exit(error.browserUnavailable ? 2 : 1); });
