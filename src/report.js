import { DAYS_PER_YEAR } from './config.js?v=53';
import { groupTitle, toFiniteNumber } from './domain.js?v=53';
import {
  formatDate,
  formatDescriptor,
  formatNumber,
  toleranceBounds
} from './format.js?v=53';
import { recordPresentation } from './measurements.js?v=53';
import { element } from './view.js?v=53';

// La capacidad representa espacio vertical aproximado, no número de registros.
// El A4 horizontal dispone de tres columnas; los materiales, tolerancias y
// notas metrológicas consumen más unidades que una fuente sencilla.
const COLUMN_COUNT = 3;
const COLUMN_CAPACITY = 31;
const PAGE_CAPACITY = COLUMN_COUNT * COLUMN_CAPACITY;

function reportMeasurement(value, uncertainty = '', isLimit = false) {
  const children = [element('strong', {
    className: `report-value${isLimit ? ' report-limit' : ''}`,
    text: value
  })];
  if (uncertainty) children.push(element('span', { className: 'report-uncertainty', text: `± ${uncertainty}` }));
  return element('div', { className: 'report-measurement' }, children);
}

function reportMetric(label, measurements, details = [], current = false) {
  const content = Array.isArray(measurements) ? measurements : [measurements];
  const node = element('div', { className: `report-metric${current ? ' report-current' : ''}` }, [
    element('span', { className: 'report-metric-label', text: label }),
    ...content
  ]);
  details.filter(Boolean).forEach(text => node.append(element('small', { text })));
  return node;
}

function reportRecord(record, isotope, calculationDate) {
  const presentation = recordPresentation(record, isotope, calculationDate);
  const metric = (data, current) => reportMetric(data.label,
    data.measurements.map(item => reportMeasurement(item.value, item.uncertainty, item.isLimit)), data.details, current);
  return element('section', { className: 'report-nuclide' }, [
    element('div', { className: 'report-nuclide-heading' }, [
      element('strong', { text: record.radionuclido }),
      element('span', { text: presentation.halfLife })
    ]),
    element('div', { className: 'report-metrics' }, [
      metric(presentation.current, true),
      metric(presentation.reference, false)
    ])
  ]);
}

function reportCard(group, isotopeMap, calculationDate) {
  const mass = toFiniteNumber(group.records[0]?.masa_g);
  const meta = [];
  if (mass != null) meta.push(element('span', { className: 'report-chip report-chip-mass', text: `Masa · ${formatNumber(mass, 2)} g` }));
  meta.push(element('span', {
    className: `report-chip report-chip-${group.category}`,
    text: group.category === 'point' ? 'Fuente puntual' : 'Material contaminado'
  }));
  const header = element('header', { className: 'report-card-head' }, [
    element('h3', { text: groupTitle(group).length > 200 ? group.id : groupTitle(group) }),
    element('div', { className: 'report-card-meta' }, meta)
  ]);
  const records = group.records.map(record => reportRecord(record, isotopeMap.get(record.radionuclido), calculationDate));
  return element('article', {
    className: `report-card report-card-${group.category}`,
    dataset: { groupKey: group.key }
  }, [header, ...records]);
}

function recordUnits(record, category) {
  let units = category === 'material' ? 6 : 4;
  if (record.tipo_incertidumbre) units += 1;
  if (toleranceBounds(record)) units += 2;
  if (toleranceBounds(record, 1, true)) units += 2;
  return units;
}

function groupUnits(group) {
  const contentUnits = group.records.reduce(
    (sum, record) => sum + recordUnits(record, group.category),
    0
  );
  return Math.min(COLUMN_CAPACITY, 3 + contentUnits);
}

function splitIntoPages(entries) {
  const totalUnits = entries.reduce((sum, entry) => sum + entry.units, 0);
  const pageCount = Math.max(1, Math.ceil(totalUnits / PAGE_CAPACITY));
  if (pageCount === 1) return [entries];
  // Para inventarios extensos se evita una tabla cuadrática; la medición real
  // posterior corrige cualquier desbordamiento de esta primera distribución.
  if (entries.length > 100) {
    const pages = [[]];
    let used = 0;
    for (const entry of entries) {
      if (used && used + entry.units > PAGE_CAPACITY) { pages.push([]); used = 0; }
      pages.at(-1).push(entry);
      used += entry.units;
    }
    return pages;
  }

  const prefix = [0];
  entries.forEach(entry => prefix.push(prefix.at(-1) + entry.units));
  const target = totalUnits / pageCount;
  const scores = Array.from({ length: pageCount + 1 }, () => Array(entries.length + 1).fill(Infinity));
  const splits = Array.from({ length: pageCount + 1 }, () => []);
  scores[0][0] = 0;
  for (let count = 1; count <= pageCount; count += 1) {
    for (let end = count; end <= entries.length; end += 1) {
      for (let start = count - 1; start < end; start += 1) {
        const units = prefix[end] - prefix[start];
        const score = scores[count - 1][start] + Math.max(0, units - PAGE_CAPACITY) * 1_000_000 + (units - target) ** 2;
        if (score < scores[count][end]) { scores[count][end] = score; splits[count][end] = start; }
      }
    }
  }
  const pages = [];
  let end = entries.length;
  for (let count = pageCount; count > 0; count -= 1) {
    const start = splits[count][end];
    pages.unshift(entries.slice(start, end));
    end = start;
  }
  return pages;
}

function balanceColumns(entries) {
  const emptyColumn = () => ({ units: 0, entries: [] });
  if (entries.length <= COLUMN_COUNT) {
    const columns = entries.map(entry => ({ units: entry.units, entries: [entry] }));
    while (columns.length < COLUMN_COUNT) columns.push(emptyColumn());
    return columns;
  }

  let best = null;
  for (let firstSplit = 1; firstSplit < entries.length - 1; firstSplit += 1) {
    for (let secondSplit = firstSplit + 1; secondSplit < entries.length; secondSplit += 1) {
      const segments = [
        entries.slice(0, firstSplit),
        entries.slice(firstSplit, secondSplit),
        entries.slice(secondSplit)
      ];
      const units = segments.map(segment => segment.reduce((sum, entry) => sum + entry.units, 0));
      const overflow = units.reduce((sum, value) => sum + Math.max(0, value - COLUMN_CAPACITY), 0);
      const spread = Math.max(...units) - Math.min(...units);
      const score = (overflow * 1_000) + spread;
      if (!best || score <= best.score) best = { score, segments, units };
    }
  }

  return best.segments.map((segment, index) => ({ units: best.units[index], entries: segment }));
}

function packGroups(groups) {
  return ['point', 'material'].flatMap(category => {
    const entries = groups
      .map((group, index) => ({ group, index, units: groupUnits(group) }))
      .filter(entry => entry.group.category === category);
    if (!entries.length) return [];
    const categoryPages = splitIntoPages(entries);
    return categoryPages.map((pageEntries, pageIndex) => ({
      category,
      categoryPage: pageIndex + 1,
      categoryPageCount: categoryPages.length,
      columns: balanceColumns(pageEntries),
      groups: pageEntries.map(entry => entry.group)
    }));
  });
}

function reportHeader(calculationDate, counts, visibleOnly) {
  const details = [
    `${counts.total} elementos`,
    `${counts.isotopes} isótopos`,
    visibleOnly ? 'Selección filtrada' : 'Inventario completo'
  ].join(' · ');
  return element('header', { className: 'report-head' }, [
    element('div', { className: 'report-brand' }, [
      element('img', {
        className: 'report-logo',
        attributes: {
          src: 'assets/brand/at-logo-horizontal.png?v=53',
          alt: 'Aplicaciones Tecnológicas · Radiation Protection & Medical'
        }
      })
    ]),
    element('div', { className: 'report-title' }, [
      element('h1', { text: 'Cálculo de actividades' }),
      element('p', { text: `Fecha de cálculo · ${formatDate(calculationDate)}` }),
      element('span', { text: details })
    ])
  ]);
}

function reportFooter() {
  return element('footer', { className: 'report-footer' }, [
    element('p', {
      text: `A(t) = A₀ × 2^(-(t-t₀)/T½) · 1 año = ${String(DAYS_PER_YEAR).replace('.', ',')} días · “<” indica límite superior.`
    }),
    element('span', { className: 'report-page-number' })
  ]);
}

function pageSummary(groups, category, categoryPage, categoryPageCount) {
  const singular = category === 'point' ? 'fuente' : 'muestra';
  const plural = category === 'point' ? 'fuentes' : 'muestras';
  const itemLabel = groups.length === 1 ? singular : plural;
  return `En esta página: ${groups.length} ${itemLabel} · sección ${categoryPage} de ${categoryPageCount}`;
}

function reportPages(groups, isotopeMap, calculationDate, counts, visibleOnly) {
  const packs = packGroups(groups);
  return packs.map((packedPage, index) => {
    const columns = packedPage.columns.map(column => element('div', { className: 'report-column' },
      column.entries.map(entry => reportCard(entry.group, isotopeMap, calculationDate))
    ));
    const category = packedPage.category;
    const baseTitle = category === 'point' ? 'Fuentes puntuales' : 'Muestras contaminadas';
    const sectionTitle = packedPage.categoryPage > 1 ? `${baseTitle} · continuación` : baseTitle;
    return element('section', {
      className: `report-page report-page-${category}`,
      dataset: { category, reportPage: String(index + 1) }
    }, [
      reportHeader(calculationDate, counts, visibleOnly),
      element('div', { className: 'report-section-heading' }, [
        element('h2', { text: sectionTitle }),
        element('span', {
          text: pageSummary(
            packedPage.groups,
            category,
            packedPage.categoryPage,
            packedPage.categoryPageCount
          )
        })
      ]),
      element('div', { className: 'report-columns' }, columns),
      reportFooter()
    ]);
  });
}

export function buildReport(container, groups, isotopes, calculationDate, visibleOnly) {
  const isotopeMap = new Map(isotopes.map(isotope => [isotope.isotopo, isotope]));
  const counts = {
    total: groups.length,
    isotopes: new Set(groups.flatMap(group => group.records.map(record => record.radionuclido))).size
  };
  const pages = reportPages(groups, isotopeMap, calculationDate, counts, visibleOnly);
  pages.forEach((page, index) => {
    page.querySelector('.report-page-number').textContent = `Página ${index + 1} de ${pages.length}`;
  });
  const documentNode = element('article', {
    className: 'report-document',
    attributes: { 'aria-label': 'Informe de cálculo de actividades' }
  }, pages);
  container.replaceChildren(documentNode);
  return { pageCount: pages.length, cardCount: groups.length };
}

export function buildShareText(groups, isotopes, calculationDate) {
  const isotopeMap = new Map(isotopes.map(isotope => [isotope.isotopo, isotope]));
  const lines = groups.flatMap(group => group.records.map(record => {
    const presentation = recordPresentation(record, isotopeMap.get(record.radionuclido), calculationDate);
    const result = presentation.result;
    if (!result.available) return `${groupTitle(group)}: no calculable (${result.reason})`;
    let text = `${record.identificacion} · ${record.radionuclido}: ` + presentation.current.measurements
      .map(item => `${item.value}${item.uncertainty ? ` ± ${item.uncertainty}` : ''}`).join(' · ');
    const descriptor = formatDescriptor(record.tipo_incertidumbre);
    if (descriptor) text += ` · ${descriptor}`;
    if (presentation.current.details.length) text += ` · ${presentation.current.details.join(' · ')}`;
    return text;
  }));
  return `APLICACIONES TECNOLÓGICAS · RADIATION PROTECTION & MEDICAL\n\nCálculo de actividades\nFecha de cálculo: ${formatDate(calculationDate)}\n\n${lines.join('\n')}\n\nDocumento generado localmente con Cálculo de decaimientos.`;
}
