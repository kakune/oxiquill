import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import { referenceError } from './references.mjs';
import { visit } from './remark-mdx-helpers.mjs';

export default function rehypeReferences({ references }) {
  const headings = rehypeHeadingIds();
  return async (tree, file) => {
    if (!file.path) return;
    const state = await references.page(file.path);
    if (!state?.page.references.length) return;
    // This is Astro's own algorithm, including MDX frontmatter expressions and existing IDs.
    headings(tree, file);
    const available = new Map();
    visit(tree, (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'element' && /^h[1-6]$/u.test(node.tagName)) available.set(node.properties.id, node);
    });
    const anchors = new Map();
    state.page.references.forEach(({ name, slug, position }) => {
      const heading = available.get(slug);
      if (!heading)
        throw referenceError(
          state.page.pagePath,
          position,
          `references.${name}: Heading slug ${JSON.stringify(slug)} does not exist. Available slugs: ${[...available.keys()].map((slug) => JSON.stringify(slug)).join(', ') || '(none)'}.`
        );
      anchors.set(heading, [
        ...(anchors.get(heading) ?? []),
        {
          type: 'element',
          tagName: 'span',
          properties: { id: `ox-ref-${name}`, className: ['ox-reference-anchor'], ariaHidden: 'true' },
          children: []
        }
      ]);
    });
    visit(tree, (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.children))
        node.children = node.children.flatMap((child) => [...(anchors.get(child) ?? []), child]);
    });
  };
}
