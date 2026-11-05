import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseCsv } from '../src/csv.js';
import {
  groupInventory,
  normalizeModel,
  normalizedText,
  toFiniteNumber,
  typeCategory,
  valuesAgree
} from '../src/domain.js';
import { SCHEMA_VERSION } from '../src/config.js';

const root = new URL('../', import.meta.url);
const inventoryText = await readFile(new URL('inventario_radiactivo.csv', root), 'utf8');
const isotopeText = await readFile(new URL('isotopos.csv', root), 'utf8');
const inventoryRaw = parseCsv(inventoryText);
const isotopesRaw = parseCsv(isotopeText);
const normalized = normalizeModel({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  updatedAt: '',
  inventory: inventoryRaw,
  isotopes: isotopesRaw
}, isotopesRaw);

test('los CSV de partida son válidos y no pierden registros', () => {
  assert.equal(normalized.ok, true, normalized.warnings.join('\n'));
  assert.equal(inventoryRaw.length, 27);
  assert.equal(normalized.model.inventory.length, 27);
  assert.equal(normalized.model.isotopes.length, 7);
});

test('se conservan los 17 elementos físicos acordados', () => {
  const groups = groupInventory(normalized.model.inventory);
  assert.equal(groups.length, 17);
  assert.equal(groups.filter(group => group.category === 'point').length, 8);
  assert.equal(groups.filter(group => group.category === 'material').length, 9);
});

test('Ra-226 usa la masa verificada de 88,42 g', () => {
  const record = normalized.model.inventory.find(item => item.identificacion === 'O21121-Ra-226' && item.radionuclido === 'Ra-226');
  assert.ok(record);
  assert.equal(record.masa_g, '88.42');
  assert.ok(valuesAgree(toFiniteNumber(record.actividad_referencia_bq), 15.4 * 88.42, 1e-12));
});

test('cada material mantiene coherencia entre masa, Bq/g y Bq', () => {
  for (const record of normalized.model.inventory.filter(item => typeCategory(item) === 'material')) {
    const mass = toFiniteNumber(record.masa_g);
    const specific = toFiniteNumber(record.actividad_especifica_bq_g);
    const total = toFiniteNumber(record.actividad_referencia_bq);
    assert.ok(mass > 0, `${record.identificacion}: masa inválida`);
    assert.ok(valuesAgree(total, mass * specific), `${record.identificacion} ${record.radionuclido}: total incoherente`);
    const uncertainty = toFiniteNumber(record.incertidumbre_actividad_bq);
    const specificUncertainty = toFiniteNumber(record.incertidumbre_especifica_bq_g);
    if (uncertainty != null || specificUncertainty != null) {
      assert.ok(valuesAgree(uncertainty, mass * specificUncertainty), `${record.identificacion} ${record.radionuclido}: incertidumbre incoherente`);
    }
  }
});

test('todos los isótopos usados tienen semivida y no hay identidades duplicadas', () => {
  const isotopeNames = new Set(normalized.model.isotopes.map(item => item.isotopo));
  const identities = new Set();
  for (const record of normalized.model.inventory) {
    assert.ok(isotopeNames.has(record.radionuclido), `Falta ${record.radionuclido}`);
    const identity = `${typeCategory(record)}|${normalizedText(record.identificacion)}|${normalizedText(record.radionuclido)}`;
    assert.equal(identities.has(identity), false, `Duplicado: ${identity}`);
    identities.add(identity);
  }
});

test('solo la fuente 3682 carece de fecha y queda deliberadamente no calculable', () => {
  const missing = normalized.model.inventory.filter(record => !record.fecha_referencia);
  assert.deepEqual(missing.map(record => record.identificacion), ['3682']);
});

test('las semividas iniciales coinciden con la tabla acordada', () => {
  const expected = new Map([
    ['Eu-152', 13.517],
    ['Am-241', 432.6],
    ['Co-60', 5.2711],
    ['Cs-137', 30.018],
    ['Ra-226', 1600],
    ['Th-232', 14_020_000_000],
    ['K-40', 1_252_200_000]
  ]);
  for (const isotope of normalized.model.isotopes) {
    assert.equal(Number(isotope.semivida_valor), expected.get(isotope.isotopo));
    assert.equal(isotope.semivida_unidad, 'anos');
  }
});

test('los datos operativos no contienen campos ni nombres de documentos', () => {
  assert.equal(inventoryText.includes('documento'), false);
  assert.equal(/\.pdf\b/i.test(inventoryText), false);
  assert.equal(/\.pdf\b/i.test(isotopeText), false);
  for (const record of normalized.model.inventory) assert.equal('documento' in record, false);
});

test('no se conservan incertidumbres numéricas inventadas como si fueran certificadas', () => {
  const withoutCertifiedUncertainty = normalized.model.inventory.filter(record =>
    record.tipo_incertidumbre === 'incertidumbre_no_indicada_en_el_certificado'
  );
  assert.deepEqual(withoutCertifiedUncertainty.map(record => record.identificacion).sort(), ['1105141', '411068']);
  for (const record of withoutCertifiedUncertainty) {
    assert.equal(record.incertidumbre_actividad_bq, '');
    assert.equal(record.incertidumbre_especifica_bq_g, '');
  }
  assert.equal(normalized.model.inventory.some(record => /estimada/i.test(record.tipo_incertidumbre)), false);
});

test('el parser CSV gestiona comillas y rechaza estructuras ambiguas', () => {
  assert.deepEqual(parseCsv('a;b\n"x;y";z\n'), [{ a: 'x;y', b: 'z' }]);
  assert.throws(() => parseCsv('a;a\n1;2'), /duplicadas/);
  assert.throws(() => parseCsv('a;b\n"sin cerrar;b'), /sin cerrar/);
  assert.throws(() => parseCsv('a;b\n1;2;3'), /fila 2.*2 columnas/i);
  assert.throws(() => parseCsv('a;b\n1'), /fila 2.*2 columnas/i);
});
