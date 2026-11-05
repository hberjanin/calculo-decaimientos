import { APP_VERSION } from './config.js?v=51';

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

export async function setupOffline({ status, banner, updateButton, isEditing, toast }) {
  const setStatus = message => { status.textContent = message; };
  if (!navigator.serviceWorker || !window.isSecureContext) {
    setStatus('Modo offline no disponible. Abre la aplicación por HTTPS o en localhost.');
    return;
  }
  let accepted = false;
  let reloading = false;
  const checkStatus = () => navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_SHELL', appVersion: APP_VERSION });
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
    if (accepted && !reloading) { reloading = true; location.reload(); }
    else checkStatus();
  });
  async function showUpdate(registration) {
    if (!registration.waiting || !registration.active || !navigator.serviceWorker.controller) {
      banner.classList.add('hidden');
      return;
    }
    // A URL de registro antigua puede descargar exactamente la misma
    // publicacion (por ejemplo, sw.js?v=51 sirviendo ya el codigo v51).
    // Activa esa copia equivalente sin mostrar una falsa actualizacion.
    try {
      const waitingStatus = await runtimeStatus(registration.waiting);
      if (String(waitingStatus?.version) === APP_VERSION) {
        banner.classList.add('hidden');
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        return;
      }
    } catch {
      // Si no puede identificarse, se conserva el aviso: es la opcion segura.
    }
    banner.classList.remove('hidden');
    updateButton.onclick = () => {
      if (isEditing()) { toast('Guarda o cierra el formulario antes de actualizar.'); return; }
      if (!registration.waiting) { banner.classList.add('hidden'); return; }
      accepted = true;
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    };
  }
  try {
    const registration = await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' });
    await showUpdate(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') { void showUpdate(registration); checkStatus(); }
        if (worker.state === 'redundant') setStatus('No se completó la descarga offline. Reconecta y pulsa «Reparar modo offline».');
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
        await registration.update();
        checkStatus();
      } catch { setStatus('No se pudo reparar. Comprueba la conexión con el servidor y vuelve a intentarlo.'); }
      finally { repair.disabled = false; }
    });
    window.addEventListener('online', checkStatus);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStatus(); });
  } catch {
    setStatus('No se pudo activar el modo offline. Revisa los permisos del sitio y recarga con conexión.');
  }
}
