// @vitest-environment node

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rehypeKatex from '../../packages/oxiquill/src/lib/doc-runtime/rehype-katex.mjs';

// Load the same ESM KaTeX instance that the package plugin imports.
const requireFromPackage = createRequire(new URL('../../packages/oxiquill/package.json', import.meta.url));
const katexRoot = path.dirname(requireFromPackage.resolve('katex/package.json'));
const { default: katex } = await import(pathToFileURL(path.join(katexRoot, 'dist/katex.mjs')).href);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rehype KaTeX', () => {
  it('renders remark-math inline and display output with the pinned KaTeX', () => {
    const inline = element('code', ['language-math', 'math-inline'], [text('x_n + x^2')]);
    const display = element('pre', [], [element('code', ['language-math', 'math-display'], [text('x_n + x^2')])]);
    const tree = root([element('p', [], [text('Inline '), inline]), display]);

    rehypeKatex()(tree, messages());

    const [paragraph, displayResult] = tree.children;
    expect(paragraph.children[0]).toEqual(text('Inline '));
    expect(classes(paragraph.children[1])).toEqual(['katex']);
    expect(classes(displayResult)).toEqual(['katex-display']);
    expect(JSON.stringify(tree)).toContain('katex-sizing');
  });

  it('renders legacy math classes and leaves other code untouched', () => {
    const code = element('pre', [], [element('code', ['language-js'], [text('x')])]);
    const tree = root([
      element('span', ['math-inline'], [text('a')]),
      element('div', ['math-display'], [text('b')]),
      code,
      text('plain')
    ]);

    rehypeKatex()(tree, messages());

    expect(classes(tree.children[0])).toEqual(['katex']);
    expect(classes(tree.children[1])).toEqual(['katex-display']);
    expect(tree.children[2]).toBe(code);
    expect(tree.children[3]).toEqual(text('plain'));
  });

  it('reports parse errors and keeps KaTeX error markup in place', () => {
    const math = element('code', ['language-math', 'math-inline'], [text('\\frac{')]);
    const file = messages();
    const tree = root([element('p', [], [math, text(' after')])]);

    rehypeKatex()(tree, file);

    expect(file.message).toHaveBeenCalledWith(
      'Could not render math with KaTeX',
      expect.objectContaining({ place: math.position, ruleId: 'parseerror', source: 'oxiquill-katex' })
    );
    const [paragraph] = tree.children;
    expect(classes(paragraph.children[0])).toEqual(['katex-error']);
    expect(paragraph.children[1]).toEqual(text(' after'));
  });

  it('falls back to escaped source when KaTeX cannot render at all', () => {
    vi.spyOn(katex, 'renderToString').mockImplementation(() => {
      throw new TypeError('renderer unavailable');
    });
    const tree = root([element('code', ['language-math', 'math-inline'], [text('x < y')])]);

    rehypeKatex()(tree, undefined);

    expect(tree.children).toEqual([
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['katex-error'], style: 'color:#cc0000', title: 'TypeError: renderer unavailable' },
        children: [text('x < y')]
      }
    ]);
  });
});

function root(children) {
  return { type: 'root', children };
}

function element(tagName, className, children) {
  return {
    type: 'element',
    tagName,
    properties: className.length > 0 ? { className } : {},
    children,
    position: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
  };
}

function text(value) {
  return { type: 'text', value };
}

function classes(node) {
  return node.properties.className;
}

function messages() {
  return { message: vi.fn() };
}
