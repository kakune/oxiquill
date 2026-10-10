import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import katex from 'katex';

// Render with this package's pinned KaTeX so the markup always matches oxiquill/styles/katex.css.
export default function rehypeKatex() {
  return (tree, file) => {
    renderChildren(tree, [], file);
  };
}

function renderChildren(parent, ancestors, file) {
  if (!Array.isArray(parent.children)) return;

  const lineage = [...ancestors, parent];
  for (let index = 0; index < parent.children.length; index += 1) {
    const math = mathScope(parent.children[index]);
    if (!math) {
      renderChildren(parent.children[index], lineage, file);
      continue;
    }

    const replacement = renderMath(math, lineage, file);
    parent.children.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}

function mathScope(node) {
  if (node?.type !== 'element') return undefined;

  // remark-math emits display math as <pre><code class="language-math math-display">.
  if (node.tagName === 'pre') {
    const code = node.children.find(
      (child) => child.type === 'element' && child.tagName === 'code' && hasClass(child, 'language-math')
    );
    return code ? { displayMode: true, element: code, scope: node } : undefined;
  }

  if (!['language-math', 'math-display', 'math-inline'].some((name) => hasClass(node, name))) return undefined;
  return { displayMode: hasClass(node, 'math-display'), element: node, scope: node };
}

function renderMath({ displayMode, element, scope }, ancestors, file) {
  const value = textContent(scope);

  try {
    return htmlChildren(katex.renderToString(value, { displayMode, throwOnError: true }));
  } catch (error) {
    file?.message('Could not render math with KaTeX', {
      ancestors: [...ancestors, element],
      cause: error,
      place: element.position,
      ruleId: String(error?.name ?? 'error').toLowerCase(),
      source: 'oxiquill-katex'
    });

    try {
      return htmlChildren(katex.renderToString(value, { displayMode, strict: 'ignore', throwOnError: false }));
    } catch {
      return [
        {
          type: 'element',
          tagName: 'span',
          properties: { className: ['katex-error'], style: 'color:#cc0000', title: String(error) },
          children: [{ type: 'text', value }]
        }
      ];
    }
  }
}

function htmlChildren(html) {
  return fromHtmlIsomorphic(html, { fragment: true }).children;
}

function hasClass(element, name) {
  const className = element.properties?.className;
  return Array.isArray(className) && className.includes(name);
}

function textContent(node) {
  if (node.type === 'text') return node.value;
  return Array.isArray(node.children) ? node.children.map(textContent).join('') : '';
}
