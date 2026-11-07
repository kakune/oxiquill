import { generatedBanner } from './banners.mjs';

export function generateCellsModule(cells, generationId) {
  return `${generatedBanner()}${generationId ? `export const generationId = ${JSON.stringify(generationId)};\n` : ''}export const cells = ${JSON.stringify(cells, null, 2)};\n`;
}

export function generateCellsJson(cells, generationId) {
  return `${JSON.stringify(generationId ? { generationId, cells } : cells, null, 2)}\n`;
}
