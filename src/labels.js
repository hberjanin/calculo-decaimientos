import { toFiniteNumber } from './domain.js?v=53';
import { buildReport } from './report.js?v=53';

export function labelSelection(groups, quantity) {
  const copies = toFiniteNumber(quantity);
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
    throw new Error('Introduce una cantidad entera de 1 a 100 etiquetas por elemento.');
  }
  if (groups.length * copies > 1_000) {
    throw new Error('La selección supera 1000 etiquetas. Reduce la cantidad o filtra los elementos.');
  }
  // Repetimos referencias inmutables; nunca duplicamos registros del inventario.
  return groups.flatMap(group => Array.from({ length: copies }, () => group));
}

export function buildLabels(container, groups, isotopes, date, visibleOnly, quantity) {
  const labels = labelSelection(groups, quantity);
  const result = buildReport(container, labels, isotopes, date, visibleOnly);
  container.querySelectorAll('.report-title h1').forEach(title => { title.textContent = 'Etiquetas de actividades'; });
  const nuclides = new Set(groups.flatMap(group => group.records.map(record => record.radionuclido))).size;
  const summary = `${labels.length} etiquetas · ${groups.length} ${groups.length === 1 ? 'elemento' : 'elementos'} · ${nuclides} ${nuclides === 1 ? 'isótopo' : 'isótopos'} · ${visibleOnly ? 'Selección filtrada' : 'Inventario completo'}`;
  container.querySelectorAll('.report-title > span').forEach(node => { node.textContent = summary; });
  container.querySelectorAll('.report-section-heading > span').forEach(node => {
    node.textContent = node.textContent.replace(/\d+ (?:fuentes?|muestras?)/, `${node.closest('.report-page').querySelectorAll('.report-card').length} etiquetas`);
  });
  return result;
}
