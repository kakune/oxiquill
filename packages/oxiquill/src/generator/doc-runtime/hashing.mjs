import { createHash } from 'node:crypto';

export function createSha256() {
  return createHash('sha256');
}

export function stableFingerprint(value) {
  return JSON.stringify(value);
}

export function hashText(value) {
  return createSha256().update(value).digest('hex');
}

export function hashBytes(value) {
  return createSha256().update(value).digest('hex');
}
