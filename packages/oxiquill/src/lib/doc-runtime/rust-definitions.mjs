import { InteractiveCellValidationError } from './cell-authoring.mjs';

export const isDefinitionsBlock = (cell) => cell.kind === 'definitions';

// Resolve without altering authored blocks. Only executable consumers acquire
// effective dependencies; unused definitions never enter a compilation unit.
export function resolveRustDefinitions(cells) {
  const byId = new Map(cells.map((cell) => [`${cell.pagePath}\0${cell.localId}`, cell]));
  const closures = new Map();
  const closure = (cell, ancestors = []) => {
    if (closures.has(cell.id)) return closures.get(cell.id);
    const fail = (message) => {
      throw new InteractiveCellValidationError([
        {
          pagePath: cell.pagePath,
          cellId: cell.localId,
          fenceStartLine: cell.fenceStartLine,
          ...cell.fieldPositions?.uses,
          fieldPath: 'uses',
          message
        }
      ]);
    };
    const definitions = (cell.uses ?? []).flatMap((id) => {
      const target = byId.get(`${cell.pagePath}\0${id}`);
      if (!target) {
        const elsewhere = cells.some((candidate) => candidate.localId === id && candidate.pagePath !== cell.pagePath);
        fail(
          `Definitions block "${id}" ${elsewhere ? 'is on another page; uses must be page-local' : 'does not exist on this page'}.`
        );
      }
      if (!isDefinitionsBlock(target)) fail(`uses target "${id}" is not a definitions block.`);
      if (target.id === cell.id) fail(`Self reference in uses: ${id} -> ${id}.`);
      const chain = [...ancestors, cell];
      if (chain.some((ancestor) => ancestor.id === target.id)) {
        const cycle = [...chain.slice(chain.findIndex((ancestor) => ancestor.id === target.id)), target];
        fail(`Cyclic definitions reference: ${cycle.map((entry) => entry.localId).join(' -> ')}.`);
      }
      return [...closure(target, chain), target];
    });
    const unique = [...new Map(definitions.map((block) => [block.id, block])).values()];
    closures.set(cell.id, unique);
    return unique;
  };
  cells.forEach((cell) => closure(cell));
  return cells.map((cell) => {
    const definitions = closures.get(cell.id);
    if (isDefinitionsBlock(cell) || !definitions.length) return cell;
    return {
      ...cell,
      definitions,
      crates: [...new Set([...cell.crates, ...definitions.flatMap((block) => block.crates)])].sort()
    };
  });
}
