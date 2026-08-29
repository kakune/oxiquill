import { relativePagePath } from './authoring-ids.mjs';
import {
  parseInteractiveCellNode,
  throwInteractiveCellDiagnostics,
  uniqueCellIdDiagnostics
} from './cell-authoring.mjs';
import { createDefaultImport, visit } from './remark-mdx-helpers.mjs';

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

    cells.forEach(({ cell, node }) => {
      Object.assign(node, {
        type: 'mdxJsxFlowElement',
        name: 'InteractiveCell',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'client:visible', value: null },
          { type: 'mdxJsxAttribute', name: 'cellId', value: cell.id }
        ],
        children: []
      });

      delete node.lang;
      delete node.meta;
      delete node.value;
    });

    if (cells.length > 0 && Array.isArray(tree.children)) {
      tree.children.unshift(createDefaultImport('InteractiveCell', 'oxiquill/runtime/InteractiveCell'));
    }
  };
}
