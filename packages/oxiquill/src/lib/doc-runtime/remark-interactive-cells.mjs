import { relativePagePath } from './authoring-ids.mjs';
import {
  parseInteractiveCellNode,
  throwInteractiveCellDiagnostics,
  uniqueCellIdDiagnostics
} from './cell-authoring.mjs';
import {
  allocateMdxIdentifier,
  collectReservedMdxIdentifiers,
  identifierAttribute,
  visit
} from './remark-mdx-helpers.mjs';

export default function remarkInteractiveCells({ root = process.cwd() } = {}) {
  return (tree, file) => {
    const pagePath = relativePagePath(root, file?.path);
    const diagnostics = [];
    const cells = [];

    visit(tree, (node) => {
      const result = parseInteractiveCellNode(node, pagePath);
      if (result.kind === 'invalid') diagnostics.push(...result.diagnostics);
      if (result.kind === 'cell') cells.push({ cell: result.cell, node });
    });

    throwInteractiveCellDiagnostics(diagnostics);
    throwInteractiveCellDiagnostics(uniqueCellIdDiagnostics(cells.map(({ cell }) => cell)));

    const reservedIdentifiers = collectReservedMdxIdentifiers(tree);
    const componentIdentifier = allocateMdxIdentifier(reservedIdentifiers, '__OxiquillInteractiveCell');
    const cellIdentifiers = cells.map((_, index) =>
      allocateMdxIdentifier(reservedIdentifiers, interactiveCellIdentifier(index))
    );

    cells.forEach(({ cell, node }, index) => {
      Object.assign(node, {
        type: 'mdxJsxFlowElement',
        name: componentIdentifier,
        attributes: [
          { type: 'mdxJsxAttribute', name: 'client:visible', value: null },
          { type: 'mdxJsxAttribute', name: 'cellId', value: cell.id },
          identifierAttribute('cell', cellIdentifiers[index])
        ],
        children: []
      });

      delete node.lang;
      delete node.meta;
      delete node.value;
    });

    if (cells.length > 0 && Array.isArray(tree.children)) {
      tree.children.unshift(
        createInteractiveCellImports(
          componentIdentifier,
          cells.map(({ cell }, index) => ({ cellId: cell.id, identifier: cellIdentifiers[index] }))
        )
      );
    }
  };
}

function createInteractiveCellImports(componentIdentifier, cells) {
  const componentImport = createImportDeclaration(componentIdentifier, 'oxiquill/runtime/InteractiveCell', true);
  const cellImports = cells.map(({ cellId, identifier }) =>
    createImportDeclaration(identifier, `virtual:oxiquill/cell?cellId=${encodeURIComponent(cellId)}`, false)
  );
  const declarations = [componentImport, ...cellImports];

  return {
    type: 'mdxjsEsm',
    value: declarations.map(renderImportDeclaration).join('\n'),
    data: {
      estree: {
        type: 'Program',
        sourceType: 'module',
        body: declarations
      }
    }
  };
}

function createImportDeclaration(localName, importPath, isDefault) {
  return {
    type: 'ImportDeclaration',
    specifiers: [
      isDefault
        ? {
            type: 'ImportDefaultSpecifier',
            local: { type: 'Identifier', name: localName }
          }
        : {
            type: 'ImportSpecifier',
            imported: { type: 'Identifier', name: 'cell' },
            local: { type: 'Identifier', name: localName }
          }
    ],
    source: { type: 'Literal', value: importPath, raw: JSON.stringify(importPath) }
  };
}

function renderImportDeclaration(declaration) {
  const specifier = declaration.specifiers[0];
  const importPath = JSON.stringify(declaration.source.value);
  if (specifier.type === 'ImportDefaultSpecifier') {
    return `import ${specifier.local.name} from ${importPath};`;
  }

  return `import { cell as ${specifier.local.name} } from ${importPath};`;
}

function interactiveCellIdentifier(index) {
  return `__oxiquillCell${index}`;
}
