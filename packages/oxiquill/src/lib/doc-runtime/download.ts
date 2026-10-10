import type { BaseArtifact } from './types.js';

export function artifactDownloadName(
  artifact: BaseArtifact,
  extension: 'csv' | 'png' | 'svg',
  fallback: string
): string {
  const name = Array.from((artifact.title || artifact.id || fallback).normalize('NFC'))
    .filter((character) => character.charCodeAt(0) >= 32 && character !== '\u007f')
    .join('')
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/^\.+|\.+$/gu, '')
    .trim();
  return `${Array.from(name || fallback)
    .slice(0, 100)
    .join('')}.${extension}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the URL alive until the browser has accepted the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
