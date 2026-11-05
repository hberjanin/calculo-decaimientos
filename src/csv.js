import { LIMITS } from './config.js?v=51';

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('El fichero CSV está vacío.');
  if (new Blob([text]).size > LIMITS.csvBytes) throw new Error('El fichero CSV supera el tamaño permitido.');

  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const separator = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (closedQuote && character !== separator && character !== '\r' && character !== '\n' && !/\s/.test(character)) throw new Error('El fichero CSV contiene texto después de una comilla de cierre.');
    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      if (!quoted && (field.trim() || closedQuote)) throw new Error('El fichero CSV contiene una comilla en un campo sin entrecomillar.');
      if (quoted) closedQuote = true;
      quoted = !quoted;
    } else if (character === separator && !quoted) {
      row.push(field.trim());
      field = '';
      closedQuote = false;
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
      closedQuote = false;
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('El fichero CSV contiene una comilla sin cerrar.');
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error('El fichero CSV no contiene registros.');

  const headers = rows[0].map(header => header.replace(/^\ufeff/, '').trim());
  if (headers.some(header => !header)) throw new Error('El fichero CSV contiene una cabecera vacía.');
  if (new Set(headers).size !== headers.length) throw new Error('El fichero CSV contiene cabeceras duplicadas.');

  const dataRows = rows.slice(1);
  const malformedRow = dataRows.findIndex(values => values.length !== headers.length);
  if (malformedRow >= 0) {
    throw new Error(`La fila ${malformedRow + 2} no tiene ${headers.length} columnas.`);
  }
  return dataRows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
}

export async function fetchCsv(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 15_000) : null;
  try {
    const response = await fetch(url, { cache: 'no-cache', signal: controller?.signal });
    if (!response.ok) throw new Error(`No se pudo cargar ${url} (${response.status}).`);
    return parseCsv(await response.text());
  } finally { clearTimeout(timer); }
}
