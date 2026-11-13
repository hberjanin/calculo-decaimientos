import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, STORAGE_KEY, STORAGE_BACKUP_KEY, STORAGE_RECOVERY_KEY } from '../src/config.js';
import { calculateDecay, parseDateOnly, toFiniteNumber, numberText, validateInventoryDraft, validateInventoryRecords, valuesAgree } from '../src/domain.js';
import { createRepository } from '../src/repository.js';
import { parseCsv } from '../src/csv.js';
import { recordPresentation } from '../src/measurements.js';
import { formatNumber } from '../src/format.js';
import { labelSelection } from '../src/labels.js';

const record = { record_id: 'test', tipo: 'fuente_puntual', identificacion: 'TEST', radionuclido: 'X', actividad_referencia_bq: '1000', incertidumbre_actividad_bq: '50', fecha_referencia: '2024-01-01', operador_actividad: '=', tipo_incertidumbre: 'expandida_k2', observaciones: '' };
const isotope = { isotopo: 'X', semivida_valor: '10', semivida_unidad: 'dias', fuente: '' };
const model = () => ({ schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: '', inventory: [{ ...record }], isotopes: [{ ...isotope }] });
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const draft = () => ({ ...record, masa_g: '', actividad_especifica_bq_g: '', incertidumbre_especifica_bq_g: '' });

test('una lectura fallida después del arranque no permite sobrescribir datos legibles', () => {
  const original = JSON.stringify(model());
  const store = storage({ [STORAGE_KEY]: original });
  const repository = createRepository(store);
  const loaded = repository.load(model());
  const getItem = store.getItem;
  store.getItem = () => { throw new Error('Permiso revocado'); };
  assert.equal(repository.save({ ...loaded.model, inventory: [] }).ok, false);
  store.getItem = getItem;
  assert.equal(repository.save(loaded.model).ok, false);
  assert.equal(store.getItem(STORAGE_KEY), original);
});

test('una lectura fallida al recuperar no borra el principal ni las copias', () => {
  for (const blockedKey of [STORAGE_KEY, STORAGE_BACKUP_KEY, STORAGE_RECOVERY_KEY]) {
    const store = storage({ [STORAGE_KEY]: '{roto', [STORAGE_BACKUP_KEY]: JSON.stringify(model()) });
    const before = [...store.values];
    const repository = createRepository(store);
    const getItem = store.getItem;
    store.getItem = key => { if (key === blockedKey) throw new Error('No legible'); return getItem(key); };
    const loaded = repository.load(model());
    assert.equal(repository.persistRecovered(loaded.model).ok, false);
    assert.deepEqual([...store.values], before);
    assert.match(JSON.parse(repository.exportData(loaded.model)).warning, /leer/);
  }
});

test('una historia de recuperación con entradas corruptas se conserva sin excepción', () => {
  for (const entries of [[null], [4], [{}], [{ values: [] }]]) {
    const history = JSON.stringify(entries);
    const store = storage({ [STORAGE_KEY]: '{roto', [STORAGE_RECOVERY_KEY]: history });
    const repository = createRepository(store);
    const loaded = repository.load(model());
    assert.equal(repository.persistRecovered(loaded.model).ok, false);
    assert.equal(store.getItem(STORAGE_KEY), '{roto');
    assert.equal(store.getItem(STORAGE_RECOVERY_KEY), history);
  }
});

test('el contador de revisiones no desborda ni vuelve silenciosamente a cero', () => {
  const original = JSON.stringify({ ...model(), revision: Number.MAX_SAFE_INTEGER });
  const store = storage({ [STORAGE_KEY]: original });
  const repository = createRepository(store);
  const loaded = repository.load(model());
  assert.equal(repository.save(loaded.model).ok, false);
  assert.equal(store.getItem(STORAGE_KEY), original);
});

test('cantidades positivas pequeñas nunca se presentan como cero', () => {
  assert.equal(formatNumber(0.004, 2), '4,000e-3');
  assert.equal(formatNumber(0, 2), '0');
  assert.equal(formatNumber(0.005, 2), '0,01');
});

test('etiquetas valida límites y conserva grupos y registros intactos', () => {
  const groups = [{ id: 'A', records: [record] }, { id: 'B', records: [record] }];
  const before = JSON.stringify(groups);
  const labels = labelSelection(groups, '3');
  assert.equal(labels.length, 6);
  assert.equal(labels[0], groups[0]);
  assert.equal(JSON.stringify(groups), before);
  for (const value of ['', 'roto', 0, -1, 1.5, 101]) assert.throws(() => labelSelection(groups, value), /entera/);
  assert.throws(() => labelSelection(Array(11).fill(groups[0]), 100), /1000/);
  assert.equal(labelSelection(Array(10).fill(groups[0]), 100).length, 1000);
});

test('leer Bq-g no admite convertir un producto positivo subdesbordado en cero', () => {
  assert.equal(validateInventoryRecords([{ ...record, tipo: 'muestra_contaminada', masa_g: '1e-300', actividad_referencia_bq: '0', actividad_especifica_bq_g: '1e-300', incertidumbre_actividad_bq: '' }]).ok, false);
});

test('IndexedDB que lanza al abrir produce un error accionable', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new Error('Bloqueado'); } } });
    const result = await createRepository(storage()).withWriteLock(() => assert.fail('No debe guardar'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /permisos/);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete globalThis.indexedDB;
  }
});

test('los números admiten decimal español y exponente, sin conversiones ambiguas', () => {
  for (const invalid of ['', ' ', true, false, [], {}, '0x10', '0b11', 'Infinity', 'NaN', '1.2.3', '1,2,3', '1e-400']) assert.equal(toFiniteNumber(invalid), null, String(invalid));
  assert.equal(toFiniteNumber(' 1,25e2 '), 125);
  assert.equal(toFiniteNumber('0e-400'), 0);
  assert.equal(numberText(1.2345678901234567), '1.2345678901234567');
  assert.equal(valuesAgree(1e-15, 2e-15), false);
  assert.equal(parseDateOnly('0000-01-01'), null);
});

test('un número opcional corrupto se rechaza, nunca se elimina en silencio', () => {
  assert.equal(validateInventoryRecords([{ ...record, incertidumbre_actividad_bq: 'roto' }]).ok, false);
  assert.equal(validateInventoryDraft({ ...draft(), incertidumbre_actividad_bq: 'roto' }, []).ok, false);
  assert.equal(validateInventoryRecords([{ ...record, operador_actividad: '>' }]).ok, false);
  assert.equal(validateInventoryDraft({ ...draft(), operador_actividad: '>' }, []).ok, false);
});

test('se puede editar un registro histórico sin inventar su fecha', () => {
  const previous = { ...record, fecha_referencia: '' };
  const result = validateInventoryDraft({ ...draft(), fecha_referencia: '', observaciones: 'Revisado' }, [previous], 'test');
  assert.equal(result.ok, true);
  assert.equal(result.record.fecha_referencia, '');
  assert.equal(validateInventoryDraft({ ...draft(), fecha_referencia: '' }, []).ok, false);
});

test('se rechazan subdesbordamientos, desbordamientos y semividas no representables', () => {
  assert.equal(calculateDecay({ ...record, actividad_referencia_bq: '1e-300' }, { ...isotope, semivida_valor: '1' }, '2024-04-10').available, false);
  assert.equal(calculateDecay(record, { ...isotope, semivida_valor: '1e308', semivida_unidad: 'anos' }, '2024-01-01').available, false);
  assert.equal(calculateDecay({ ...record, incertidumbre_actividad_bq: '-1' }, isotope, '2024-01-01').available, false);
  const material = { ...draft(), tipo: 'material_contaminado', masa_g: '1e-300', actividad_referencia_bq: '', actividad_especifica_bq_g: '1e-300' };
  assert.equal(validateInventoryDraft(material, []).ok, false);
});

test('masa e incertidumbres se comprueban también al leer datos guardados', () => {
  const material = { ...record, tipo: 'muestra_contaminada', masa_g: '10', actividad_especifica_bq_g: '100', incertidumbre_actividad_bq: '', incertidumbre_especifica_bq_g: '5' };
  assert.equal(validateInventoryRecords([material]).records[0].incertidumbre_actividad_bq, '50');
  assert.equal(validateInventoryRecords([material, { ...material, record_id: 'second', radionuclido: 'Y', masa_g: '20', actividad_especifica_bq_g: '50' }]).ok, false);
});

test('recuperar conserva la copia válida y archiva exactamente el estado dañado', () => {
  const original = JSON.stringify(model());
  const store = storage({ [STORAGE_KEY]: '{dañado', [STORAGE_BACKUP_KEY]: original });
  const repository = createRepository(store);
  const loaded = repository.load(model());
  assert.equal(loaded.source, 'backup');
  assert.equal(repository.persistRecovered(loaded.model).ok, true);
  assert.equal(store.getItem(STORAGE_BACKUP_KEY), original);
  assert.equal(JSON.parse(store.getItem(STORAGE_RECOVERY_KEY))[0].values[STORAGE_KEY], '{dañado');
});

test('sin espacio para preservar una recuperación no se sobrescribe el original', () => {
  const store = storage({ [STORAGE_KEY]: '{dañado', [STORAGE_BACKUP_KEY]: JSON.stringify(model()) });
  const setItem = store.setItem;
  store.setItem = (key, value) => { if (key === STORAGE_RECOVERY_KEY) throw new Error('QuotaExceededError'); setItem(key, value); };
  const repository = createRepository(store);
  const loaded = repository.load(model());
  assert.equal(repository.persistRecovered(loaded.model).ok, false);
  assert.equal(store.getItem(STORAGE_KEY), '{dañado');
});

test('una cuota llena no oculta datos existentes ni anuncia un guardado falso', () => {
  const original = JSON.stringify({ ...model(), revision: 4 });
  const store = storage({ [STORAGE_KEY]: original });
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  const repository = createRepository(store);
  const loaded = repository.load(model());
  assert.equal(repository.persistent, true);
  assert.equal(loaded.source, 'primary');
  assert.equal(repository.save({ ...loaded.model, inventory: [] }, 4).ok, false);
  assert.equal(store.getItem(STORAGE_KEY), original);
});

test('datos de un esquema futuro quedan protegidos incluso durante la recuperación', () => {
  const future = JSON.stringify({ ...model(), schemaVersion: 999 });
  const store = storage({ [STORAGE_KEY]: future });
  const repository = createRepository(store);
  const loaded = repository.load(model());
  assert.equal(loaded.readOnly, true);
  assert.equal(repository.persistRecovered(loaded.model).ok, false);
  assert.equal(repository.save(loaded.model).ok, false);
  assert.equal(store.getItem(STORAGE_KEY), future);
});

test('cambios con la misma revisión y borrados externos también son conflictos', () => {
  const store = storage({ [STORAGE_KEY]: JSON.stringify(model()) });
  const repository = createRepository(store);
  const loaded = repository.load(model());
  store.setItem(STORAGE_KEY, JSON.stringify({ ...model(), inventory: [] }));
  assert.equal(repository.save(loaded.model).conflict, true);
  store.removeItem(STORAGE_KEY);
  assert.equal(repository.save(loaded.model).conflict, true);
});

test('no se recupera sobre una escritura que ocurrió después de cargar', () => {
  const store = storage();
  const repository = createRepository(store);
  const loaded = repository.load(model());
  const changed = JSON.stringify({ ...model(), revision: 8 });
  store.setItem(STORAGE_KEY, changed);
  assert.equal(repository.persistRecovered(loaded.model).ok, false);
  assert.equal(store.getItem(STORAGE_KEY), changed);
});

test('la exportación incluye el modelo y las copias recuperables sin interpretar su contenido', () => {
  const store = storage({ [STORAGE_KEY]: '{json roto', [STORAGE_RECOVERY_KEY]: 'archivo antiguo' });
  const exported = JSON.parse(createRepository(store).exportData(model()));
  assert.equal(exported.model.inventory.length, 1);
  assert.equal(exported.storage[STORAGE_KEY], '{json roto');
  assert.equal(exported.storage[STORAGE_RECOVERY_KEY], 'archivo antiguo');
});

test('CSV rechaza comillas ambiguas y conserva saltos y comillas escapadas', () => {
  assert.throws(() => parseCsv('a;b\nx"y";z'), /comilla/);
  assert.throws(() => parseCsv('a;b\n"x"y;z'), /comilla/);
  assert.deepEqual(parseCsv('a;b\r\n"x\n""y""";z'), [{ a: 'x\n"y"', b: 'z' }]);
});

test('la presentación compartida conserva límites, incertidumbres y tolerancias', () => {
  const result = recordPresentation(record, isotope, '2024-01-11');
  assert.equal(result.current.measurements[0].value, '500 Bq');
  assert.equal(result.current.measurements[0].uncertainty, '25 Bq');
  const limit = recordPresentation({ ...record, operador_actividad: '<' }, isotope, '2024-01-11');
  assert.equal(limit.current.measurements[0].value, '< 500 Bq');
  assert.equal(limit.current.measurements[0].uncertainty, '');
  const tolerance = recordPresentation({ ...record, tipo_incertidumbre: 'tolerancia_mas_30_menos_20_por_ciento' }, isotope, '2024-01-11');
  assert.equal(tolerance.current.measurements[0].uncertainty, '');
  assert.match(tolerance.current.details.join(' '), /400 Bq a 650 Bq/);
});
