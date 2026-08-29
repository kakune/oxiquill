import { haskellReservedIdentifiers } from './constants.mjs';

export function haskellReaderName(input) {
  if (input.type === 'checkbox') return 'readBoolInput';
  if (input.type === 'integer' || input.integer) return 'readIntInput';
  if (input.type === 'range' || input.type === 'number') return 'readDoubleInput';
  return 'readStringInput';
}

export function haskellFunctionName(id) {
  return `run_${haskellIdentifier(id)}`;
}

export function haskellIdentifier(value) {
  const identifier = String(value).replace(/[^a-zA-Z0-9_]/gu, '_').replace(/_+/gu, '_') || 'cell';
  const variable = /^[a-z_]/u.test(identifier) && identifier !== '_' ? identifier : `cell_${identifier}`;

  return haskellReservedIdentifiers.has(variable) ? `cell_${variable}` : variable;
}
