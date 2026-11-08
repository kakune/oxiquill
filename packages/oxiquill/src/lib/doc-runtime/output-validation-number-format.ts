import type { NumberFormat } from './types.js';
import {
  ArtifactValidationError,
  plainRecord,
  requiredOwnValue,
  finiteNumber,
  optionalString,
  rejectUnknownFields
} from './output-validation-common.js';

export function validateNumberFormat(value: unknown, context: string): NumberFormat {
  const record = plainRecord(value, context);
  rejectUnknownFields(record, ['significantDigits', 'fractionDigits', 'unit', 'notation'], context);
  const format: NumberFormat = {};
  for (const [field, min, max] of [
    ['significantDigits', 1, 17],
    ['fractionDigits', 0, 20]
  ] as const) {
    if (!Object.hasOwn(record, field)) continue;
    const number = finiteNumber(requiredOwnValue(record, field, context), context + ' ' + field);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new ArtifactValidationError(`${context} ${field} must be an integer within ${min}–${max}.`);
    format[field] = number;
  }
  if (format.significantDigits !== undefined && format.fractionDigits !== undefined)
    throw new ArtifactValidationError(`${context} cannot combine significantDigits and fractionDigits.`);
  const unit = optionalString(record, 'unit', context);
  const notation = optionalString(record, 'notation', context);
  if (
    notation !== undefined &&
    notation !== 'auto' &&
    notation !== 'si' &&
    notation !== 'standard' &&
    notation !== 'scientific'
  )
    throw new ArtifactValidationError(`${context} notation must be auto, standard, scientific, or si.`);
  return { ...format, ...(unit === undefined ? {} : { unit }), ...(notation === undefined ? {} : { notation }) };
}
