import {
  APP_VERSION,
  LEGACY_INVENTORY_KEY,
  LEGACY_ISOTOPES_KEY,
  LEGACY_VERSION_KEY,
  SCHEMA_VERSION,
  STORAGE_BACKUP_KEY,
  STORAGE_RECOVERY_KEY,
  STORAGE_KEY
} from './config.js?v=51';
import { normalizeModel } from './domain.js?v=51';

const LEGACY_SCHEMA_VERSION = 1;

function normalizedDescriptor(value) {
  return String(value ?? '').replaceAll('_', ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

function migrateLegacyInventory(inventory) {
  if (!Array.isArray(inventory)) return inventory;
  return inventory.map(record => {
    const descriptor = normalizedDescriptor(record?.tipo_incertidumbre);
    const activity = Number(record?.actividad_referencia_bq);
    const uncertainty = Number(record?.incertidumbre_actividad_bq);
    const isLegacyEstimate = descriptor === 'estimada 5 por ciento'
      && record?.radionuclido === 'Eu-152'
      && (
        record?.identificacion === '1105141' && activity === 31857 && uncertainty === 1592.85
        || record?.identificacion === '411068' && activity === 33707 && uncertainty === 1685.35
      );
    if (isLegacyEstimate) {
      return {
        ...record,
        incertidumbre_actividad_bq: '',
        incertidumbre_especifica_bq_g: '',
        tipo_incertidumbre: 'incertidumbre_no_indicada_en_el_certificado'
      };
    }
    const isLegacySteelLimit = record?.identificacion === 'O21121_7'
      && record?.radionuclido === 'Co-60'
      && descriptor === 'limite superior con incertidumbre estimada 10 por ciento';
    return isLegacySteelLimit ? { ...record, tipo_incertidumbre: 'limite_superior' } : record;
  });
}

function migrateCandidateSchema(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  if (candidate.schemaVersion === SCHEMA_VERSION) return { candidate, migrated: false };
  if (candidate.schemaVersion !== LEGACY_SCHEMA_VERSION) return null;
  return {
    migrated: true,
    candidate: {
      ...candidate,
      schemaVersion: SCHEMA_VERSION,
      inventory: migrateLegacyInventory(candidate.inventory)
    }
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function read(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function write(storage, key, value) {
  try { storage.setItem(key, value); return true; } catch { return false; }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function resolveStorage(candidate) {
  try {
    const storage = candidate ?? globalThis.localStorage;
    // Una cuota llena impide escribir, pero no debe ocultar datos legibles.
    storage.getItem(STORAGE_KEY);
    return { storage, persistent: true };
  } catch {
    return { storage: memoryStorage(), persistent: false };
  }
}

export function createRepository(candidateStorage) {
  const resolved = resolveStorage(candidateStorage);
  const storage = resolved.storage;
  let observedRaw;
  let readOnly = false;
  function normalizeCandidate(candidate, defaultIsotopes) {
    const migrated = migrateCandidateSchema(candidate);
    if (!migrated) return { ok: false, warnings: [] };
    const normalized = normalizeModel(migrated.candidate, defaultIsotopes);
    return { ...normalized, migrated: migrated.migrated };
  }

  function load(defaultModel) {
    const warnings = [];
    const defaultResult = normalizeModel(defaultModel, defaultModel.isotopes);
    if (!defaultResult.ok) throw new Error('Los datos incluidos con la aplicación no son válidos.');

    const primaryRaw = read(storage, STORAGE_KEY);
    observedRaw = primaryRaw;
    const primaryJson = parseJson(primaryRaw);
    readOnly = primaryJson?.schemaVersion > SCHEMA_VERSION;
    const primary = normalizeCandidate(primaryJson, defaultResult.model.isotopes);
    if (primary.ok) {
      const migrationWarning = primary.migrated
        ? ['Se han retirado estimaciones internas que no figuraban en los certificados.']
        : [];
      return {
        model: primary.model,
        source: primary.migrated ? 'migrated' : 'primary',
        warnings: [...primary.warnings, ...migrationWarning]
      };
    }
    if (primaryRaw) warnings.push(readOnly
      ? 'Los datos pertenecen a una versión más reciente. Usa esa versión o guarda una copia; esta versión no los sobrescribirá.'
      : 'Los datos principales estaban dañados. Se conservarán antes de cualquier recuperación.');

    const backupRaw = read(storage, STORAGE_BACKUP_KEY);
    const backup = normalizeCandidate(parseJson(backupRaw), defaultResult.model.isotopes);
    if (backup.ok) {
      warnings.push('Se ha recuperado la última copia local válida.');
      return {
        model: backup.model,
        source: backup.migrated ? 'migrated-backup' : 'backup',
        warnings: [...warnings, ...backup.warnings], readOnly
      };
    }
    if (backupRaw) warnings.push('La copia local tampoco era válida.');

    const legacyInventoryRaw = read(storage, LEGACY_INVENTORY_KEY);
    const legacyIsotopesRaw = read(storage, LEGACY_ISOTOPES_KEY);
    const legacyInventory = parseJson(legacyInventoryRaw);
    const legacyIsotopes = parseJson(legacyIsotopesRaw);
    if (Array.isArray(legacyInventory) || Array.isArray(legacyIsotopes)) {
      const legacy = normalizeModel({
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        updatedAt: '',
        inventory: Array.isArray(legacyInventory) ? migrateLegacyInventory(legacyInventory) : defaultResult.model.inventory,
        isotopes: Array.isArray(legacyIsotopes) ? legacyIsotopes : defaultResult.model.isotopes
      }, defaultResult.model.isotopes);
      if (legacy.ok) {
        warnings.push('Se han migrado los datos guardados por la versión anterior.');
        return { model: legacy.model, source: 'legacy', warnings: [...warnings, ...legacy.warnings], readOnly };
      }
      warnings.push('Los datos de la versión anterior no se pudieron recuperar.');
    }

    warnings.push('Se han cargado los datos originales de la aplicación.');
    return { model: defaultResult.model, source: 'default', warnings: [...warnings, ...defaultResult.warnings], readOnly };
  }

  function currentRevision(defaultIsotopes) {
    const current = normalizeCandidate(parseJson(read(storage, STORAGE_KEY)), defaultIsotopes);
    return current.ok ? current.model.revision : null;
  }

  function save(model, expectedRevision = model.revision, { force = false, recovering = false } = {}) {
    if (readOnly) return { ok: false, reason: 'Abre la versión más reciente o guarda una copia de los datos. No se sobrescribió nada.' };
    const normalized = normalizeModel(model, model.isotopes);
    if (!normalized.ok) return { ok: false, reason: 'Los datos que se intentan guardar no son válidos.' };

    const previous = read(storage, STORAGE_KEY);
    const persistedRevision = currentRevision(normalized.model.isotopes);
    if (observedRaw !== undefined && previous !== observedRaw) {
      return { ok: false, conflict: true, reason: 'Los datos cambiaron en otra pestaña o se borraron. Recarga la aplicación antes de guardar.' };
    }
    if (!recovering && previous && persistedRevision == null) return { ok: false, reason: 'El almacenamiento cambió o está dañado. Guarda una copia y recarga para recuperarlo.' };
    if (!force && persistedRevision != null && persistedRevision !== expectedRevision) {
      return { ok: false, conflict: true, reason: 'Los datos cambiaron en otra pestaña. Reabre el formulario antes de guardar.' };
    }

    const next = {
      ...normalized.model,
      schemaVersion: SCHEMA_VERSION,
      revision: Math.max(expectedRevision, persistedRevision ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    const validPrevious = previous && normalizeCandidate(parseJson(previous), model.isotopes).ok;
    if (validPrevious && !write(storage, STORAGE_BACKUP_KEY, previous)) {
      return { ok: false, reason: 'No hay espacio para la copia de seguridad. Guarda una copia en un archivo y libera espacio del navegador; no se modificaron los datos.' };
    }
    if (!previous && !read(storage, STORAGE_BACKUP_KEY) && !write(storage, STORAGE_BACKUP_KEY, JSON.stringify(next))) {
      return { ok: false, reason: 'No se pudo crear la copia local. Guarda una copia en un archivo y revisa el espacio y los permisos del navegador.' };
    }
    if (!write(storage, STORAGE_KEY, JSON.stringify(next))) {
      return { ok: false, reason: 'No se pudo guardar. Guarda una copia en un archivo y revisa el espacio y los permisos del navegador. Se conserva la versión anterior.' };
    }
    observedRaw = JSON.stringify(next);

    // Mantener estas claves facilita volver temporalmente a una versión anterior.
    write(storage, LEGACY_INVENTORY_KEY, JSON.stringify(next.inventory));
    write(storage, LEGACY_ISOTOPES_KEY, JSON.stringify(next.isotopes));
    write(storage, LEGACY_VERSION_KEY, APP_VERSION);
    return { ok: true, model: next, warnings: normalized.warnings };
  }

  function persistRecovered(model) {
    if (readOnly) return save(model);
    if (read(storage, STORAGE_KEY) !== observedRaw) return { ok: false, conflict: true, reason: 'Otra pestaña guardó datos durante la recuperación. Recarga para usar su versión.' };
    const snapshot = Object.fromEntries([STORAGE_KEY, STORAGE_BACKUP_KEY, LEGACY_INVENTORY_KEY, LEGACY_ISOTOPES_KEY, LEGACY_VERSION_KEY]
      .map(key => [key, read(storage, key)]).filter(([, value]) => value != null));
    if (Object.keys(snapshot).length) {
      const rawHistory = read(storage, STORAGE_RECOVERY_KEY);
      const history = rawHistory ? parseJson(rawHistory) : [];
      if (!Array.isArray(history)) return { ok: false, reason: 'La copia de recuperación necesita revisión. Guarda una copia en un archivo; no se sobrescribió nada.' };
      if (!history.some(entry => JSON.stringify(entry.values) === JSON.stringify(snapshot))) history.push({ savedAt: new Date().toISOString(), values: snapshot });
      if (!write(storage, STORAGE_RECOVERY_KEY, JSON.stringify(history))) return { ok: false, reason: 'No hay espacio para preservar los datos anteriores. Guarda una copia en un archivo antes de recuperar; no se sobrescribió nada.' };
    }
    return save(model, model.revision, { force: true, recovering: true });
  }

  function readExternal(defaultIsotopes) {
    const raw = read(storage, STORAGE_KEY);
    const result = normalizeCandidate(parseJson(raw), defaultIsotopes);
    if (result.ok) observedRaw = raw;
    return result;
  }

  function subscribe(callback) {
    if (!globalThis.addEventListener) return () => {};
    const handler = event => { if (event.key === STORAGE_KEY || event.key === null) callback(); };
    globalThis.addEventListener('storage', handler);
    return () => globalThis.removeEventListener('storage', handler);
  }

  async function withWriteLock(operation) {
    if (!resolved.persistent) return operation();
    if (globalThis.navigator?.locks?.request) {
      try { return await navigator.locks.request(STORAGE_KEY, { mode: 'exclusive' }, operation); }
      catch { return { ok: false, reason: 'No se pudo reservar el almacenamiento. Cierra otras pestañas y vuelve a intentarlo.' }; }
    }
    if (!globalThis.indexedDB) return { ok: false, reason: 'El navegador no ofrece coordinación segura entre pestañas. Guarda una copia y habilita el almacenamiento del sitio para editar.' };
    // Una transacción de escritura de IndexedDB también excluye a otras pestañas.
    return new Promise(resolve => {
      let finished = false;
      let database;
      const finish = result => { if (finished) return; finished = true; clearTimeout(timer); database?.close(); resolve(result); };
      const failed = () => finish({ ok: false, reason: 'No se pudo reservar el almacenamiento. Cierra otras pestañas y revisa los permisos del sitio.' });
      const timer = setTimeout(failed, 5_000);
      const request = indexedDB.open('calculo-decaimientos-coordination', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('writes');
      request.onerror = failed;
      request.onblocked = failed;
      request.onsuccess = () => {
        database = request.result;
        if (finished) { database.close(); return; }
        const transaction = database.transaction('writes', 'readwrite');
        let result;
        transaction.objectStore('writes').get('lock').onsuccess = () => {
          if (!finished) { try { result = operation(); } catch { transaction.abort(); } }
        };
        transaction.oncomplete = () => finish(result);
        transaction.onerror = failed;
        transaction.onabort = failed;
      };
    });
  }

  function exportData(model) {
    return JSON.stringify({ application: 'calculo-decaimientos', exportedAt: new Date().toISOString(), model,
      storage: Object.fromEntries([STORAGE_KEY, STORAGE_BACKUP_KEY, STORAGE_RECOVERY_KEY, LEGACY_INVENTORY_KEY, LEGACY_ISOTOPES_KEY, LEGACY_VERSION_KEY].map(key => [key, read(storage, key)])) }, null, 2);
  }

  return { load, save, persistRecovered, readExternal, subscribe, exportData, withWriteLock, persistent: resolved.persistent };
}
