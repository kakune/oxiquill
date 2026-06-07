import {
  haskellFunctionName,
  haskellIdentifier
} from './haskell-identifiers.mjs';
import {
  rustFunctionName,
  rustIdentifier
} from './rust-identifiers.mjs';

export function assertUniqueCellIds(cells) {
  const seen = new Map();
  for (const cell of cells) {
    const previous = seen.get(cell.id);
    if (previous) {
      throw new Error(`Duplicate interactive cell id "${cell.id}" in ${previous} and ${cell.pagePath}.`);
    }
    seen.set(cell.id, cell.pagePath);
  }
}

export function assertUniqueRustInputBindings(rustCells) {
  for (const cell of rustCells) {
    const seen = new Map();
    for (const input of cell.inputs) {
      const binding = rustIdentifier(input.name);
      const previous = seen.get(binding);
      if (previous) {
        throw new Error(
          `Rust cell "${cell.id}" in ${cell.pagePath} has inputs "${previous}" and "${input.name}" ` +
            `that both map to Rust binding "${binding}".`
        );
      }
      seen.set(binding, input.name);
    }
  }
}

export function assertUniqueRustFunctionNames(rustCells) {
  assertUniqueGeneratedFunctionNames(rustCells, rustFunctionName, 'Rust');
}

export function assertUniqueHaskellInputBindings(haskellCells) {
  for (const cell of haskellCells) {
    const seen = new Map();
    for (const input of cell.inputs) {
      const binding = haskellIdentifier(input.name);
      const previous = seen.get(binding);
      if (previous) {
        throw new Error(
          `Haskell cell "${cell.id}" in ${cell.pagePath} has inputs "${previous}" and "${input.name}" ` +
            `that both map to Haskell binding "${binding}".`
        );
      }
      seen.set(binding, input.name);
    }
  }
}

export function assertUniqueHaskellFunctionNames(haskellCells) {
  assertUniqueGeneratedFunctionNames(haskellCells, haskellFunctionName, 'Haskell');
}

function assertUniqueGeneratedFunctionNames(cells, functionNameForCell, languageLabel) {
  const seen = new Map();
  for (const cell of cells) {
    const functionName = functionNameForCell(cell.id);
    const previous = seen.get(functionName);
    if (previous) {
      throw new Error(
        `${languageLabel} cells "${previous.id}" in ${previous.pagePath} and "${cell.id}" in ${cell.pagePath} ` +
          `both map to generated function "${functionName}".`
      );
    }
    seen.set(functionName, cell);
  }
}
