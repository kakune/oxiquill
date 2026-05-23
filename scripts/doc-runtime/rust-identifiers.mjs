import { rustReservedIdentifiers } from './constants.mjs';

export function rustReaderName(input) {
  if (input.type === 'checkbox') return 'read_bool';
  if (input.type === 'integer' || input.integer) return 'read_u32';
  if (input.type === 'range' || input.type === 'number') return 'read_f64';
  return 'read_string';
}

export function rustFunctionName(id) {
  return `run_${rustIdentifier(id)}`;
}

export function rustIdentifier(value) {
  const identifier = value.replace(/[^a-zA-Z0-9_]/gu, '_').replace(/_+/gu, '_');
  if (!/^[a-zA-Z_]/u.test(identifier)) return `cell_${identifier}`;
  return rustReservedIdentifiers.has(identifier) ? `cell_${identifier}` : identifier;
}
