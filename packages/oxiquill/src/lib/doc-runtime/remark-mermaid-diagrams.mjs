import {
  createDefaultImport,
  expressionAttribute,
  visit
} from './remark-mdx-helpers.mjs';

const mermaidLanguage = 'mermaid';

export default function remarkMermaidDiagrams() {
  return (tree) => {
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
      tree.children.unshift(createDefaultImport('MermaidDiagram', 'oxiquill/runtime/MermaidDiagram'));
    }
  };
}

function normalizeLanguage(language) {
  return language?.trim().toLowerCase();
}
