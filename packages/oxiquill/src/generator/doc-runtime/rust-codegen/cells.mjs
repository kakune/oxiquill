import { generatedBanner } from './banners.mjs';

export function generateCellsModule(cells, generationId, rust, definitions = []) {
  return `${generatedBanner()}${generationId ? `export const generationId = ${JSON.stringify(generationId)};\n` : ''}export const cells = ${JSON.stringify(cells, null, 2)};\n${rust ? `export const rust = ${JSON.stringify(rust)};\n` : ''}${definitions.length ? `export const definitions = ${JSON.stringify(definitions)};\n` : ''}`;
}

export function generateCellsJson(cells, generationId, rust, definitions = []) {
  return `${JSON.stringify(generationId ? { generationId, cells, ...(rust ? { rust } : {}), ...(definitions.length ? { definitions } : {}) } : cells, null, 2)}\n`;
}
