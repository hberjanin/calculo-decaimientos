import { repairReportLayout } from './report-layout.js?v=53';

const PDF_MIME = 'application/pdf';
const PAGE_WIDTH_MM = 297;
const PAGE_HEIGHT_MM = 210;

async function dataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Falta un recurso del PDF. Repara el modo offline con conexión.');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo preparar un recurso local del PDF. Vuelve a intentarlo.'));
    reader.readAsDataURL(blob);
  });
}

async function captureStyles() {
  const sheets = [...document.styleSheets].filter(sheet => sheet.href && new URL(sheet.href).origin === location.origin);
  if (!sheets.length) throw new Error('No se cargaron los estilos locales. Recarga la aplicación.');
  const text = sheets.map(sheet => [...sheet.cssRules].map(rule => rule.cssText).join('\n')).join('\n');
  const urls = [...new Set([...text.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => match[1]))];
  let embedded = text;
  for (const url of urls) {
    if (url.startsWith('data:')) continue;
    const absolute = new URL(url, sheets[0].href);
    if (absolute.origin !== location.origin) throw new Error('El PDF necesita un recurso que no es local. Revisa la publicación.');
    embedded = embedded.split(url).join(await dataUrl(absolute.href));
  }
  return embedded;
}

function libraryFunctions() {
  const html2canvas = globalThis.html2canvas;
  const JsPdf = globalThis.jspdf?.jsPDF;
  if (typeof html2canvas !== 'function' || typeof JsPdf !== 'function') {
    throw new Error('No se pudieron cargar los componentes locales del generador PDF.');
  }
  return { html2canvas, JsPdf };
}

async function waitForImage(image) {
  if (typeof image.decode === 'function') {
    try {
      await image.decode();
      return;
    } catch {
      // El evento de carga proporciona un segundo intento compatible.
    }
  }
  if (image.complete) {
    if (!image.naturalWidth) throw new Error('No se pudo cargar el logotipo local. Reconecta y recarga para reparar los recursos.');
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El logotipo no responde. Reconecta y vuelve a intentarlo.')), 10_000);
    image.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    image.addEventListener('error', () => { clearTimeout(timer); reject(new Error('No se pudo cargar el logotipo local. Recarga para repararlo.')); }, { once: true });
  });
}

async function waitForReportAssets(container) {
  await Promise.all([...container.querySelectorAll('img')].map(waitForImage));
  if (document.fonts?.ready) await document.fonts.ready;
  if (document.fonts?.check && (!document.fonts.check('600 12px Montserrat') || !document.fonts.check('400 12px Roboto'))) {
    throw new Error('No se cargaron las tipografías locales. Repara el modo offline con conexión y vuelve a intentarlo.');
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function reportOverflowReason(page) {
  const tolerance = 2;
  if (page.clientWidth <= 0 || page.clientHeight <= 0) return 'no tiene dimensiones medibles';
  if (page.scrollHeight > page.clientHeight + tolerance || page.scrollWidth > page.clientWidth + tolerance) {
    return 'desborda los límites A4';
  }

  const reportColumns = page.querySelector('.report-columns');
  if (!reportColumns) return 'no contiene el área de tarjetas';
  const contentRect = reportColumns.getBoundingClientRect();
  const columns = [...page.querySelectorAll('.report-column')];
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    if (column.scrollHeight > reportColumns.clientHeight + tolerance || column.scrollWidth > column.clientWidth + tolerance) {
      return `desborda la columna ${columnIndex + 1}`;
    }
    const columnRect = column.getBoundingClientRect();
    let previousBottom = contentRect.top;
    for (const card of column.querySelectorAll('.report-card')) {
      const cardRect = card.getBoundingClientRect();
      const clipped = cardRect.top < contentRect.top - tolerance
        || cardRect.left < columnRect.left - tolerance
        || cardRect.right > columnRect.right + tolerance
        || cardRect.bottom > contentRect.bottom + tolerance;
      if (clipped) return `recorta una tarjeta en la columna ${columnIndex + 1}`;
      if (cardRect.top < previousBottom - tolerance) return `solapa tarjetas en la columna ${columnIndex + 1}`;
      previousBottom = cardRect.bottom;
    }
  }
  return '';
}

function assertReportFits(pages) {
  pages.forEach((page, index) => {
    const reason = reportOverflowReason(page);
    if (reason) {
      throw new Error(`La página ${index + 1} del informe ${reason}. Reduce la selección o revisa los datos.`);
    }
  });
}

function gridTrackCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function assertReportPresentation(page, styleFor = node => getComputedStyle(node)) {
  const columns = page.querySelector('.report-columns');
  const card = page.querySelector('.report-card');
  const logo = page.querySelector('.report-logo');
  const footer = page.querySelector('.report-footer');
  const title = page.querySelector('.report-title h1');
  if (!columns || !card || !logo || !footer || !title) {
    throw new Error('El HTML del informe está incompleto. Recarga la aplicación y vuelve a intentarlo.');
  }

  const pageBounds = page.getBoundingClientRect();
  const logoBounds = logo.getBoundingClientRect();
  const columnsStyle = styleFor(columns);
  const cardStyle = styleFor(card);
  const pageStyle = styleFor(page);
  const titleStyle = styleFor(title);
  const footerStyle = styleFor(footer);
  const styled = pageBounds.width >= 900
    && pageBounds.height >= 650
    && columnsStyle.display === 'grid'
    && gridTrackCount(columnsStyle.gridTemplateColumns) === 3
    && Number.parseFloat(cardStyle.borderTopWidth) >= 2
    && /Roboto/i.test(pageStyle.fontFamily)
    && /Montserrat/i.test(titleStyle.fontFamily)
    && footerStyle.display === 'flex'
    && logoBounds.width >= 180
    && logoBounds.height >= 20;
  if (!styled) {
    throw new Error('No se cargaron correctamente los estilos corporativos del informe. Recarga o repara el modo offline; no se descargó ningún PDF.');
  }
}

function assertCanvasPresentation(canvas, page) {
  if (canvas.width < page.clientWidth * 1.5 || canvas.height < page.clientHeight * 1.5) {
    throw new Error('La captura del informe tiene una resolución incorrecta. No se descargó ningún PDF.');
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('El navegador no permitió verificar la captura del informe.');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const stride = Math.max(1, Math.ceil(Math.sqrt((canvas.width * canvas.height) / 180_000)));
  let sampled = 0;
  let ink = 0;
  let accent = 0;
  for (let y = 0; y < canvas.height; y += stride) {
    for (let x = 0; x < canvas.width; x += stride) {
      const offset = (y * canvas.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      sampled += 1;
      if (red < 238 || green < 238 || blue < 238) ink += 1;
      if ((red > 180 && green >= 80 && green <= 205 && blue < 90)
        || (red < 35 && green >= 70 && green <= 165 && blue >= 65 && blue <= 180)) accent += 1;
    }
  }
  if (ink / sampled < 0.015 || accent < 20) {
    throw new Error('La captura perdió el diseño, el logotipo o los colores corporativos. No se descargó ningún PDF.');
  }
}

export function reportFilename(calculationDate, kind = 'report') {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(calculationDate) ? calculationDate : 'sin-fecha';
  return `${kind === 'labels' ? 'etiquetas-actividades' : 'calculo-actividades'}-${safeDate}.pdf`;
}

export async function createReportPdf(container, calculationDate, { kind = 'report' } = {}) {
  const { html2canvas, JsPdf } = libraryFunctions();
  if (document.fonts?.ready) await document.fonts.ready;
  repairReportLayout(container);
  const pages = [...container.querySelectorAll('.report-page')];
  if (!pages.length) throw new Error('El informe no contiene páginas para exportar.');
  // El iframe about:blank del capturador puede carecer de controlador SW.
  // Incrustar CSS, fuentes e imágenes evita sus recargas de red incluso offline.
  const css = await captureStyles();
  const imageUrls = [...new Set(pages.flatMap(page => [...page.querySelectorAll('img')].map(image => image.src)))];
  const images = new Map(await Promise.all(imageUrls.map(async url => [url, await dataUrl(url)])));

  container.setAttribute('aria-hidden', 'true');
  const captureStage = document.createElement('div');
  captureStage.className = 'pdf-capture-stage';
  captureStage.setAttribute('aria-hidden', 'true');
  document.body.append(captureStage);
  const existingFrames = new Set(document.querySelectorAll('.html2canvas-container'));
  try {
    const pdf = new JsPdf({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4',
      compress: true,
      putOnlyUsedFonts: true
    });
    pdf.setProperties({
      title: kind === 'labels' ? 'Etiquetas de actividades' : 'Cálculo de actividades',
      subject: `Fecha de cálculo: ${calculationDate}`,
      author: 'Aplicaciones Tecnológicas',
      creator: 'Cálculo de decaimientos'
    });

    // Dos píxeles por píxel CSS mantienen nítido el texto impreso sin agotar
    // la memoria de móviles y tabletas con pantallas de alta densidad.
    const scale = 2;
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index].cloneNode(true);
      const expectedCards = page.querySelectorAll('.report-card').length;
      page.querySelectorAll('img').forEach(image => { image.src = images.get(image.src); image.removeAttribute('srcset'); });
      captureStage.replaceChildren(page);
      await waitForReportAssets(captureStage);
      assertReportPresentation(page);
      assertReportFits([page]);
      const canvas = await html2canvas(page, {
        allowTaint: false,
        backgroundColor: '#ffffff',
        foreignObjectRendering: false,
        imageTimeout: 10_000,
        logging: false,
        ignoreElements: node => node.tagName === 'LINK' && node.rel === 'stylesheet'
          || node.parentElement === document.body && node !== captureStage,
        onclone: async (clonedDocument, clonedPage) => {
          const style = clonedDocument.createElement('style');
          style.textContent = css;
          clonedDocument.head.append(style);
          if (clonedDocument.fonts?.load) {
            await Promise.all(['600 12px Montserrat', '700 12px Montserrat', '400 12px Roboto', '500 12px Roboto'].map(font => clonedDocument.fonts.load(font)));
            await clonedDocument.fonts.ready;
          }
          await Promise.all([...clonedPage.querySelectorAll('img')].map(waitForImage));
          if (clonedPage.querySelectorAll('.report-card').length !== expectedCards || clonedPage.clientWidth !== page.clientWidth) {
            throw new Error('El capturador no conservó el diseño del informe. Recarga la aplicación y vuelve a intentarlo.');
          }
          assertReportPresentation(clonedPage, node => clonedDocument.defaultView.getComputedStyle(node));
        },
        removeContainer: true,
        scale,
        useCORS: false,
        width: page.clientWidth,
        height: page.clientHeight,
        windowWidth: page.clientWidth,
        windowHeight: page.clientHeight
      });
      assertCanvasPresentation(canvas, page);
      if (index > 0) pdf.addPage('a4', 'landscape');
      const image = canvas.toDataURL('image/png');
      pdf.addImage(image, 'PNG', 0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM, undefined, 'FAST');
      canvas.width = 1;
      canvas.height = 1;
    }

    const blob = pdf.output('blob');
    if (!(blob instanceof Blob) || blob.size < 1_000) throw new Error('El archivo PDF generado está vacío.');
    const filename = reportFilename(calculationDate, kind);
    let file = null;
    try {
      file = new File([blob], filename, { type: PDF_MIME, lastModified: Date.now() });
    } catch {
      // File no está disponible en algunos navegadores antiguos; la descarga con Blob sigue funcionando.
    }
    return { blob, file, filename };
  } finally {
    captureStage.remove();
    // html2canvas no siempre retira su iframe cuando onclone rechaza la captura.
    document.querySelectorAll('.html2canvas-container').forEach(frame => { if (!existingFrames.has(frame)) frame.remove(); });
  }
}

export function downloadPdf(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.className = 'generated-download';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

