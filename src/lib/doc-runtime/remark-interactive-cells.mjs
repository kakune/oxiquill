import path from 'node:path';
import { relativePagePath, scopedCellId } from './authoring-ids.mjs';
import { createDefaultImport, relativeImport, visit } from './remark-mdx-helpers.mjs';

const optionPattern = /^\s*(?:(?:\/\/\/|\/\/|#)\|)\s?id:\s*([A-Za-z0-9_-]+)/m;
const supportedLanguages = new Set(['rust', 'rs', 'python', 'py']);

export default function remarkInteractiveCells({ root = process.cwd() } = {}) {
  const componentPath = path.join(root, 'src/components/doc-runtime/InteractiveCell');

  return (tree, file) => {
    let needsImport = false;
    const pagePath = relativePagePath(root, file?.path);

    visit(tree, (node) => {
      if (!node || node.type !== 'code' || !supportedLanguages.has(node.lang)) return;

      const localId = node.value?.match(optionPattern)?.[1];
      if (!localId) return;

      needsImport = true;
      Object.assign(node, {
        type: 'mdxJsxFlowElement',
        name: 'InteractiveCell',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'client:load', value: null },
          { type: 'mdxJsxAttribute', name: 'cellId', value: scopedCellId(pagePath, localId) }
        ],
        children: []
      });

      delete node.lang;
      delete node.meta;
      delete node.value;
    });

    if (needsImport && Array.isArray(tree.children)) {
      const importPath = relativeImport(
        file?.path,
        componentPath,
        '/src/components/doc-runtime/InteractiveCell'
      );
      tree.children.unshift(createDefaultImport('InteractiveCell', importPath));
    }
  };
}
