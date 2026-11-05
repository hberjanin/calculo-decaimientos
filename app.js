import { APP_VERSION, SCHEMA_VERSION } from './src/config.js?v=51';
import { fetchCsv } from './src/csv.js?v=51';
import {
  normalizeModel,
  parseDateOnly,
  todayIso,
  typeCategory,
  validateInventoryDraft,
  validateIsotopeDraft
} from './src/domain.js?v=51';
import { downloadPdf, createReportPdf } from './src/pdf.js?v=51';
import { buildReport, buildShareText } from './src/report.js?v=51';
import { createRepository } from './src/repository.js?v=51';
import { createView } from './src/view.js?v=51';
import { formatDescriptor } from './src/format.js?v=51';
import { assertRuntimeReady, setupInstallation, setupOffline } from './src/pwa.js?v=51';
import { repairReportLayout } from './src/report-layout.js?v=51';

const repository = createRepository();
const view = createView();

const state = {
  model: { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: '', inventory: [], isotopes: [] },
  calculationDate: todayIso(),
  filter: 'all',
  query: '',
  groups: [],
  visibleGroups: [],
  editingRecordId: null,
  editingIsotopeName: '',
  formModel: null,
  saving: false,
  loaded: false,
  reportFile: null,
  reportKey: '',
  reportBusy: false
};

const byId = id => document.getElementById(id);

function render() {
  const result = view.renderDashboard(
    state.model,
    state.calculationDate,
    state.filter,
    state.query
  );
  state.groups = result.groups;
  state.visibleGroups = result.visible;
  view.renderIsotopes(state.model.isotopes);
}

async function saveModel(nextModel, successMessage) {
  if (state.saving) return false;
  state.saving = true;
  const expectedModel = state.model;
  const expectedRevision = state.model.revision;
  const result = await repository.withWriteLock(() => state.model === expectedModel
    ? repository.save(nextModel, expectedRevision)
    : { ok: false, conflict: true, reason: 'Los datos cambiaron en otra pestaña. Reabre el formulario antes de guardar.' });
  state.saving = false;
  if (!result.ok) {
    const message = result.reason || 'No se pudieron guardar los cambios.';
    if (view.nodes.inventoryDialog.open) view.showFormError(view.nodes.inventoryForm, view.nodes.inventoryStatus, '', message);
    else if (view.nodes.isotopesDialog.open) view.showStatus(view.nodes.isotopeStatus, message, true);
    else view.showStatus(byId('storageStatus'), message, true);
    view.toast(message);
    return false;
  }
  state.model = result.model;
  render();
  if (successMessage) view.toast(successMessage);
  return true;
}

function setMaterialFields(isMaterial) {
  document.querySelectorAll('.material-field').forEach(label => {
    label.classList.toggle('hidden', !isMaterial);
    const field = label.querySelector('input, select, textarea');
    if (field) field.disabled = !isMaterial;
  });
}

function fillIsotopeSelect(selectedName = '') {
  const select = byId('inventoryIsotope');
  const names = [...state.model.isotopes]
    .map(isotope => isotope.isotopo)
    .sort((first, second) => first.localeCompare(second, 'es'));
  select.replaceChildren(...names.map(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    return option;
  }));
  if (selectedName && names.includes(selectedName)) select.value = selectedName;
}

function openInventory(recordId = null) {
  const record = recordId
    ? state.model.inventory.find(item => item.record_id === recordId)
    : null;
  state.editingRecordId = record?.record_id || null;
  state.formModel = state.model;
  const form = view.nodes.inventoryForm;
  form.reset();
  view.clearFormErrors(form, view.nodes.inventoryStatus);
  fillIsotopeSelect(record?.radionuclido || '');

  const isMaterial = record ? typeCategory(record) === 'material' : false;
  byId('inventoryType').value = isMaterial ? 'material_contaminado' : 'fuente_puntual';
  byId('inventoryId').value = record?.identificacion || '';
  if (record?.radionuclido) byId('inventoryIsotope').value = record.radionuclido;
  byId('inventoryReferenceDate').value = record?.fecha_referencia || '';
  byId('inventoryActivity').value = record?.actividad_referencia_bq || '';
  byId('inventoryOperator').value = record?.operador_actividad || '=';
  byId('inventoryMass').value = record?.masa_g || '';
  byId('inventorySpecificActivity').value = record?.actividad_especifica_bq_g || '';
  byId('inventoryUncertainty').value = record?.incertidumbre_actividad_bq || '';
  byId('inventorySpecificUncertainty').value = record?.incertidumbre_especifica_bq_g || '';
  byId('inventoryUncertaintyType').value = formatDescriptor(record?.tipo_incertidumbre);
  byId('inventoryNotes').value = record?.observaciones || '';
  byId('inventoryDialogTitle').textContent = record ? 'Editar registro' : 'Añadir fuente o material';
  byId('saveInventory').textContent = record ? 'Guardar cambios' : 'Añadir';
  setMaterialFields(isMaterial);
  view.openDialog(view.nodes.inventoryDialog, byId('inventoryType'));
}

function closeInventory() {
  view.closeDialog(view.nodes.inventoryDialog);
  state.editingRecordId = null;
}

function inventoryDraft() {
  return {
    tipo: byId('inventoryType').value,
    identificacion: byId('inventoryId').value,
    radionuclido: byId('inventoryIsotope').value,
    fecha_referencia: byId('inventoryReferenceDate').value,
    actividad_referencia_bq: byId('inventoryActivity').value,
    operador_actividad: byId('inventoryOperator').value,
    masa_g: byId('inventoryMass').value,
    actividad_especifica_bq_g: byId('inventorySpecificActivity').value,
    incertidumbre_actividad_bq: byId('inventoryUncertainty').value,
    incertidumbre_especifica_bq_g: byId('inventorySpecificUncertainty').value,
    tipo_incertidumbre: byId('inventoryUncertaintyType').value,
    observaciones: byId('inventoryNotes').value
  };
}

async function saveInventory(event) {
  event.preventDefault();
  if (state.formModel !== state.model) {
    view.showFormError(
      view.nodes.inventoryForm,
      view.nodes.inventoryStatus,
      '',
      'Los datos cambiaron en otra pestaña. Cierra y vuelve a abrir este formulario.'
    );
    return;
  }
  const draft = inventoryDraft();
  const previous = state.model.inventory.find(record => record.record_id === state.editingRecordId);
  if (previous && draft.tipo_incertidumbre === formatDescriptor(previous.tipo_incertidumbre)) draft.tipo_incertidumbre = previous.tipo_incertidumbre;
  if (!state.model.isotopes.some(isotope => isotope.isotopo === draft.radionuclido)) {
    view.showFormError(view.nodes.inventoryForm, view.nodes.inventoryStatus, 'inventoryIsotope', 'Añade primero la semivida de este isótopo en la tabla de isótopos.');
    return;
  }
  const invalidNumber = [...view.nodes.inventoryForm.querySelectorAll('input[type="number"]')].find(field => !field.disabled && field.validity.badInput);
  if (invalidNumber) { view.showFormError(view.nodes.inventoryForm, view.nodes.inventoryStatus, invalidNumber.id, 'Introduce un número válido o vacía el campo.'); return; }
  const validation = validateInventoryDraft(
    draft,
    state.model.inventory,
    state.editingRecordId
  );
  if (!validation.ok) {
    view.showFormError(
      view.nodes.inventoryForm,
      view.nodes.inventoryStatus,
      validation.field,
      validation.message
    );
    return;
  }

  const inventory = [...state.model.inventory];
  const existingIndex = inventory.findIndex(record => record.record_id === state.editingRecordId);
  if (existingIndex >= 0) inventory[existingIndex] = validation.record;
  else inventory.push(validation.record);
  const success = await saveModel(
    { ...state.model, inventory },
    existingIndex >= 0 ? 'Registro actualizado.' : 'Registro añadido.'
  );
  if (success) closeInventory();
}

async function deleteGroup(groupKey) {
  const group = state.groups.find(item => item.key === groupKey);
  if (!group) return;
  const isotopeText = [...new Set(group.records.map(record => record.radionuclido))].join(', ');
  if (!window.confirm(`¿Quitar ${group.id} (${isotopeText})? Esta acción elimina todos sus registros.`)) return;
  const recordIds = new Set(group.records.map(record => record.record_id));
  await saveModel(
    { ...state.model, inventory: state.model.inventory.filter(record => !recordIds.has(record.record_id)) },
    'Elemento eliminado.'
  );
}

function openIsotopes() {
  cancelIsotopeEdit();
  view.renderIsotopes(state.model.isotopes);
  view.openDialog(view.nodes.isotopesDialog, byId('addIsotope'));
}

function startIsotopeEdit(name = '') {
  const isotope = state.model.isotopes.find(item => item.isotopo === name);
  state.editingIsotopeName = isotope?.isotopo || '';
  state.formModel = state.model;
  byId('isotopeForm').reset();
  view.clearFormErrors(byId('isotopeForm'), view.nodes.isotopeStatus);
  byId('isotopeEditorTitle').textContent = isotope ? `Editar ${isotope.isotopo}` : 'Añadir isótopo';
  byId('isotopeName').value = isotope?.isotopo || '';
  byId('isotopeName').disabled = Boolean(isotope);
  byId('isotopeHalfLife').value = isotope?.semivida_valor || '';
  byId('isotopeUnit').value = isotope?.semivida_unidad || 'anos';
  byId('isotopeSource').value = isotope?.fuente || '';
  view.nodes.isotopeEditor.classList.remove('hidden');
  requestAnimationFrame(() => (isotope ? byId('isotopeHalfLife') : byId('isotopeName')).focus());
}

function cancelIsotopeEdit() {
  state.editingIsotopeName = '';
  byId('isotopeName').disabled = false;
  byId('isotopeForm').reset();
  view.clearFormErrors(byId('isotopeForm'), view.nodes.isotopeStatus);
  view.nodes.isotopeEditor.classList.add('hidden');
}

async function saveIsotope(event) {
  event.preventDefault();
  if (state.formModel !== state.model) {
    view.showFormError(
      byId('isotopeForm'),
      view.nodes.isotopeStatus,
      '',
      'Los datos cambiaron en otra pestaña. Vuelve a abrir el editor.'
    );
    return;
  }
  const validation = validateIsotopeDraft({
    isotopo: byId('isotopeName').value,
    semivida_valor: byId('isotopeHalfLife').value,
    semivida_unidad: byId('isotopeUnit').value,
    fuente: byId('isotopeSource').value
  }, state.model.isotopes, state.editingIsotopeName);
  if (!validation.ok) {
    view.showFormError(
      byId('isotopeForm'),
      view.nodes.isotopeStatus,
      validation.field,
      validation.message
    );
    return;
  }

  const isotopes = [...state.model.isotopes];
  const existingIndex = isotopes.findIndex(item => item.isotopo === state.editingIsotopeName);
  if (existingIndex >= 0) isotopes[existingIndex] = validation.isotope;
  else isotopes.push(validation.isotope);
  if (await saveModel(
    { ...state.model, isotopes },
    existingIndex >= 0 ? 'Isótopo actualizado.' : 'Isótopo añadido.'
  )) {
    view.renderIsotopes(state.model.isotopes);
    cancelIsotopeEdit();
  }
}

async function deleteIsotope(name) {
  if (state.model.inventory.some(record => record.radionuclido === name)) {
    view.showStatus(view.nodes.isotopeStatus, `No se puede quitar ${name}: está utilizado por uno o más registros.`, true);
    return;
  }
  if (!window.confirm(`¿Quitar el isótopo ${name}?`)) return;
  if (await saveModel(
    { ...state.model, isotopes: state.model.isotopes.filter(isotope => isotope.isotopo !== name) },
    'Isótopo eliminado.'
  )) view.renderIsotopes(state.model.isotopes);
}

function reportGroups() {
  return byId('reportVisibleOnly').checked ? state.visibleGroups : state.groups;
}

function prepareReport() {
  const groups = reportGroups();
  buildReport(view.nodes.printReportView, groups, state.model.isotopes, state.calculationDate, byId('reportVisibleOnly').checked);
  view.showStatus(view.nodes.reportStatus, groups.length ? '' : 'No hay elementos para incluir.', !groups.length);
  return groups;
}

function setReportBusy(busy) {
  state.reportBusy = busy;
  view.nodes.reportDialog.setAttribute('aria-busy', String(busy));
  ['cancelReport', 'closeReport', 'shareReport', 'downloadReport', 'reportVisibleOnly'].forEach(id => {
    byId(id).disabled = busy;
  });
}

async function generateReportFile() {
  const key = JSON.stringify([state.model, state.calculationDate, reportGroups().map(group => group.key)]);
  if (state.reportFile && state.reportKey === key) return state.reportFile;
  await assertRuntimeReady();
  const groups = prepareReport();
  if (!groups.length) return null;
  view.showStatus(view.nodes.reportStatus, 'Generando el PDF local…');
  const result = await createReportPdf(view.nodes.printReportView, state.calculationDate);
  state.reportFile = result;
  state.reportKey = key;
  return result;
}

async function downloadReport() {
  if (state.reportBusy) return;
  setReportBusy(true);
  try {
    const result = await generateReportFile();
    if (!result) return;
    downloadPdf(result.blob, result.filename);
    view.closeDialog(view.nodes.reportDialog);
    view.toast('Informe PDF generado y descargado.');
  } catch (error) {
    view.showStatus(view.nodes.reportStatus, `No se pudo generar el PDF: ${error.message}`, true);
  } finally {
    setReportBusy(false);
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Usar copia clásica si se deniega el permiso. */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'clipboard-fallback';
  document.body.append(area);
  area.select();
  const copied = document.execCommand?.('copy');
  area.remove();
  if (!copied) throw new Error('El navegador no admite la copia automática.');
}

function canSharePdfFile(file) {
  if (!file || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

async function shareReport() {
  if (state.reportBusy) return;
  setReportBusy(true);
  try {
    const groups = reportGroups();
    const isotopes = state.model.isotopes;
    const date = state.calculationDate;
    const result = await generateReportFile();
    if (!result) return;
    const text = buildShareText(groups, isotopes, date);
    const canShareFile = canSharePdfFile(result.file);
    if (canShareFile) {
      if (navigator.userActivation?.isActive === false) {
        view.showStatus(view.nodes.reportStatus, 'El PDF está preparado. Pulsa de nuevo Compartir para elegir la aplicación de destino.');
        return;
      }
      await navigator.share({
        title: 'Cálculo de actividades',
        text: `Informe con fecha de cálculo ${date}.`,
        files: [result.file]
      });
      view.toast('Informe PDF compartido.');
    } else {
      downloadPdf(result.blob, result.filename);
      await copyText(text).catch(() => {});
      view.toast('Este navegador no comparte archivos directamente. Se ha descargado el PDF.');
    }
    view.closeDialog(view.nodes.reportDialog);
  } catch (error) {
    if (error?.name !== 'AbortError') view.showStatus(view.nodes.reportStatus, `No se pudo compartir: ${error.message}`, true);
  } finally {
    setReportBusy(false);
  }
}

function synchronizeExternalData() {
  if (!state.loaded) return;
  const external = repository.readExternal(state.model.isotopes);
  if (!external.ok) { view.showStatus(byId('storageStatus'), 'El almacenamiento cambió o se borró en otra pestaña. Guarda una copia y recarga antes de editar.', true); return; }
  if (JSON.stringify(external.model) === JSON.stringify(state.model)) return;
  state.model = external.model;
  render();
  view.toast('Datos actualizados desde otra pestaña.');
}

function activateTab(tab) {
  state.filter = tab.dataset.filter;
  document.querySelectorAll('.tab').forEach(item => {
    const active = item === tab;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
  });
  render();
}

function setupEvents() {
  view.nodes.calculationDate.addEventListener('change', event => {
    if (!parseDateOnly(event.target.value)) {
      event.target.value = state.calculationDate;
      view.toast('Introduce una fecha de cálculo válida.');
      return;
    }
    state.calculationDate = event.target.value;
    render();
  });
  view.nodes.searchInput.addEventListener('input', event => {
    state.query = event.target.value;
    render();
  });
  document.querySelector('.tabs').addEventListener('click', event => {
    const tab = event.target.closest('.tab');
    if (tab) activateTab(tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('.tab')];
    const current = tabs.indexOf(document.activeElement);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    event.preventDefault();
    tabs[next].focus();
    activateTab(tabs[next]);
  });

  byId('inventoryButton').addEventListener('click', () => openInventory());
  byId('isotopesButton').addEventListener('click', openIsotopes);
  byId('reportButton').addEventListener('click', () => {
    byId('reportVisibleOnly').checked = false;
    state.reportFile = null;
    state.reportKey = '';
    view.showStatus(view.nodes.reportStatus);
    view.openDialog(view.nodes.reportDialog, byId('reportVisibleOnly'));
  });

  view.nodes.sourceList.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'edit-record') openInventory(action.dataset.recordId);
    if (action.dataset.action === 'delete-group') deleteGroup(action.dataset.groupKey);
  });
  byId('inventoryType').addEventListener('change', event => setMaterialFields(event.target.value === 'material_contaminado'));
  view.nodes.inventoryForm.addEventListener('submit', saveInventory);
  byId('closeInventory').addEventListener('click', closeInventory);
  byId('cancelInventory').addEventListener('click', closeInventory);
  byId('closeIsotopes').addEventListener('click', () => view.closeDialog(view.nodes.isotopesDialog));
  byId('addIsotope').addEventListener('click', () => startIsotopeEdit());
  byId('cancelIsotopeEdit').addEventListener('click', cancelIsotopeEdit);
  byId('isotopeForm').addEventListener('submit', saveIsotope);
  view.nodes.isotopeTable.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'edit-isotope') startIsotopeEdit(action.dataset.isotope);
    if (action.dataset.action === 'delete-isotope') deleteIsotope(action.dataset.isotope);
  });
  byId('closeReport').addEventListener('click', () => view.closeDialog(view.nodes.reportDialog));
  byId('cancelReport').addEventListener('click', () => view.closeDialog(view.nodes.reportDialog));
  byId('shareReport').addEventListener('click', shareReport);
  byId('downloadReport').addEventListener('click', downloadReport);

  [view.nodes.inventoryDialog, view.nodes.isotopesDialog, view.nodes.reportDialog].forEach(dialog => {
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (dialog === view.nodes.reportDialog && state.reportBusy) return;
      view.closeDialog(dialog);
      if (dialog === view.nodes.inventoryDialog) state.editingRecordId = null;
    });
    dialog.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (event.target === dialog && outside && !state.reportBusy) view.closeDialog(dialog);
    });
  });
  window.addEventListener('online', () => view.toast('Conexión restablecida.'));
  window.addEventListener('offline', () => view.toast('Sin conexión. La aplicación seguirá usando los datos locales.'));
  repository.subscribe(synchronizeExternalData);
  window.addEventListener('focus', synchronizeExternalData);
  byId('backupButton').addEventListener('click', () => {
    downloadPdf(new Blob([repository.exportData(state.model)], { type: 'application/json' }), `copia-decaimientos-${todayIso()}.json`);
    view.toast('Copia descargada. Conserva este archivo fuera del navegador.');
  });
  window.addEventListener('beforeprint', () => {
    if (state.reportBusy) return;
    try {
      buildReport(view.nodes.printReportView, state.groups, state.model.isotopes, state.calculationDate, false);
      repairReportLayout(view.nodes.printReportView);
    } catch {
      view.nodes.printReportView.textContent = 'No se pudo preparar la impresión. Revisa los datos y utiliza Generar informe para descargar el PDF.';
    }
  });
}

async function loadDefaults() {
  const [inventoryResult, isotopeResult] = await Promise.allSettled([
    fetchCsv(`./inventario_radiactivo.csv?v=${APP_VERSION}`),
    fetchCsv(`./isotopos.csv?v=${APP_VERSION}`)
  ]);
  if (inventoryResult.status !== 'fulfilled' || isotopeResult.status !== 'fulfilled') {
    const messages = [inventoryResult, isotopeResult]
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message || String(result.reason));
    throw new Error(`No se pudieron cargar los datos incluidos. ${messages.join(' ')}`);
  }
  const normalized = normalizeModel({
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: '',
    inventory: inventoryResult.value,
    isotopes: isotopeResult.value
  }, isotopeResult.value);
  if (!normalized.ok) throw new Error(`Los datos incluidos no son válidos. ${normalized.warnings.join(' ')}`);
  return normalized.model;
}

async function bootstrap() {
  setupEvents();
  setupInstallation({ button: byId('installButton'), toast: view.toast });
  void setupOffline({ status: byId('offlineStatus'), banner: view.nodes.updateBanner, updateButton: byId('updateButton'), isEditing: () => Boolean(document.querySelector('dialog[open]')) || state.saving || state.reportBusy, toast: view.toast });
  view.nodes.calculationDate.value = state.calculationDate;
  let defaults;
  let defaultsError;
  try { defaults = await loadDefaults(); }
  catch (error) {
    defaultsError = error;
    defaults = { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: '', inventory: [], isotopes: [] };
  }
  const loaded = repository.load(defaults);
  if (defaultsError && loaded.source === 'default') throw defaultsError;
  state.model = loaded.model;
  if (defaultsError) loaded.warnings.push('No se pudieron cargar los CSV originales. Se usan tus datos guardados; repara el modo offline con conexión.');
  if (loaded.source !== 'primary') {
    const persisted = await repository.withWriteLock(() => repository.persistRecovered(state.model));
    if (persisted.ok) state.model = persisted.model;
    else loaded.warnings.push(persisted.reason);
  }
  render();
  const warnings = [...loaded.warnings];
  state.loaded = true;
  if (!repository.persistent) warnings.push('El almacenamiento local está bloqueado: los cambios durarán solo hasta cerrar esta pestaña.');
  document.querySelectorAll('[data-requires-model]').forEach(button => { button.disabled = Boolean(loaded.readOnly); });
  if (warnings.length) {
    view.toast(warnings.join(' '), 9_000);
    view.showStatus(byId('storageStatus'), warnings.join(' '), !repository.persistent || loaded.readOnly);
  }
}

bootstrap().catch(error => {
  console.error(error);
  view.nodes.emptyState.classList.remove('hidden');
  view.nodes.emptyTitle.textContent = 'No se pudo iniciar la aplicación';
  view.nodes.emptyMessage.textContent = error.message || 'Se produjo un error inesperado.';
  view.toast('Error de inicio. Recarga la página o revisa el servidor local.', 12_000);
});
