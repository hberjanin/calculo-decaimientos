import test from 'node:test';
import assert from 'node:assert/strict';

import { DAYS_PER_YEAR, SCHEMA_VERSION, STORAGE_BACKUP_KEY, STORAGE_KEY } from '../src/config.js';
import {
  calculateDecay,
  daysBetween,
  filterGroups,
  groupInventory,
  groupTitle,
  parseDateOnly,
  validateInventoryDraft,
  validateInventoryRecords,
  validateIsotopeDraft,
  validateIsotopeRecords,
  valuesAgree
} from '../src/domain.js';
import { createRepository } from '../src/repository.js';
import {
  formatDescriptor,
  metrologyDescriptor,
  shouldShowUncertainty,
  toleranceBounds
} from '../src/format.js';

const pointRecord = {
  record_id: 'test-record',
  tipo: 'fuente_puntual',
  identificacion: 'SERIE-1',
  radionuclido: 'X-1',
  masa_g: '',
  actividad_especifica_bq_g: '',
  incertidumbre_especifica_bq_g: '',
  operador_actividad: '=',
  actividad_referencia_bq: '1000',
  incertidumbre_actividad_bq: '50',
  fecha_referencia: '2024-01-01',
  tipo_incertidumbre: 'k2',
  observaciones: ''
};

const isotopeDays = {
  isotopo: 'X-1',
  semivida_valor: '10',
  semivida_unidad: 'dias',
  fuente: 'Prueba'
};

test('los descriptores metrológicos distinguen incertidumbre, tolerancia y ausencia de dato', () => {
  assert.equal(formatDescriptor('estimada_5_por_ciento'), 'Incertidumbre no indicada en el certificado');
  assert.equal(formatDescriptor('incertidumbre_no_indicada_en_el_certificado'), 'Incertidumbre no indicada en el certificado');
  assert.equal(formatDescriptor('tolerancia_mas_30_menos_20_por_ciento'), 'Tolerancia: −20 % / +30 %');
  assert.equal(formatDescriptor('nominal_mas_menos_20_por_ciento'), 'Tolerancia del valor nominal: ±20 %');
  assert.equal(formatDescriptor('estandar_combinada_k1'), 'Incertidumbre estándar combinada (k = 1)');
  assert.equal(formatDescriptor('expandida_k2_3_por_ciento'), 'Incertidumbre expandida: 3 % (k = 2)');
  assert.equal(formatDescriptor('total_99_por_ciento_3_por_ciento'), 'Incertidumbre total: 3 % (nivel de confianza 99 %)');
  assert.equal(formatDescriptor('expandida_k2'), 'Incertidumbre expandida (k = 2)');
  assert.equal(formatDescriptor('limite_de_deteccion'), 'Límite de detección');
  assert.equal(metrologyDescriptor('tolerancia_mas_30_menos_20_por_ciento').suppressUncertainty, true);
  assert.equal(shouldShowUncertainty({ tipo_incertidumbre: 'estandar_combinada_k1', operador_actividad: '=' }), true);
  assert.equal(shouldShowUncertainty({ tipo_incertidumbre: 'estimada_5_por_ciento', operador_actividad: '=' }), false);
  assert.deepEqual(
    toleranceBounds({ tipo_incertidumbre: 'tolerancia_mas_30_menos_20_por_ciento', actividad_referencia_bq: '200' }),
    { lower: 160, upper: 260 }
  );
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values
  };
}

function defaultModel() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: '',
    inventory: [pointRecord],
    isotopes: [isotopeDays]
  };
}

test('las fechas civiles son estrictas y no dependen de la zona horaria', () => {
  assert.ok(parseDateOnly('2024-02-29'));
  assert.equal(parseDateOnly('2023-02-29'), null);
  assert.equal(parseDateOnly('2024-2-9'), null);
  assert.equal(parseDateOnly('texto'), null);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2);
});

test('en la fecha de referencia el factor es uno', () => {
  const result = calculateDecay(pointRecord, isotopeDays, '2024-01-01');
  assert.equal(result.available, true);
  assert.equal(result.factor, 1);
  assert.equal(result.activity, 1000);
  assert.equal(result.currentUncertainty, 50);
});

test('una semivida después y antes producen la mitad y el doble', () => {
  const later = calculateDecay(pointRecord, isotopeDays, '2024-01-11');
  const earlier = calculateDecay(pointRecord, isotopeDays, '2023-12-22');
  assert.ok(valuesAgree(later.activity, 500, 1e-12));
  assert.ok(valuesAgree(earlier.activity, 2000, 1e-12));
  assert.ok(valuesAgree(later.currentUncertainty, 25, 1e-12));
});

test('horas y años usan unidades coherentes', () => {
  const hourIsotope = { ...isotopeDays, semivida_valor: '48', semivida_unidad: 'horas' };
  assert.ok(valuesAgree(calculateDecay(pointRecord, hourIsotope, '2024-01-03').activity, 500, 1e-12));

  const yearIsotope = { ...isotopeDays, semivida_valor: '1', semivida_unidad: 'anos' };
  const expected = 1000 * Math.exp(-Math.LN2 * 365 / DAYS_PER_YEAR);
  assert.ok(valuesAgree(calculateDecay(pointRecord, yearIsotope, '2024-12-31').activity, expected, 1e-12));
});

test('un dato incompleto o fuera del rango numérico no genera un valor engañoso', () => {
  assert.equal(calculateDecay({ ...pointRecord, fecha_referencia: '' }, isotopeDays, '2024-01-11').available, false);
  assert.equal(calculateDecay(pointRecord, null, '2024-01-11').available, false);
  assert.equal(calculateDecay(pointRecord, isotopeDays, 'fecha').available, false);
  const tinyHalfLife = { ...isotopeDays, semivida_valor: '0.0000000001' };
  assert.equal(calculateDecay(pointRecord, tinyHalfLife, '9999-12-31').available, false);
});

test('los límites superiores y las actividades específicas conservan su naturaleza', () => {
  const material = {
    ...pointRecord,
    tipo: 'muestra_contaminada',
    operador_actividad: '<',
    masa_g: '20',
    actividad_especifica_bq_g: '50',
    incertidumbre_actividad_bq: '',
    incertidumbre_especifica_bq_g: ''
  };
  const result = calculateDecay(material, isotopeDays, '2024-01-11');
  assert.equal(result.isLimit, true);
  assert.ok(valuesAgree(result.activity, 500, 1e-12));
  assert.ok(valuesAgree(result.specificActivity, 25, 1e-12));
});

test('el formulario de material deriva Bq o Bq/g y rechaza incoherencias', () => {
  const valid = validateInventoryDraft({
    tipo: 'material_contaminado',
    identificacion: 'M-1',
    radionuclido: 'X-1',
    fecha_referencia: '2024-01-01',
    masa_g: '20',
    actividad_referencia_bq: '',
    actividad_especifica_bq_g: '5',
    incertidumbre_actividad_bq: '',
    incertidumbre_especifica_bq_g: '0.5',
    operador_actividad: '=',
    tipo_incertidumbre: 'k2',
    observaciones: ''
  }, []);
  assert.equal(valid.ok, true);
  assert.equal(valid.record.actividad_referencia_bq, '100');
  assert.equal(valid.record.incertidumbre_actividad_bq, '10');

  const invalid = validateInventoryDraft({
    ...valid.record,
    tipo: 'material_contaminado',
    actividad_referencia_bq: '200'
  }, []);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.field, 'inventorySpecificActivity');
});

test('se impiden duplicados, masas distintas dentro de una muestra y entradas negativas', () => {
  const baseDraft = {
    tipo: 'material_contaminado', identificacion: 'M-1', radionuclido: 'X-1',
    fecha_referencia: '2024-01-01', masa_g: '10', actividad_referencia_bq: '50',
    actividad_especifica_bq_g: '5', incertidumbre_actividad_bq: '',
    incertidumbre_especifica_bq_g: '', operador_actividad: '=', tipo_incertidumbre: '', observaciones: ''
  };
  const existing = validateInventoryDraft(baseDraft, []).record;
  assert.equal(validateInventoryDraft(baseDraft, [existing]).ok, false);
  assert.equal(validateInventoryDraft({ ...baseDraft, radionuclido: 'Y-1', masa_g: '11', actividad_referencia_bq: '55' }, [existing]).ok, false);
  assert.equal(validateInventoryDraft({ ...baseDraft, actividad_referencia_bq: '-1' }, []).ok, false);
});

test('la normalización elimina campos no admitidos y conserva texto como datos', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const result = validateInventoryRecords([{ ...pointRecord, documento: 'no debe persistir', observaciones: malicious }]);
  assert.equal(result.ok, true);
  assert.equal(result.records[0].observaciones, malicious);
  assert.equal('documento' in result.records[0], false);
});

test('una colección parcialmente dañada se rechaza completa en vez de perder filas', () => {
  const inventory = validateInventoryRecords([
    pointRecord,
    { ...pointRecord, record_id: 'invalid', identificacion: 'SERIE-2', actividad_referencia_bq: 'no-numérico' }
  ]);
  assert.equal(inventory.ok, false);
  assert.equal(inventory.records.length, 1);
  assert.match(inventory.warnings.join(' '), /datos obligatorios no válidos/);

  const isotopes = validateIsotopeRecords([
    isotopeDays,
    { ...isotopeDays, isotopo: 'Y-1', semivida_valor: '0' }
  ]);
  assert.equal(isotopes.ok, false);
  assert.equal(isotopes.records.length, 1);
});

test('agrupación y búsqueda incluyen identificador, isótopo y observaciones', () => {
  const second = { ...pointRecord, record_id: 'second', radionuclido: 'Y-1', observaciones: 'patrón especial' };
  const groups = groupInventory([pointRecord, second]);
  assert.equal(groups.length, 1);
  assert.match(groupTitle(groups[0]), /X-1 \+ Y-1/);
  assert.equal(filterGroups(groups, 'point', 'especial').length, 1);
  assert.equal(filterGroups(groups, 'material', '').length, 0);
});

test('la tabla de isótopos valida unidad, semivida y duplicados', () => {
  assert.equal(validateIsotopeRecords([isotopeDays]).ok, true);
  assert.equal(validateIsotopeRecords([{ ...isotopeDays, semivida_valor: '0' }]).ok, false);
  assert.equal(validateIsotopeRecords([isotopeDays, { ...isotopeDays }]).records.length, 1);
  assert.equal(validateIsotopeDraft({ isotopo: 'Y-1', semivida_valor: '2', semivida_unidad: 'dias', fuente: '' }, [isotopeDays]).ok, true);
  assert.equal(validateIsotopeDraft({ isotopo: 'x-1', semivida_valor: '2', semivida_unidad: 'dias', fuente: '' }, [isotopeDays]).ok, false);
});

test('el repositorio guarda con revisión y detecta escrituras concurrentes', () => {
  const storage = memoryStorage();
  const repository = createRepository(storage);
  const loaded = repository.load(defaultModel());
  assert.equal(loaded.source, 'default');
  const first = repository.save(loaded.model, loaded.model.revision);
  assert.equal(first.ok, true);
  const stale = repository.save({ ...first.model, inventory: [] }, 0);
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
});

test('el repositorio recupera una copia válida si el estado principal se daña', () => {
  const storage = memoryStorage();
  const repository = createRepository(storage);
  const first = repository.save(defaultModel(), 0, { force: true });
  const changed = { ...first.model, inventory: [{ ...pointRecord, observaciones: 'segunda versión' }] };
  const second = repository.save(changed, first.model.revision);
  assert.equal(second.ok, true);
  storage.setItem(STORAGE_KEY, '{json roto');
  const recovered = createRepository(storage).load(defaultModel());
  assert.equal(recovered.source, 'backup');
  assert.equal(recovered.model.inventory[0].observaciones, '');
});

test('el repositorio usa la copia si solo una fila del estado principal está dañada', () => {
  const storage = memoryStorage();
  const repository = createRepository(storage);
  const first = repository.save(defaultModel(), 0, { force: true });
  const second = repository.save({
    ...first.model,
    inventory: [{ ...pointRecord, observaciones: 'cambio válido' }]
  }, first.model.revision);
  assert.equal(second.ok, true);
  assert.ok(storage.getItem(STORAGE_BACKUP_KEY));

  const damaged = JSON.parse(storage.getItem(STORAGE_KEY));
  damaged.inventory.push({ ...pointRecord, record_id: 'bad-row', identificacion: 'SERIE-2', actividad_referencia_bq: 'NaN' });
  storage.setItem(STORAGE_KEY, JSON.stringify(damaged));

  const recovered = createRepository(storage).load(defaultModel());
  assert.equal(recovered.source, 'backup');
  assert.equal(recovered.model.inventory.length, 1);
  assert.equal(recovered.model.inventory[0].observaciones, '');
});

test('la migración retira solo las estimaciones heredadas exactas no certificadas', () => {
  const legacyEstimate = {
    ...pointRecord,
    record_id: 'legacy-1105141',
    identificacion: '1105141',
    radionuclido: 'Eu-152',
    actividad_referencia_bq: '31857',
    incertidumbre_actividad_bq: '1592.85',
    tipo_incertidumbre: 'estimada_5_por_ciento'
  };
  const userEdited = {
    ...legacyEstimate,
    record_id: 'user-edited',
    identificacion: 'FUENTE-USUARIO',
    incertidumbre_actividad_bq: '1600'
  };
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({
      ...defaultModel(),
      schemaVersion: 1,
      inventory: [legacyEstimate, userEdited]
    })
  });
  const loaded = createRepository(storage).load(defaultModel());
  assert.equal(loaded.source, 'migrated');
  assert.equal(loaded.model.schemaVersion, SCHEMA_VERSION);
  assert.equal(loaded.model.inventory[0].incertidumbre_actividad_bq, '');
  assert.equal(loaded.model.inventory[0].tipo_incertidumbre, 'incertidumbre_no_indicada_en_el_certificado');
  assert.equal(loaded.model.inventory[1].incertidumbre_actividad_bq, '1600');
  assert.equal(loaded.model.inventory[1].tipo_incertidumbre, 'estimada_5_por_ciento');
});

test('si localStorage está bloqueado se usa memoria sin bloquear la aplicación', () => {
  const blocked = {
    getItem() { throw new Error('bloqueado'); },
    setItem() { throw new Error('bloqueado'); },
    removeItem() { throw new Error('bloqueado'); }
  };
  const repository = createRepository(blocked);
  assert.equal(repository.persistent, false);
  const result = repository.save(defaultModel(), 0, { force: true });
  assert.equal(result.ok, true);
});
