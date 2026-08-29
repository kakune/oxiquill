import { haskellFunctionName, haskellIdentifier } from './haskell-identifiers.mjs';
import { rustFunctionName, rustIdentifier } from './rust-identifiers.mjs';
import { throwInteractiveCellDiagnostics, uniqueCellIdDiagnostics } from '../../lib/doc-runtime/cell-authoring.mjs';

export function assertUniqueCellIds(cells) {
  throwInteractiveCellDiagnostics(uniqueCellIdDiagnostics(cells));
}

export function assertUniqueRustInputBindings(rustCells) {
  const diagnostics = [];
  for (const cell of rustCells) {
    const seen = new Map();
    for (const input of cell.inputs) {
      const binding = rustIdentifier(input.name);
      const previous = seen.get(binding);
      if (previous) {
        diagnostics.push(
          cellDiagnostic(
            cell,
            `inputs.${input.name}`,
            `Inputs ${JSON.stringify(previous)} and ${JSON.stringify(input.name)} both map to Rust binding ${JSON.stringify(binding)}.`
          )
        );
      }
      seen.set(binding, input.name);
    }
  }
  throwInteractiveCellDiagnostics(diagnostics);
}

export function assertUniqueRustFunctionNames(rustCells) {
  assertUniqueGeneratedFunctionNames(rustCells, rustFunctionName, 'Rust');
}

export function assertUniqueHaskellInputBindings(haskellCells) {
  const diagnostics = [];
  for (const cell of haskellCells) {
    const seen = new Map();
    for (const input of cell.inputs) {
      const binding = haskellIdentifier(input.name);
      const previous = seen.get(binding);
      if (previous) {
        diagnostics.push(
          cellDiagnostic(
            cell,
            `inputs.${input.name}`,
            `Inputs ${JSON.stringify(previous)} and ${JSON.stringify(input.name)} both map to Haskell binding ${JSON.stringify(binding)}.`
          )
        );
      }
      seen.set(binding, input.name);
    }
  }
  throwInteractiveCellDiagnostics(diagnostics);
}

export function assertUniqueHaskellFunctionNames(haskellCells) {
  assertUniqueGeneratedFunctionNames(haskellCells, haskellFunctionName, 'Haskell');
}

function assertUniqueGeneratedFunctionNames(cells, functionNameForCell, languageLabel) {
  const seen = new Map();
  const diagnostics = [];
  for (const cell of cells) {
    const functionName = functionNameForCell(cell.id);
    const previous = seen.get(functionName);
    if (previous) {
      diagnostics.push(
        cellDiagnostic(
          cell,
          'id',
          `${languageLabel} cells ${JSON.stringify(previous.id)} and ${JSON.stringify(cell.id)} both map to generated function ${JSON.stringify(functionName)}; first declared at ${cellLocation(previous)}.`
        )
      );
    }
    seen.set(functionName, cell);
  }
  throwInteractiveCellDiagnostics(diagnostics);
}

function cellDiagnostic(cell, fieldPath, message) {
  return {
    pagePath: cell.pagePath ?? '',
    fenceStartLine: cell.fenceStartLine ?? 1,
    cellId: cell.localId ?? cell.id,
    fieldPath,
    message
  };
}

function cellLocation(cell) {
  return `${cell.pagePath || '(unknown page)'}:${cell.fenceStartLine ?? 1}`;
}
