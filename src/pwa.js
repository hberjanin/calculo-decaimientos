import { APP_VERSION } from './config.js?v=53';

const RUNTIME_CHECK_TIMEOUT_MS = 2_500;

function runtimeStatus(controller) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error('El service worker no respondió.'));
    }, RUNTIME_CHECK_TIMEOUT_MS);
    channel.port1.onmessage = event => {
      window.clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    };
    try {
      controller.postMessage({ type: 'GET_RUNTIME_STATUS', appVersion: APP_VERSION }, [channel.port2]);
    } catch (error) {
      window.clearTimeout(timer);
      channel.port1.close();
      reject(error);
    }
  });
}

// Un informe no debe mezclar el JavaScript de una pestaña antigua con los
// estilos o recursos de otra publicación. La primera carga, aún sin
// controlador, se valida después por su propio DOM antes de crear el PDF.
export async function assertRuntimeReady() {
  if (!navigator.serviceWorker || !window.isSecureContext || !navigator.serviceWorker.controller) return;
  let status;
  try {
    status = await runtimeStatus(navigator.serviceWorker.controller);
  } catch {
    throw new Error('No se pudo verificar la versión activa. Recarga la aplicación antes de generar el informe.');
  }
  if (status?.type !== 'RUNTIME_STATUS' || String(status.version) !== APP_VERSION) {
    throw new Error('La pestaña pertenece a otra versión. Pulsa «Actualizar» o recarga la aplicación antes de generar el informe.');
  }
  if (!status.complete) {
    throw new Error('Faltan recursos locales. Reconecta y pulsa «Reparar modo offline» antes de generar el informe.');
  }
}

export function setupInstallation({ button, toast }) {
  let prompt;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event; button.classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { prompt = null; button.classList.add('hidden'); toast('Aplicación instalada.'); });
  button.addEventListener('click', async () => {
    if (!prompt) return;
    try { await prompt.prompt(); await prompt.userChoice; }
    catch { toast('No se pudo iniciar la instalación. Prueba el menú de instalación del navegador.'); }
    finally { prompt = null; button.classList.add('hidden'); }
  });
}

function downloadUpdate(registration) {
  return new Promise((resolve, reject) => {
    let worker;
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      registration.removeEventListener('updatefound', watchInstallation);
      worker?.removeEventListener('statechange', inspect);
      if (error) reject(error); else resolve();
    };
    const inspect = () => {
      if (worker.state === 'installed' || worker.state === 'activated') finish();
      if (worker.state === 'redundant') finish(new Error('No se completó la descarga de la nueva versión.'));
    };
    const watchInstallation = () => {
      const next = registration.installing;
      if (!next || next === worker) return;
      worker?.removeEventListener('statechange', inspect);
      worker = next;
      worker.addEventListener('statechange', inspect);
      inspect();
    };
    const timer = setTimeout(() => finish(new Error('La búsqueda tardó demasiado.')), 30_000);
    registration.addEventListener('updatefound', watchInstallation);
    Promise.resolve().then(() => registration.update()).then(() => {
      if (finished) return;
      watchInstallation();
      if (!worker) finish(); else inspect();
    }, finish);
  });
}

export async function setupOffline({ status, banner, updateButton, isEditing, toast }) {
  const setStatus = message => { status.textContent = message; };
  const searchButton = document.getElementById('checkUpdates');
  const updateStatus = document.getElementById('updateStatus');
  const updateMessage = document.getElementById('updateMessage');
  const postponeButton = document.getElementById('postponeUpdate');
  const setUpdateStatus = message => {
    updateStatus.textContent = message;
    updateStatus.classList.toggle('hidden', !message);
  };
  if (!navigator.serviceWorker || !window.isSecureContext) {
    setStatus('Modo offline no disponible. Abre la aplicación por HTTPS o en localhost.');
    setUpdateStatus('Para buscar actualizaciones, abre la aplicación por HTTPS o en localhost.');
    return;
  }
  let registration;
  let accepted = false;
  let reloading = false;
  let checking = false;
  let applying = false;
  let postponedVersion = '';
  const checkStatus = () => navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_SHELL', appVersion: APP_VERSION });
  function reloadWhenReady() {
    // La activación puede terminar después de que se abra otro formulario.
    if (isEditing()) {
      accepted = false;
      setUpdateStatus('La versión nueva está preparada. Guarda o cierra el formulario o PDF y pulsa «Actualizar y reiniciar».');
      return false;
    }
    if (!reloading) { reloading = true; location.reload(); }
    return true;
  }
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'SHELL_STATUS') return;
    if (String(event.data.version) !== APP_VERSION) {
      setStatus('Hay una actualización pendiente. Actualiza o recarga antes de generar informes.');
      return;
    }
    setStatus(event.data.complete
      ? `Lista para usar sin conexión (v${APP_VERSION}).`
      : 'Faltan recursos offline. Reconecta y pulsa «Reparar modo offline». Tus datos se conservan.');
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (accepted && reloadWhenReady()) return;
    checkStatus();
    if (registration) void offerUpdate().catch(() => setUpdateStatus('No se pudo verificar la actualización. Pulsa «Buscar actualizaciones» para volver a intentarlo.'));
  });
  async function offerUpdate(manual = false) {
    const worker = registration.waiting || navigator.serviceWorker.controller;
    if (!worker || !registration.active) return false;
    const ready = await runtimeStatus(worker);
    if (String(ready?.version) === APP_VERSION) {
      banner.classList.add('hidden');
      // Una URL de registro antigua puede descargar la misma publicación actual.
      if (worker === registration.waiting && ready.complete) worker.postMessage({ type: 'SKIP_WAITING' });
      return false;
    }
    if (ready?.type !== 'RUNTIME_STATUS' || !ready.complete) {
      throw new Error('La nueva versión todavía no tiene todos sus recursos.');
    }
    if (worker !== registration.waiting && worker !== navigator.serviceWorker.controller) return false;
    if (manual) postponedVersion = '';
    updateMessage.textContent = `La versión ${ready.version} está descargada y preparada. ¿Quieres actualizar y reiniciar la aplicación?`;
    banner.dataset.version = String(ready.version);
    banner.classList.toggle('hidden', postponedVersion === String(ready.version));
    setUpdateStatus(`Versión ${ready.version} preparada. Puedes actualizar ahora o elegir «Más tarde».`);
    return true;
  }

  async function checkUpdates(manual = false) {
    if (checking || applying) return;
    checking = true;
    searchButton.disabled = true;
    searchButton.setAttribute('aria-busy', 'true');
    setUpdateStatus('Buscando nuevas versiones…');
    try {
      if (navigator.onLine === false) {
        if (!await offerUpdate(manual)) setUpdateStatus('Sin conexión. Conéctate y pulsa «Buscar actualizaciones» de nuevo.');
        return;
      }
      await downloadUpdate(registration);
      if (!await offerUpdate(manual)) setUpdateStatus(`Tienes la última versión publicada (v${APP_VERSION}).`);
    } catch {
      // Una versión ya descargada se puede aplicar aunque falle la red.
      const prepared = await offerUpdate(manual).catch(() => false);
      if (!prepared) setUpdateStatus('No se pudo completar la búsqueda o descarga. Comprueba la conexión con el servidor y pulsa «Buscar actualizaciones» para reintentarlo.');
    } finally {
      checking = false;
      searchButton.disabled = false;
      searchButton.removeAttribute('aria-busy');
    }
  }

  try {
    registration = await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' });
    updateButton.addEventListener('click', async () => {
      if (applying) return;
      if (isEditing()) { toast('Guarda o cierra el formulario o PDF antes de actualizar.'); return; }
      applying = true;
      updateButton.disabled = true;
      try {
        if (!await offerUpdate(true)) return;
        if (isEditing()) { toast('Guarda o cierra el formulario o PDF antes de actualizar.'); return; }
        accepted = true;
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        else reloadWhenReady();
      } catch { setUpdateStatus('No se pudo verificar la nueva versión. Pulsa «Buscar actualizaciones» para reintentarlo.'); }
      finally { applying = false; updateButton.disabled = false; }
    });
    postponeButton.addEventListener('click', () => {
      postponedVersion = banner.dataset.version;
      banner.classList.add('hidden');
      setUpdateStatus('Actualización pospuesta. Pulsa «Buscar actualizaciones» cuando quieras aplicarla.');
      searchButton.focus();
    });
    searchButton.addEventListener('click', () => { void checkUpdates(true); });
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      setUpdateStatus('Descargando y comprobando los recursos de la aplicación…');
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') {
          void offerUpdate().catch(() => setUpdateStatus('No se pudo verificar la descarga. Pulsa «Buscar actualizaciones» para reintentarlo.'));
          checkStatus();
        }
        if (worker.state === 'redundant') setUpdateStatus('No se completó la descarga. Comprueba la conexión y pulsa «Buscar actualizaciones» para reintentarlo.');
      });
    });
    if (navigator.serviceWorker.controller) checkStatus();
    else setStatus('Preparando los recursos para usar sin conexión…');
    const repair = document.getElementById('repairOffline');
    repair.addEventListener('click', async () => {
      repair.disabled = true;
      setStatus('Comprobando y reparando los recursos locales…');
      try {
        if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'REPAIR_SHELL' });
        // La actualización de código necesita red; la reparación de una caché
        // ya íntegra debe seguir confirmando disponibilidad offline.
        if (navigator.serviceWorker.controller) await downloadUpdate(registration).catch(() => {});
        else await downloadUpdate(registration);
        checkStatus();
      } catch { setStatus('No se pudo reparar. Comprueba la conexión con el servidor y vuelve a intentarlo.'); }
      finally { repair.disabled = false; }
    });
    window.addEventListener('online', checkStatus);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStatus(); });
    searchButton.disabled = false;
    void checkUpdates();
  } catch {
    setStatus('No se pudo activar el modo offline. Revisa los permisos del sitio y recarga con conexión.');
    setUpdateStatus('No se pudo activar la búsqueda de actualizaciones. Revisa los permisos del sitio y recarga con conexión.');
  }
}
