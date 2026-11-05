import {
  DAYS_PER_YEAR,
  HALF_LIFE_UNITS,
  INVENTORY_TYPES,
  LIMITS,
  MATERIAL_TYPES,
  MILLISECONDS_PER_DAY,
  POINT_TYPES,
  SCHEMA_VERSION
} from './config.js?v=51';

export function toFiniteNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const parsed = Number(text);
  // Un subdesbordamiento no debe convertir una actividad positiva en cero.
  if (parsed === 0 && /[1-9]/.test(text.split(/e/i)[0])) return null;
  return Number.isFinite(parsed) ? parsed : null;
}

export function numberText(value) {
  return String(value);
}

export const hasValue = value => value != null && String(value).trim() !== '';
const invalidOptionalNumber = value => hasValue(value) && toFiniteNumber(value) == null;

export function normalizedText(value) {
  return String(value ?? '').trim().toLocaleLowerCase('es');
}

export function parseDateOnly(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text.startsWith('0000-')) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function todayIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function daysBetween(firstIsoDate, secondIsoDate) {
  const first = parseDateOnly(firstIsoDate);
  const second = parseDateOnly(secondIsoDate);
  return first && second ? (second - first) / MILLISECONDS_PER_DAY : null;
}

export function typeCategory(record) {
  if (POINT_TYPES.has(record?.tipo)) return 'point';
  if (MATERIAL_TYPES.has(record?.tipo)) return 'material';
  return null;
}

export function valuesAgree(first, second, relativeTolerance = 0.005) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  const scale = Math.max(Math.abs(first), Math.abs(second));
  return Math.abs(first - second) <= scale * relativeTolerance;
}

function hashText(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createRecordId(seed = '') {
  if (!seed && globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const entropy = seed || `${Date.now()}-${Math.random()}-${globalThis.performance?.now?.() ?? 0}`;
  return `record-${hashText(entropy)}`;
}

function normalizeHalfLifeUnit(value) {
  const unit = normalizedText(value || 'anos');
  if (unit.startsWith('día') || unit.startsWith('dia')) return 'dias';
  if (unit.startsWith('hora')) return 'horas';
  if (unit.startsWith('año') || unit.startsWith('ano')) return 'anos';
  return unit;
}

export function validateInventoryRecords(input) {
  const records = [];
  const warnings = [];
  const identities = new Set();
  const recordIds = new Set();
  const masses = new Map();
  if (!Array.isArray(input)) return { ok: false, records, warnings: ['El inventario no es una lista.'] };

  input.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') { warnings.push(`Registro ${index + 1}: formato no válido.`); return; }
    const tipo = String(raw.tipo ?? '').trim();
    const identificacion = String(raw.identificacion ?? '').trim();
    const radionuclido = String(raw.radionuclido ?? '').trim();
    const category = typeCategory({ tipo });
    const activity = toFiniteNumber(raw.actividad_referencia_bq);
    let uncertainty = toFiniteNumber(raw.incertidumbre_actividad_bq);
    const mass = toFiniteNumber(raw.masa_g);
    let specific = toFiniteNumber(raw.actividad_especifica_bq_g);
    let specificUncertainty = toFiniteNumber(raw.incertidumbre_especifica_bq_g);
    const referenceDate = String(raw.fecha_referencia ?? '').trim();
    const uncertaintyType = String(raw.tipo_incertidumbre ?? '').trim();
    const notes = String(raw.observaciones ?? '').trim();

    const invalidIdentity = !INVENTORY_TYPES.has(tipo) || !category || !identificacion || identificacion.length > LIMITS.identifier || !radionuclido || radionuclido.length > LIMITS.isotope;
    const invalidNumbers = activity == null || activity < 0 || uncertainty != null && uncertainty < 0
      || invalidOptionalNumber(raw.incertidumbre_actividad_bq)
      || category === 'material' && [raw.actividad_especifica_bq_g, raw.incertidumbre_especifica_bq_g].some(invalidOptionalNumber);
    const invalidText = uncertaintyType.length > LIMITS.uncertaintyType || notes.length > LIMITS.notes;
    if (invalidIdentity || invalidNumbers || invalidText || !['=', '<'].includes(raw.operador_actividad ?? '=') || referenceDate && !parseDateOnly(referenceDate)) {
      warnings.push(`Registro ${index + 1}: datos obligatorios no válidos.`);
      return;
    }

    let normalizedMass = '';
    let normalizedSpecific = '';
    let normalizedSpecificUncertainty = '';
    if (category === 'material') {
      if (!(mass > 0) || specific != null && specific < 0 || specificUncertainty != null && specificUncertainty < 0) {
        warnings.push(`Registro ${index + 1}: masa o actividad específica no válida.`);
        return;
      }
      if (specific == null) specific = activity / mass;
      if (!Number.isFinite(specific) || !valuesAgree(activity, specific * mass)) {
        warnings.push(`Registro ${index + 1}: Bq y Bq/g no son coherentes con la masa.`);
        return;
      }
      if (uncertainty != null && specificUncertainty == null) specificUncertainty = uncertainty / mass;
      if (uncertainty == null && specificUncertainty != null) uncertainty = specificUncertainty * mass;
      if ([uncertainty, specificUncertainty].some(value => value != null && !Number.isFinite(value))) {
        warnings.push(`Registro ${index + 1}: la incertidumbre queda fuera del rango numérico.`);
        return;
      }
      if (uncertainty != null && specificUncertainty != null && !valuesAgree(uncertainty, specificUncertainty * mass)) {
        warnings.push(`Registro ${index + 1}: las incertidumbres total y específica no son coherentes.`);
        return;
      }
      if (uncertainty > 0 && specificUncertainty === 0 || specificUncertainty > 0 && uncertainty === 0) {
        warnings.push(`Registro ${index + 1}: la incertidumbre derivada queda fuera del rango numérico.`);
        return;
      }
      normalizedMass = numberText(mass);
      normalizedSpecific = numberText(specific);
      normalizedSpecificUncertainty = specificUncertainty == null ? '' : numberText(specificUncertainty);
      const groupIdentity = normalizedText(identificacion);
      if (masses.has(groupIdentity) && !valuesAgree(masses.get(groupIdentity), mass, 1e-12)) {
        warnings.push(`Registro ${index + 1}: los isótopos de una muestra deben usar la misma masa.`);
        return;
      }
      masses.set(groupIdentity, mass);
    }

    const identity = `${category}|${normalizedText(identificacion)}|${normalizedText(radionuclido)}`;
    if (identities.has(identity)) { warnings.push(`Registro ${index + 1}: isótopo duplicado en el mismo elemento.`); return; }
    identities.add(identity);

    const suppliedId = String(raw.record_id ?? raw.recordId ?? '').trim();
    let recordId = /^[A-Za-z0-9._:-]{1,100}$/.test(suppliedId) ? suppliedId : createRecordId(`${identity}|${index}`);
    while (recordIds.has(recordId)) recordId = createRecordId(`${recordId}|${index}`);
    recordIds.add(recordId);

    records.push({
      record_id: recordId,
      tipo,
      identificacion,
      radionuclido,
      masa_g: normalizedMass,
      actividad_especifica_bq_g: normalizedSpecific,
      incertidumbre_especifica_bq_g: normalizedSpecificUncertainty,
      operador_actividad: raw.operador_actividad === '<' ? '<' : '=',
      actividad_referencia_bq: numberText(activity),
      incertidumbre_actividad_bq: uncertainty == null ? '' : numberText(uncertainty),
      fecha_referencia: referenceDate,
      tipo_incertidumbre: uncertaintyType,
      observaciones: notes
    });
  });

  return { ok: warnings.length === 0, records, warnings };
}

export function validateIsotopeRecords(input) {
  const records = [];
  const warnings = [];
  const identities = new Set();
  if (!Array.isArray(input)) return { ok: false, records, warnings: ['La tabla de isótopos no es una lista.'] };

  input.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') { warnings.push(`Isótopo ${index + 1}: formato no válido.`); return; }
    const isotopo = String(raw.isotopo ?? '').trim();
    const semivida = toFiniteNumber(raw.semivida_valor);
    const unidad = normalizeHalfLifeUnit(raw.semivida_unidad);
    const fuente = String(raw.fuente ?? '').trim();
    const identity = normalizedText(isotopo);
    if (!identity || isotopo.length > LIMITS.isotope || !(semivida > 0) || !HALF_LIFE_UNITS.has(unidad) || fuente.length > LIMITS.source || identities.has(identity)) {
      warnings.push(`Isótopo ${index + 1}: datos no válidos o duplicados.`);
      return;
    }
    identities.add(identity);
    records.push({
      isotopo,
      semivida_valor: numberText(semivida),
      semivida_unidad: unidad,
      fuente,
      url_fuente: String(raw.url_fuente ?? '').trim(),
      fecha_consulta: String(raw.fecha_consulta ?? '').trim(),
      notas: String(raw.notas ?? '').trim()
    });
  });
  return { ok: warnings.length === 0, records, warnings };
}

export function normalizeModel(raw, defaultIsotopes = []) {
  if (!raw || typeof raw !== 'object') return { ok: false, warnings: ['El conjunto de datos no es un objeto.'] };
  const inventoryResult = validateInventoryRecords(raw.inventory);
  const isotopeResult = validateIsotopeRecords(raw.isotopes);
  if (!inventoryResult.ok || !isotopeResult.ok) return { ok: false, warnings: [...inventoryResult.warnings, ...isotopeResult.warnings] };

  const isotopes = [...isotopeResult.records];
  const byName = new Map(isotopes.map(item => [item.isotopo, item]));
  const defaultsByName = new Map(defaultIsotopes.map(item => [item.isotopo, item]));
  const restored = [];
  for (const name of new Set(inventoryResult.records.map(item => item.radionuclido))) {
    if (!byName.has(name) && defaultsByName.has(name)) {
      const isotope = defaultsByName.get(name);
      isotopes.push(isotope);
      byName.set(name, isotope);
      restored.push(name);
    }
  }

  const revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const warnings = [...inventoryResult.warnings, ...isotopeResult.warnings];
  if (restored.length) warnings.push(`Se recuperaron los isótopos necesarios: ${restored.join(', ')}.`);
  return {
    ok: true,
    model: {
      schemaVersion: SCHEMA_VERSION,
      revision,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      inventory: inventoryResult.records,
      isotopes
    },
    warnings
  };
}

export function calculateDecay(record, isotope, calculationDate) {
  const reference = toFiniteNumber(record?.actividad_referencia_bq);
  const specific = toFiniteNumber(record?.actividad_especifica_bq_g);
  const uncertainty = toFiniteNumber(record?.incertidumbre_actividad_bq);
  const specificUncertainty = toFiniteNumber(record?.incertidumbre_especifica_bq_g);
  const referenceDate = parseDateOnly(record?.fecha_referencia);
  const targetDate = parseDateOnly(calculationDate);
  const halfLifeValue = toFiniteNumber(isotope?.semivida_valor);
  const unit = isotope?.semivida_unidad;
  const isLimit = record?.operador_actividad === '<';
  const unavailable = reason => ({ available: false, reason, reference, specific, uncertainty, specificUncertainty, isLimit });

  if (reference == null || reference < 0) return unavailable('Falta una actividad de referencia válida');
  if (!referenceDate) return unavailable('Falta una fecha de referencia válida');
  if (!targetDate) return unavailable('La fecha de cálculo no es válida');
  if (!(halfLifeValue > 0) || !HALF_LIFE_UNITS.has(unit)) return unavailable('Falta una semivida válida');
  if ([specific, uncertainty, specificUncertainty].some(value => value != null && value < 0)
    || [record?.actividad_especifica_bq_g, record?.incertidumbre_actividad_bq, record?.incertidumbre_especifica_bq_g].some(invalidOptionalNumber)) return unavailable('Hay una actividad o incertidumbre no válida');

  const halfLifeDays = unit === 'dias' ? halfLifeValue : unit === 'horas' ? halfLifeValue / 24 : halfLifeValue * DAYS_PER_YEAR;
  if (!(halfLifeDays > 0) || !Number.isFinite(halfLifeDays)) return unavailable('La semivida queda fuera del rango calculable');
  const days = (targetDate - referenceDate) / MILLISECONDS_PER_DAY;
  const exponent = -Math.LN2 * days / halfLifeDays;
  if (!Number.isFinite(exponent) || exponent > Math.log(Number.MAX_VALUE) || exponent < Math.log(Number.MIN_VALUE)) return unavailable('El resultado queda fuera del rango calculable');

  const factor = Math.exp(exponent);
  const values = {
    factor,
    activity: reference * factor,
    specificActivity: specific == null ? null : specific * factor,
    currentUncertainty: uncertainty == null ? null : uncertainty * factor,
    currentSpecificUncertainty: specificUncertainty == null ? null : specificUncertainty * factor
  };
  if (Object.values(values).some(value => value != null && !Number.isFinite(value))) return unavailable('El resultado queda fuera del rango calculable');
  if ([[reference, values.activity], [specific, values.specificActivity], [uncertainty, values.currentUncertainty], [specificUncertainty, values.currentSpecificUncertainty]].some(([before, after]) => before > 0 && after === 0)) return unavailable('El resultado queda fuera del rango calculable');

  return { available: true, reference, specific, uncertainty, specificUncertainty, isLimit, days, ...values };
}

export function groupInventory(inventory) {
  const groups = new Map();
  for (const record of inventory) {
    const category = typeCategory(record);
    const identity = `${category}|${normalizedText(record.identificacion)}`;
    if (!groups.has(identity)) groups.set(identity, { key: `group-${hashText(identity)}`, category, id: record.identificacion, records: [] });
    groups.get(identity).records.push(record);
  }
  return [...groups.values()];
}

export function filterGroups(groups, filter, query) {
  const needle = normalizedText(query);
  return groups.filter(group => {
    if (filter !== 'all' && group.category !== filter) return false;
    if (!needle) return true;
    return normalizedText([group.id, ...group.records.flatMap(record => [record.radionuclido, record.observaciones])].join(' ')).includes(needle);
  });
}

export function groupTitle(group) {
  const isotopes = [...new Set(group.records.map(record => record.radionuclido))];
  const isotopeText = isotopes.length > 2 ? isotopes.join(' / ') : isotopes.join(' + ');
  return `${isotopeText} · ${group.category === 'point' ? 'NS ' : ''}${group.id}`;
}

export function groupTypeLabel(group) {
  if (group.category === 'point') return group.records.length > 1 ? 'Fuente puntual mixta' : 'Fuente puntual';
  return `Muestra contaminada con ${[...new Set(group.records.map(record => record.radionuclido))].join(' / ')}`;
}

function draftError(field, message) {
  return { ok: false, field, message };
}

export function validateInventoryDraft(draft, inventory, editingRecordId = null) {
  const previous = inventory.find(record => record.record_id === editingRecordId);
  const category = draft.tipo === 'fuente_puntual' ? 'point' : draft.tipo === 'material_contaminado' ? 'material' : null;
  const identificacion = String(draft.identificacion ?? '').trim();
  const radionuclido = String(draft.radionuclido ?? '').trim();
  const referenceDate = String(draft.fecha_referencia ?? '').trim();
  const notes = String(draft.observaciones ?? '').trim();
  const uncertaintyType = String(draft.tipo_incertidumbre ?? '').trim();
  let activity = toFiniteNumber(draft.actividad_referencia_bq);
  let specific = category === 'material' ? toFiniteNumber(draft.actividad_especifica_bq_g) : null;
  let uncertainty = toFiniteNumber(draft.incertidumbre_actividad_bq);
  let specificUncertainty = category === 'material' ? toFiniteNumber(draft.incertidumbre_especifica_bq_g) : null;
  const mass = category === 'material' ? toFiniteNumber(draft.masa_g) : null;

  if (!category) return draftError('inventoryType', 'Selecciona un tipo válido.');
  if (!identificacion) return draftError('inventoryId', 'Introduce el identificador o número de serie.');
  if (identificacion.length > LIMITS.identifier) return draftError('inventoryId', `El identificador no puede superar ${LIMITS.identifier} caracteres.`);
  if (!radionuclido || radionuclido.length > LIMITS.isotope) return draftError('inventoryIsotope', 'Selecciona un isótopo válido.');
  if (!parseDateOnly(referenceDate) && !(previous && !previous.fecha_referencia && !referenceDate)) return draftError('inventoryReferenceDate', 'Introduce una fecha de referencia válida.');
  for (const [key, field] of [
    ['actividad_referencia_bq', 'inventoryActivity'], ['incertidumbre_actividad_bq', 'inventoryUncertainty'],
    ...(category === 'material' ? [['actividad_especifica_bq_g', 'inventorySpecificActivity'], ['incertidumbre_especifica_bq_g', 'inventorySpecificUncertainty']] : [])
  ]) {
    if (invalidOptionalNumber(draft[key])) return draftError(field, 'Introduce un número decimal válido o deja el campo vacío.');
  }
  if (!['=', '<'].includes(draft.operador_actividad)) return draftError('inventoryOperator', 'Selecciona la naturaleza del valor.');
  if (category === 'material' && !(mass > 0)) return draftError('inventoryMass', 'La masa debe ser mayor que cero.');
  if (activity != null && activity < 0) return draftError('inventoryActivity', 'La actividad no puede ser negativa.');
  if (specific != null && specific < 0) return draftError('inventorySpecificActivity', 'La actividad específica no puede ser negativa.');
  if (uncertainty != null && uncertainty < 0) return draftError('inventoryUncertainty', 'La incertidumbre no puede ser negativa.');
  if (specificUncertainty != null && specificUncertainty < 0) return draftError('inventorySpecificUncertainty', 'La incertidumbre específica no puede ser negativa.');
  if (uncertaintyType.length > LIMITS.uncertaintyType) return draftError('inventoryUncertaintyType', 'El tipo de incertidumbre es demasiado largo.');
  if (notes.length > LIMITS.notes) return draftError('inventoryNotes', 'Las observaciones son demasiado largas.');

  if (category === 'material' && activity != null && specific != null && (!Number.isFinite(specific * mass) || !valuesAgree(activity, specific * mass))) {
    return draftError('inventorySpecificActivity', 'La actividad total no coincide con la actividad específica multiplicada por la masa.');
  }
  if (activity == null && specific != null) activity = specific * mass;
  if (activity == null || !Number.isFinite(activity)) return draftError('inventoryActivity', 'Introduce una actividad total o específica válida.');
  if (category === 'material' && specific == null) specific = activity / mass;

  if (category === 'material' && uncertainty != null && specificUncertainty != null && (!Number.isFinite(specificUncertainty * mass) || !valuesAgree(uncertainty, specificUncertainty * mass))) {
    return draftError('inventorySpecificUncertainty', 'La incertidumbre total no coincide con la incertidumbre específica multiplicada por la masa.');
  }
  if (category === 'material' && uncertainty == null && specificUncertainty != null) uncertainty = specificUncertainty * mass;
  if (category === 'material' && specificUncertainty == null && uncertainty != null) specificUncertainty = uncertainty / mass;
  if ([specific, uncertainty, specificUncertainty].some(value => value != null && !Number.isFinite(value))) return draftError('inventoryUncertainty', 'El valor derivado queda fuera del rango numérico. Revisa la masa y las actividades.');
  if (category === 'material' && (activity > 0 && specific === 0 || specific > 0 && activity === 0 || uncertainty > 0 && specificUncertainty === 0 || specificUncertainty > 0 && uncertainty === 0)) return draftError('inventoryMass', 'La conversión entre Bq y Bq/g queda fuera del rango numérico. Revisa la masa.');

  const duplicate = inventory.some(record => record.record_id !== editingRecordId && typeCategory(record) === category && normalizedText(record.identificacion) === normalizedText(identificacion) && normalizedText(record.radionuclido) === normalizedText(radionuclido));
  if (duplicate) return draftError('inventoryIsotope', 'Ese identificador ya contiene este isótopo.');
  const related = inventory.find(record => record.record_id !== editingRecordId && typeCategory(record) === category && normalizedText(record.identificacion) === normalizedText(identificacion));
  if (category === 'material' && related && !valuesAgree(toFiniteNumber(related.masa_g), mass, 1e-12)) return draftError('inventoryMass', 'Todos los isótopos de una muestra deben usar la misma masa.');

  const preservedType = previous && typeCategory(previous) === category ? previous.tipo : null;
  return {
    ok: true,
    record: {
      record_id: editingRecordId || createRecordId(),
      tipo: preservedType || (category === 'material' ? 'muestra_contaminada' : 'fuente_puntual'),
      identificacion,
      radionuclido,
      masa_g: category === 'material' ? numberText(mass) : '',
      actividad_especifica_bq_g: category === 'material' ? numberText(specific) : '',
      incertidumbre_especifica_bq_g: category === 'material' && specificUncertainty != null ? numberText(specificUncertainty) : '',
      operador_actividad: draft.operador_actividad === '<' ? '<' : '=',
      actividad_referencia_bq: numberText(activity),
      incertidumbre_actividad_bq: uncertainty == null ? '' : numberText(uncertainty),
      fecha_referencia: referenceDate,
      tipo_incertidumbre: uncertaintyType.replace(/\s+/g, ' ').trim(),
      observaciones: notes
    }
  };
}

export function validateIsotopeDraft(draft, isotopes, originalName = '') {
  const name = String(draft.isotopo ?? '').trim();
  const halfLife = toFiniteNumber(draft.semivida_valor);
  const unit = normalizeHalfLifeUnit(draft.semivida_unidad);
  const source = String(draft.fuente ?? '').trim();
  if (!name) return draftError('isotopeName', 'Introduce el nombre del isótopo.');
  if (name.length > LIMITS.isotope) return draftError('isotopeName', 'El nombre del isótopo es demasiado largo.');
  if (!(halfLife > 0)) return draftError('isotopeHalfLife', 'La semivida debe ser mayor que cero.');
  if (!HALF_LIFE_UNITS.has(unit)) return draftError('isotopeUnit', 'Selecciona una unidad válida.');
  if (source.length > LIMITS.source) return draftError('isotopeSource', 'La fuente es demasiado larga.');
  const duplicate = isotopes.some(isotope => normalizedText(isotope.isotopo) === normalizedText(name) && isotope.isotopo !== originalName);
  if (duplicate) return draftError('isotopeName', 'Ese isótopo ya existe.');
  const previous = isotopes.find(isotope => isotope.isotopo === originalName);
  return {
    ok: true,
    isotope: {
      ...(previous || {}),
      isotopo: originalName || name,
      semivida_valor: numberText(halfLife),
      semivida_unidad: unit,
      fuente: source
    }
  };
}
