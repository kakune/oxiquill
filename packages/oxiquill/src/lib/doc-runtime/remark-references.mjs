import { resolveReference } from './references.mjs';
import { visit } from './remark-mdx-helpers.mjs';

export default function remarkReferences({ references }) {
  return async (tree, file) => {
    const nodes = [];
    visit(tree, (node) => {
      if (!node || typeof node !== 'object') return;
      if ((node.type === 'link' || node.type === 'definition') && node.url.startsWith('oxref:')) nodes.push(node);
    });
    if (!nodes.length || !file.path) return;
    const state = await references.page(file.path, true);
    if (!state) return;
    // Resolve before mutating, so an error cannot leave a partially rewritten tree.
    const urls = nodes.map((node) =>
      resolveReference(node.url, state.page, state.registry, state.config, node.position?.start)
    );
    nodes.forEach((node, index) => {
      node.url = urls[index];
    });
  };
}
