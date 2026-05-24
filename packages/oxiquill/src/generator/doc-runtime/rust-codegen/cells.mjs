import { generatedBanner } from './banners.mjs';

export function generateCellsModule(cells) {
  return `${generatedBanner()}export const cells = ${JSON.stringify(cells, null, 2)};\n`;
}

export function generateCellsJson(cells) {
  return `${JSON.stringify(cells, null, 2)}\n`;
}
