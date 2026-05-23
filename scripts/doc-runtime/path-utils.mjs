import path from 'node:path';

export function normalizePath(value) {
  return value.split(path.sep).join('/');
}
