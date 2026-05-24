import { createHash } from 'node:crypto';

export function stableFingerprint(value) {
  return JSON.stringify(value);
}

export function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}
