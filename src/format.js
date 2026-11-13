import { parseDateOnly } from './domain.js?v=53';

function descriptorKey(value) {
  return String(value ?? '')
    .replaceAll('_', ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const DESCRIPTORS = [
  {
    aliases: ['incertidumbre no indicada en el certificado', 'estimada 5 por ciento', 'estimada 5 %'],
    label: 'Incertidumbre no indicada en el certificado',
    suppressUncertainty: true
  },
  {
    aliases: ['tolerancia mas 30 menos 20 por ciento', 'tolerancia mas 30 menos 20 %', 'tolerancia: -20 % / +30 %', 'tolerancia: −20 % / +30 %'],
    label: 'Tolerancia: −20 % / +30 %',
    tolerance: { lower: 0.8, upper: 1.3 },
    suppressUncertainty: true
  },
  {
    aliases: ['nominal mas menos 20 por ciento', 'nominal mas menos 20 %', 'tolerancia del valor nominal: +/-20 %', 'tolerancia del valor nominal: ±20 %'],
    label: 'Tolerancia del valor nominal: ±20 %',
    tolerance: { lower: 0.8, upper: 1.2 },
    suppressUncertainty: true
  },
  {
    aliases: ['estandar combinada k1', 'incertidumbre estandar combinada (k = 1)'],
    label: 'Incertidumbre estándar combinada (k = 1)'
  },
  {
    aliases: ['expandida k2 3 por ciento', 'expandida k2 3 %', 'incertidumbre expandida: 3 % (k = 2)'],
    label: 'Incertidumbre expandida: 3 % (k = 2)'
  },
  {
    aliases: ['total 99 por ciento 3 por ciento', 'total 99 % 3 %', 'incertidumbre total: 3 % (nivel de confianza 99 %)'],
    label: 'Incertidumbre total: 3 % (nivel de confianza 99 %)'
  },
  {
    aliases: ['expandida k2', 'incertidumbre expandida (k = 2)'],
    label: 'Incertidumbre expandida (k = 2)'
  },
  {
    aliases: ['limite de deteccion', 'limite de detección'],
    label: 'Límite de detección',
    suppressUncertainty: true
  },
  {
    aliases: ['limite superior con incertidumbre estimada 10 por ciento', 'limite superior', 'límite superior'],
    label: 'Límite superior',
    suppressUncertainty: true
  }
].map(descriptor => ({
  ...descriptor,
  aliases: new Set(descriptor.aliases.map(descriptorKey))
}));

export function metrologyDescriptor(value) {
  const key = descriptorKey(value);
  if (!key) return { label: '', suppressUncertainty: false, tolerance: null };
  const descriptor = DESCRIPTORS.find(item => item.aliases.has(key));
  return descriptor || {
    label: String(value).replaceAll('_', ' ').replace(/\bpor ciento\b/gi, '%').replace(/\s+/g, ' ').trim(),
    suppressUncertainty: false,
    tolerance: null
  };
}

export function formatDate(isoDate) {
  const date = parseDateOnly(isoDate);
  return date
    ? date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    : 'No indicada';
}

export function formatNumber(value, maximumFractionDigits = 2) {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  // Ninguna cantidad positiva debe mostrarse como cero por el redondeo visual.
  if ((absolute > 0 && absolute < Math.max(0.001, 0.5 * 10 ** -maximumFractionDigits)) || absolute >= 1e12) return value.toExponential(3).replace('.', ',');
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits, minimumFractionDigits: 0 }).format(value);
}

export function formatDescriptor(value) {
  return metrologyDescriptor(value).label;
}

export function shouldShowUncertainty(record) {
  return !metrologyDescriptor(record?.tipo_incertidumbre).suppressUncertainty
    && record?.operador_actividad !== '<';
}

export function toleranceBounds(record, factor = 1, specific = false) {
  const tolerance = metrologyDescriptor(record?.tipo_incertidumbre).tolerance;
  const rawValue = specific ? record?.actividad_especifica_bq_g : record?.actividad_referencia_bq;
  if (!tolerance || rawValue === '' || rawValue == null) return null;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || !Number.isFinite(factor) || factor < 0) return null;
  return {
    lower: value * factor * tolerance.lower,
    upper: value * factor * tolerance.upper
  };
}

export function formatActivity(value) {
  if (!Number.isFinite(value)) return { value: '—', unit: 'Bq' };
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return { value: formatNumber(value / 1e9, 3), unit: 'GBq' };
  if (absolute >= 1e6) return { value: formatNumber(value / 1e6, 3), unit: 'MBq' };
  if (absolute >= 10_000) return { value: formatNumber(value / 1_000, 3), unit: 'kBq' };
  return { value: formatNumber(value, absolute < 10 ? 3 : 2), unit: 'Bq' };
}

export function halfLifeUnitLabel(unit) {
  if (unit === 'dias') return 'días';
  if (unit === 'horas') return 'horas';
  return 'años';
}

export function halfLifeLabel(isotope) {
  if (!isotope) return 'no disponible';
  const value = Number(isotope.semivida_valor);
  if (!(value > 0)) return 'no disponible';
  return `${formatNumber(value, value > 10_000 ? 0 : 4)} ${halfLifeUnitLabel(isotope.semivida_unidad)}`;
}
