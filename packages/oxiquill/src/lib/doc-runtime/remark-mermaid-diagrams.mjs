import {
  allocateMdxIdentifier,
  collectReservedMdxIdentifiers,
  createDefaultImport,
  expressionAttribute,
  visit
} from './remark-mdx-helpers.mjs';

const mermaidLanguage = 'mermaid';

export default function remarkMermaidDiagrams() {
  return (tree) => {
    const diagrams = [];

    visit(tree, (node) => {
      if (!node || node.type !== 'code' || normalizeLanguage(node.lang) !== mermaidLanguage) return;

      diagrams.push(node);
    });

    if (diagrams.length === 0) return;

    const componentIdentifier = allocateMdxIdentifier(collectReservedMdxIdentifiers(tree), '__OxiquillMermaidDiagram');

    diagrams.forEach((node, index) => {
      Object.assign(node, {
        type: 'mdxJsxFlowElement',
        name: componentIdentifier,
        attributes: [
          { type: 'mdxJsxAttribute', name: 'client:load', value: null },
          expressionAttribute('source', node.value ?? ''),
          { type: 'mdxJsxAttribute', name: 'diagramId', value: `mermaid-${index + 1}` }
        ],
        children: []
      });

      delete node.lang;
      delete node.meta;
      delete node.value;
    });

    if (Array.isArray(tree.children)) {
      tree.children.unshift(createDefaultImport(componentIdentifier, 'oxiquill/runtime/MermaidDiagram'));
    }
  };
}

function normalizeLanguage(language) {
  return language?.trim().toLowerCase();
}
