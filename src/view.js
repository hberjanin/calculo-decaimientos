import { daysBetween, todayIso, filterGroups, groupInventory, groupTitle, groupTypeLabel, toFiniteNumber } from './domain.js?v=51';
import { formatNumber, halfLifeUnitLabel } from './format.js?v=51';
import { recordPresentation } from './measurements.js?v=51';

export function element(tagName, options = {}, children = []) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.value != null) node.value = options.value;
  if (options.attributes) for (const [name, value] of Object.entries(options.attributes)) node.setAttribute(name, value);
  if (options.dataset) for (const [name, value] of Object.entries(options.dataset)) node.dataset[name] = value;
  for (const child of Array.isArray(children) ? children : [children]) if (child != null) node.append(child);
  return node;
}

function requiredElement(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Falta el elemento de interfaz #${id}.`);
  return node;
}

function appendDetail(container, text) {
  if (text) container.append(element('small', { text }));
}

function measurementLine(value, uncertainty = '', className = '') {
  const valueClass = ['measurement-value', className].filter(Boolean).join(' ');
  const children = [element('strong', { className: valueClass, text: value })];
  if (uncertainty) children.push(element('span', { className: 'measurement-uncertainty', text: `± ${uncertainty}` }));
  return element('div', { className: 'measurement-line' }, children);
}

function valueBlock(label, measurements, details = []) {
  const lines = Array.isArray(measurements) ? measurements : [measurements];
  const block = element('div', { className: 'value-block' }, [element('span', { text: label }), ...lines]);
  details.filter(Boolean).forEach(detail => appendDetail(block, detail));
  return block;
}

function recordRow(record, isotope, calculationDate) {
  const presentation = recordPresentation(record, isotope, calculationDate);
  const heading = element('div', { className: 'nuclide-name' }, [
    element('strong', { text: record.radionuclido }),
    element('small', { text: presentation.halfLife }),
    element('button', {
      className: 'inline-action', type: 'button', text: 'Editar registro',
      dataset: { action: 'edit-record', recordId: record.record_id },
      attributes: { 'aria-label': `Editar ${record.radionuclido} de ${record.identificacion}` }
    })
  ]);
  const block = metric => valueBlock(metric.label,
    metric.measurements.map(item => measurementLine(item.value, item.uncertainty,
      item.isLimit ? 'limit-value' : !presentation.result.available && metric === presentation.current ? 'unavailable-value' : '')),
    metric.details);
  return element('div', { className: 'nuclide-row' }, [heading, block(presentation.current), block(presentation.reference)]);
}

function sourceCard(group, isotopeMap, calculationDate) {
  const heading = element('div', { className: 'card-heading' }, [
    element('h3', { text: groupTitle(group) }),
    element('span', { className: 'type-badge', text: groupTypeLabel(group) })
  ]);
  const remove = element('button', {
    className: 'small-button danger card-remove', type: 'button', text: 'Quitar',
    dataset: { action: 'delete-group', groupKey: group.key },
    attributes: { 'aria-label': `Quitar ${groupTitle(group)}` }
  });
  const header = element('header', {}, [heading, remove]);
  const rows = group.records.map(record => recordRow(record, isotopeMap.get(record.radionuclido), calculationDate));
  const mass = toFiniteNumber(group.records[0]?.masa_g);
  const metadata = element('div', { className: 'metadata' }, [
    element('div', {}, [element('span', { text: 'Identificador' }), element('strong', { text: group.id })]),
    element('div', {}, [element('span', { text: 'Masa' }), element('strong', { text: mass == null ? 'No aplica' : `${formatNumber(mass, 2)} g` })]),
    element('div', {}, [element('span', { text: 'Contenido' }), element('strong', { text: group.records.length === 1 ? '1 isótopo' : `${group.records.length} isótopos` })])
  ]);
  return element('article', { className: `source-card ${group.category}` }, [header, ...rows, metadata]);
}

export function createView() {
  const nodes = {
    calculationDate: requiredElement('calculationDate'), dateSummary: requiredElement('dateSummary'), searchInput: requiredElement('searchInput'),
    summary: requiredElement('summary'), sourceList: requiredElement('sourceList'), emptyState: requiredElement('emptyState'), emptyTitle: requiredElement('emptyTitle'), emptyMessage: requiredElement('emptyMessage'),
    listTitle: requiredElement('listTitle'), resultCount: requiredElement('resultCount'), countAll: requiredElement('countAll'), countPoint: requiredElement('countPoint'), countMaterial: requiredElement('countMaterial'),
    inventoryDialog: requiredElement('inventoryDialog'), inventoryForm: requiredElement('inventoryForm'), inventoryStatus: requiredElement('inventoryStatus'),
    isotopesDialog: requiredElement('isotopesDialog'), isotopeTable: requiredElement('isotopeTable'), isotopeEditor: requiredElement('isotopeEditor'), isotopeStatus: requiredElement('isotopeStatus'),
    reportDialog: requiredElement('reportDialog'), reportStatus: requiredElement('reportStatus'), printReportView: requiredElement('printReportView'),
    toast: requiredElement('toast'), updateBanner: requiredElement('updateBanner')
  };
  const previousFocus = new WeakMap();
  let toastTimer;

  function renderDashboard(model, calculationDate, filter, query) {
    const groups = groupInventory(model.inventory);
    const visible = filterGroups(groups, filter, query);
    const isotopeMap = new Map(model.isotopes.map(isotope => [isotope.isotopo, isotope]));
    const pointCount = groups.filter(group => group.category === 'point').length;
    const materialCount = groups.filter(group => group.category === 'material').length;
    nodes.countAll.textContent = String(groups.length);
    nodes.countPoint.textContent = String(pointCount);
    nodes.countMaterial.textContent = String(materialCount);
    nodes.listTitle.textContent = filter === 'point' ? 'Fuentes puntuales' : filter === 'material' ? 'Material contaminado' : 'Todos los elementos';
    nodes.resultCount.textContent = visible.length === 1 ? '1 elemento visible' : `${visible.length} elementos visibles`;

    nodes.summary.replaceChildren(
      element('div', { className: 'summary-item' }, [element('span', { text: 'Fuentes puntuales' }), element('strong', { text: pointCount })]),
      element('div', { className: 'summary-item' }, [element('span', { text: 'Materiales' }), element('strong', { text: materialCount })])
    );
    nodes.sourceList.replaceChildren(...visible.map(group => sourceCard(group, isotopeMap, calculationDate)));
    nodes.emptyState.classList.toggle('hidden', visible.length > 0);
    if (!visible.length) {
      const emptyInventory = groups.length === 0;
      nodes.emptyTitle.textContent = emptyInventory ? 'Aún no hay registros' : query ? 'Sin coincidencias' : 'No hay elementos de este tipo';
      nodes.emptyMessage.textContent = emptyInventory ? 'Añade una fuente o material contaminado para comenzar.' : query ? 'Revisa el isótopo o identificador buscado.' : 'Selecciona otro filtro o añade un registro.';
    }

    const difference = daysBetween(todayIso(), calculationDate);
    nodes.dateSummary.textContent = difference == null ? 'Selecciona una fecha válida' : difference === 0 ? 'Actividad calculada para hoy' : difference > 0 ? `${difference} días después de hoy` : `${Math.abs(difference)} días antes de hoy`;
    return { groups, visible };
  }

  function renderIsotopes(isotopes) {
    const table = element('table', { className: 'isotope-table', attributes: { role: 'table', 'aria-label': 'Semividas de los isótopos' } });
    table.append(element('thead', {}, [element('tr', {}, ['Isótopo', 'Semivida', 'Unidad', 'Fuente', 'Acciones'].map(text => element('th', { text, attributes: { scope: 'col' } }))) ]));
    const body = element('tbody');
    [...isotopes].sort((a, b) => a.isotopo.localeCompare(b.isotopo, 'es')).forEach(isotope => {
      const actions = element('div', { className: 'isotope-actions' }, [
        element('button', { className: 'small-button', type: 'button', text: 'Editar', dataset: { action: 'edit-isotope', isotope: isotope.isotopo }, attributes: { 'aria-label': `Editar ${isotope.isotopo}` } }),
        element('button', { className: 'small-button danger', type: 'button', text: 'Quitar', dataset: { action: 'delete-isotope', isotope: isotope.isotopo }, attributes: { 'aria-label': `Quitar ${isotope.isotopo}` } })
      ]);
      body.append(element('tr', {}, [
        element('th', { text: isotope.isotopo, attributes: { scope: 'row' } }),
        element('td', { text: formatNumber(Number(isotope.semivida_valor), Number(isotope.semivida_valor) > 10_000 ? 0 : 4) }),
        element('td', { text: halfLifeUnitLabel(isotope.semivida_unidad) }),
        element('td', { text: isotope.fuente || '—' }),
        element('td', {}, [actions])
      ]));
    });
    table.append(body);
    nodes.isotopeTable.replaceChildren(table);
  }

  function openDialog(dialog, focusTarget) {
    if (dialog.open) {
      requestAnimationFrame(() => focusTarget?.focus());
      return;
    }
    previousFocus.set(dialog, document.activeElement);
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('role', 'dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.setAttribute('open', ''); dialog.classList.add('dialog-fallback'); document.body.classList.add('modal-open'); }
    requestAnimationFrame(() => focusTarget?.focus());
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open');
    dialog.classList.remove('dialog-fallback');
    dialog.removeAttribute('aria-modal');
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open');
    const target = previousFocus.get(dialog);
    requestAnimationFrame(() => (target?.isConnected ? target : document.getElementById('inventoryButton'))?.focus());
  }

  document.addEventListener('keydown', event => {
    const dialog = document.querySelector('dialog.dialog-fallback[open]');
    if (!dialog) return;
    if (event.key === 'Escape') { event.preventDefault(); dialog.dispatchEvent(new Event('cancel', { cancelable: true })); }
    if (event.key !== 'Tab') return;
    const fields = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(field => !field.disabled && field.getClientRects().length);
    const next = event.shiftKey ? fields.at(-1) : fields[0];
    if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === fields[0] || !event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); next?.focus(); }
  });

  function toast(message, duration = 5_000) {
    clearTimeout(toastTimer);
    nodes.toast.textContent = message;
    nodes.toast.classList.remove('hidden');
    toastTimer = setTimeout(() => nodes.toast.classList.add('hidden'), duration);
  }

  function showStatus(node, message = '', error = false) {
    node.textContent = message;
    node.classList.toggle('hidden', !message);
    node.classList.toggle('error', error);
  }

  function clearFormErrors(form, status) {
    showStatus(status);
    form.querySelectorAll('[aria-invalid="true"]').forEach(field => { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); });
  }

  function showFormError(form, status, fieldId, message) {
    clearFormErrors(form, status);
    showStatus(status, message, true);
    const field = document.getElementById(fieldId);
    if (field) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', status.id); field.focus(); }
  }

  return { nodes, renderDashboard, renderIsotopes, openDialog, closeDialog, toast, showStatus, clearFormErrors, showFormError };
}

