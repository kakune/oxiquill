import path from 'node:path';
import {
  createDefaultImport,
  expressionAttribute,
  relativeImport,
  visit
} from './remark-mdx-helpers.mjs';

const mermaidLanguage = 'mermaid';

export default function remarkMermaidDiagrams({ root = process.cwd() } = {}) {
  const componentPath = path.join(root, 'src/components/doc-runtime/MermaidDiagram');

  return (tree, file) => {
    let needsImport = false;
    let diagramIndex = 0;

    visit(tree, (node) => {
      if (!node || node.type !== 'code' || normalizeLanguage(node.lang) !== mermaidLanguage) return;

      needsImport = true;
      diagramIndex += 1;

      Object.assign(node, {
        type: 'mdxJsxFlowElement',
        name: 'MermaidDiagram',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'client:load', value: null },
          expressionAttribute('source', node.value ?? ''),
          { type: 'mdxJsxAttribute', name: 'diagramId', value: `mermaid-${diagramIndex}` }
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
        '/src/components/doc-runtime/MermaidDiagram'
      );
      tree.children.unshift(createDefaultImport('MermaidDiagram', importPath));
    }
  };
}

function normalizeLanguage(language) {
  return language?.trim().toLowerCase();
}
