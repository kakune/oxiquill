import { generatedBanner } from './banners.mjs';

export function generateCellsModule(cells, generationId, rust) {
  return `${generatedBanner()}${generationId ? `export const generationId = ${JSON.stringify(generationId)};\n` : ''}export const cells = ${JSON.stringify(cells, null, 2)};\n${rust ? `export const rust = ${JSON.stringify(rust)};\n` : ''}`;
}

export function generateCellsJson(cells, generationId, rust) {
  return `${JSON.stringify(generationId ? { generationId, cells, ...(rust ? { rust } : {}) } : cells, null, 2)}\n`;
}
