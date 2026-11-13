import { calculateDecay } from './domain.js?v=53';
import { formatActivity, formatDate, formatDescriptor, formatNumber, halfLifeLabel, shouldShowUncertainty, toleranceBounds } from './format.js?v=53';

export function activityText(value, isLimit = false) {
  const formatted = formatActivity(value);
  return `${isLimit ? '< ' : ''}${formatted.value} ${formatted.unit}`;
}

export function activityIntervalText(bounds, specific = false) {
  if (!bounds) return '';
  return specific ? `${formatNumber(bounds.lower, 3)} a ${formatNumber(bounds.upper, 3)} Bq/g`
    : `${activityText(bounds.lower)} a ${activityText(bounds.upper)}`;
}

// Pantalla, informe y texto compartido usan la misma interpretación metrológica.
export function recordPresentation(record, isotope, calculationDate) {
  const result = calculateDecay(record, isotope, calculationDate);
  const showUncertainty = shouldShowUncertainty(record);
  function measurements(total, specific, uncertainty, specificUncertainty) {
    const entries = [{ value: activityText(total, result.isLimit), uncertainty: showUncertainty && uncertainty != null ? activityText(uncertainty) : '', isLimit: result.isLimit }];
    if (specific != null) entries.push({ value: `${result.isLimit ? '< ' : ''}${formatNumber(specific, 3)} Bq/g`, uncertainty: showUncertainty && specificUncertainty != null ? `${formatNumber(specificUncertainty, 3)} Bq/g` : '', isLimit: result.isLimit });
    return entries;
  }
  function intervals(factor, current) {
    return [false, true].flatMap(specific => {
      const bounds = toleranceBounds(record, factor, specific);
      return bounds ? [`Intervalo${specific ? ' específico' : ''} ${current ? 'calculado' : 'de referencia'}: ${activityIntervalText(bounds, specific)}`] : [];
    });
  }
  return {
    result,
    halfLife: `T½ ${halfLifeLabel(isotope)}`,
    reference: {
      label: `Valor de referencia · ${formatDate(record.fecha_referencia)}`,
      measurements: measurements(result.reference, result.specific, result.uncertainty, result.specificUncertainty),
      details: [formatDescriptor(record.tipo_incertidumbre), ...intervals(1, false)].filter(Boolean)
    },
    current: {
      label: `Actividad a ${formatDate(calculationDate)}`,
      measurements: result.available ? measurements(result.activity, result.specificActivity, result.currentUncertainty, result.currentSpecificUncertainty) : [{ value: 'No calculable', uncertainty: '', isLimit: false }],
      details: result.available ? intervals(result.factor, true) : [result.reason]
    }
  };
}
