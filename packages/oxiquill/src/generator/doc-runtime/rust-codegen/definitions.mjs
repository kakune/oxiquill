import { hashText } from '../hashing.mjs';
import { authoredFragment, generatedFragment, joinFragments } from './source-map.mjs';

export const definitionsModuleName = (cell) => `definitions_${hashText(`${cell.pagePath}\0${cell.id}`)}`;

export function definitionsImports(cell, definitions = cell.definitions ?? []) {
  return (cell.uses ?? [])
    .map((id) => {
      const block = definitions.find((candidate) => candidate.localId === id && candidate.pagePath === cell.pagePath);
      return `use crate::${definitionsModuleName(block)}::*;\n`;
    })
    .join('');
}

export function generateDefinitionsModules(cells) {
  const definitions = [
    ...new Map(cells.flatMap((cell) => cell.definitions ?? []).map((block) => [block.id, block])).values()
  ].sort((a, b) => a.id.localeCompare(b.id));
  return joinFragments(
    definitions.flatMap((block) => [
      generatedFragment(
        `#[allow(dead_code, reason = "definitions may be partially used")]\nmod ${definitionsModuleName(block)} {\n`,
        block,
        'module'
      ),
      generatedFragment(definitionsImports(block, definitions), block, 'imports'),
      authoredFragment(block),
      generatedFragment('\n}\n\n', block, 'module')
    ])
  );
}
