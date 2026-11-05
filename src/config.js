export const APP_VERSION = '51';
export const SCHEMA_VERSION = 2;

// Monographie BIPM-5: 1 a = 365.242198 d = 31 556 926 s.
export const DAYS_PER_YEAR = 365.242198;
export const MILLISECONDS_PER_DAY = 86_400_000;

export const STORAGE_KEY = 'calculo-decaimientos.state.v1';
export const STORAGE_BACKUP_KEY = 'calculo-decaimientos.backup.v1';
export const STORAGE_RECOVERY_KEY = 'calculo-decaimientos.recovery.v1';
export const LEGACY_INVENTORY_KEY = 'actividad-inventario';
export const LEGACY_ISOTOPES_KEY = 'actividad-isotopos';
export const LEGACY_VERSION_KEY = 'actividad-datos-version';

export const POINT_TYPES = new Set(['fuente_puntual', 'fuente_puntual_mixta']);
export const MATERIAL_TYPES = new Set(['muestra_contaminada', 'muestra_natural_mix', 'blanco_bg', 'disco_acero']);
export const INVENTORY_TYPES = new Set([...POINT_TYPES, ...MATERIAL_TYPES]);
export const HALF_LIFE_UNITS = new Set(['anos', 'dias', 'horas']);

export const LIMITS = Object.freeze({
  identifier: 120,
  isotope: 40,
  source: 200,
  uncertaintyType: 160,
  notes: 2_000,
  csvBytes: 2_000_000
});
