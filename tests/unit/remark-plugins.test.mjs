import { describe, expect, it } from 'vitest';
import remarkInteractiveCells from '../../packages/oxiquill/src/lib/doc-runtime/remark-interactive-cells.mjs';
import remarkMermaidDiagrams from '../../packages/oxiquill/src/lib/doc-runtime/remark-mermaid-diagrams.mjs';
import remarkPublicAssetBase, {
  withPublicAssetBase
} from '../../packages/oxiquill/src/lib/doc-runtime/remark-public-asset-base.mjs';
import { parseCellsFromMarkdown } from '../../packages/oxiquill/src/generator/doc-runtime-core.mjs';

describe('remark interactive cells', () => {
  it('turns Rust and Python cells with ids into client components', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [] },
        { type: 'code', lang: 'rust', value: '//| id: rust-one\nprintln!("ok");' },
        { type: 'code', lang: 'python', value: '#| id: python-one\nprint("ok")' },
        null,
        { type: 'code', lang: 'rust', value: 'println!("plain");' },
        { type: 'code', lang: 'txt', value: '//| id: ignored' }
      ]
    };

    remarkInteractiveCells({ root: '/repo' })(tree, {
      path: '/repo/content/docs/page.mdx'
    });

    expect(tree.children[0].value).toContain('import __OxiquillInteractiveCell');
    expect(tree.children[0].value).toContain(
      'import { cell as __oxiquillCell0 } from "virtual:oxiquill/cell?cellId=page__rust-one";'
    );
    expect(tree.children[0].value).toContain(
      'import { cell as __oxiquillCell1 } from "virtual:oxiquill/cell?cellId=page__python-one";'
    );
    expect(tree.children[1]).toMatchObject({
      type: 'paragraph'
    });
    expect(tree.children[2]).toMatchObject({
      type: 'mdxJsxFlowElement',
      name: '__OxiquillInteractiveCell',
      attributes: [
        { type: 'mdxJsxAttribute', name: 'client:visible', value: null },
        { type: 'mdxJsxAttribute', name: 'cellId', value: 'page__rust-one' },
        {
          type: 'mdxJsxAttribute',
          name: 'cell',
          value: {
            type: 'mdxJsxAttributeValueExpression',
            value: '__oxiquillCell0'
          }
        }
      ],
      children: []
    });
    expect(tree.children[3].attributes[1]).toEqual({
      type: 'mdxJsxAttribute',
      name: 'cellId',
      value: 'page__python-one'
    });
    expect(tree.children[4]).toBeNull();
    expect(tree.children[5]).toMatchObject({ type: 'code', lang: 'rust' });
    expect(tree.children[6]).toMatchObject({ type: 'code', lang: 'txt' });
  });

  it('uses a package-stable component import when the file path is unavailable', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'rs', value: '//| id: rust-one\nprintln!("ok");' }]
    };

    remarkInteractiveCells({ root: '/repo' })(tree, {});

    expect(tree.children[0].value).toContain(
      'import __OxiquillInteractiveCell from "oxiquill/runtime/InteractiveCell";'
    );
    expect(tree.children[0].value).toContain(
      'import { cell as __oxiquillCell0 } from "virtual:oxiquill/cell?cellId=rust-one";'
    );
    expect(tree.children[1].attributes[1]).toEqual({
      type: 'mdxJsxAttribute',
      name: 'cellId',
      value: 'rust-one'
    });
  });

  it('scopes interactive cell ids with nested locale-aware page paths', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'python', value: '#| id: repeated\nprint("ok")' }]
    };

    remarkInteractiveCells({ root: '/repo' })(tree, {
      path: '/repo/content/docs/ja/notes/example.mdx'
    });

    expect(tree.children[1].attributes[1]).toEqual({
      type: 'mdxJsxAttribute',
      name: 'cellId',
      value: 'ja__notes__example__repeated'
    });
  });

  it('keeps package-stable component imports for non-docs files', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'rust', value: '//| id: rust-one\nprintln!("ok");' }]
    };

    remarkInteractiveCells({ root: '/repo' })(tree, {
      path: '/repo/src/components/doc-runtime/example.mdx'
    });

    expect(tree.children[0].value).toContain(
      'import __OxiquillInteractiveCell from "oxiquill/runtime/InteractiveCell";'
    );
  });

  it('leaves trees without interactive cells unchanged', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'txt', value: 'plain' }]
    };

    remarkInteractiveCells({ root: '/repo' })(tree, {
      path: '/repo/content/docs/page.mdx'
    });

    expect(tree.children).toHaveLength(1);
  });

  it('renders the scoped id from the same parsed AST node and normalized cell', () => {
    const parsed = parseCellsFromMarkdown(
      '   ````{.rust}\n   //| id: shared-cell\n   //| crates: []\n   println!("ok");\n   `````',
      'content/docs/nested/page.mdx'
    );

    remarkInteractiveCells({ root: '/repo' })(parsed.tree, {
      path: '/repo/content/docs/nested/page.mdx'
    });

    expect(parsed.cells[0].id).toBe('nested__page__shared-cell');
    expect(parsed.tree.children[1].attributes[1]).toEqual({
      type: 'mdxJsxAttribute',
      name: 'cellId',
      value: parsed.cells[0].id
    });
  });

  it('reports structured diagnostics before changing valid sibling nodes', () => {
    const valid = {
      type: 'code',
      lang: 'rust',
      value: '//| id: valid-cell\n//| crates: []\nprintln!("ok");',
      position: { start: { line: 3 } }
    };
    const invalid = {
      type: 'code',
      lang: 'python',
      value: '#| id: Bad.id\nprint("bad")',
      position: { start: { line: 9 } }
    };
    const tree = { type: 'root', children: [valid, invalid] };

    expect(() =>
      remarkInteractiveCells({ root: '/repo' })(tree, {
        path: '/repo/content/docs/page.mdx'
      })
    ).toThrow('content/docs/page.mdx:9 [cell "Bad.id"] id:');
    expect(valid.type).toBe('code');
  });

  it('rejects duplicate local ids before changing the tree', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'code', lang: 'python', value: '#| id: repeated\nprint("one")', position: { start: { line: 1 } } },
        { type: 'code', lang: 'python', value: '#| id: repeated\nprint("two")', position: { start: { line: 5 } } }
      ]
    };

    expect(() =>
      remarkInteractiveCells({ root: '/repo' })(tree, {
        path: '/repo/content/docs/page.mdx'
      })
    ).toThrow('content/docs/page.mdx:5 [cell "repeated"] id: Duplicate page-local cell id');
    expect(tree.children[0].type).toBe('code');
  });
});

describe('remark Mermaid diagrams', () => {
  it('turns Mermaid fences into client components', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'code', lang: 'mermaid', value: 'flowchart LR\n  A --> B' },
        { type: 'code', lang: 'MERMAID', value: 'sequenceDiagram\n  A->>B: hi' },
        { type: 'code', lang: 'mermaid' },
        null,
        { type: 'code', lang: 'rust', value: 'fn main() {}' }
      ]
    };

    remarkMermaidDiagrams({ root: '/repo' })(tree, {
      path: '/repo/content/docs/page.mdx'
    });

    expect(tree.children[0].value).toContain('import __OxiquillMermaidDiagram');
    expect(tree.children[1]).toMatchObject({
      type: 'mdxJsxFlowElement',
      name: '__OxiquillMermaidDiagram',
      attributes: [
        { type: 'mdxJsxAttribute', name: 'client:load', value: null },
        {
          type: 'mdxJsxAttribute',
          name: 'source',
          value: {
            type: 'mdxJsxAttributeValueExpression',
            value: '"flowchart LR\\n  A --> B"'
          }
        },
        { type: 'mdxJsxAttribute', name: 'diagramId', value: 'mermaid-1' }
      ],
      children: []
    });
    expect(tree.children[2].attributes[2]).toEqual({
      type: 'mdxJsxAttribute',
      name: 'diagramId',
      value: 'mermaid-2'
    });
    expect(tree.children[3].attributes[1].value.value).toBe('""');
    expect(tree.children[4]).toBeNull();
    expect(tree.children[5]).toMatchObject({ type: 'code', lang: 'rust' });
  });

  it('uses a package-stable component import when the file path is unavailable', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid', value: '' }]
    };

    remarkMermaidDiagrams({ root: '/repo' })(tree, {});

    expect(tree.children[0].value).toBe("import __OxiquillMermaidDiagram from 'oxiquill/runtime/MermaidDiagram';");
  });

  it('keeps package-stable Mermaid imports for non-docs files', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid', value: 'flowchart LR\nA-->B' }]
    };

    remarkMermaidDiagrams({ root: '/repo' })(tree, {
      path: '/repo/src/components/doc-runtime/example.mdx'
    });

    expect(tree.children[0].value).toBe("import __OxiquillMermaidDiagram from 'oxiquill/runtime/MermaidDiagram';");
  });

  it('leaves trees without Mermaid diagrams unchanged', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'txt', value: 'plain' }]
    };

    remarkMermaidDiagrams({ root: '/repo' })(tree, {
      path: '/repo/content/docs/page.mdx'
    });

    expect(tree.children).toHaveLength(1);
  });
});

describe('remark runtime binding allocation', () => {
  it('allocates distinct component aliases when preferred names are already imported', () => {
    const tree = parseMdxTree(`import __OxiquillInteractiveCell from './InteractiveCell.astro';
import __OxiquillMermaidDiagram from './MermaidDiagram.astro';

\`\`\`rust
//| id: rust-one
println!("ok");
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``);

    applyRuntimeRemarkPlugins(tree);

    expect(runtimeImportLocal(tree, 'oxiquill/runtime/InteractiveCell')).toBe('__OxiquillInteractiveCell1');
    expect(runtimeImportLocal(tree, 'oxiquill/runtime/MermaidDiagram')).toBe('__OxiquillMermaidDiagram1');
  });

  it('reserves variable, function, and class declarations', () => {
    const tree = parseMdxTree(`export const __OxiquillInteractiveCell = null;
export function __OxiquillMermaidDiagram() {}
export class __oxiquillCell0 {}

\`\`\`python
#| id: python-one
print("ok")
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``);

    applyRuntimeRemarkPlugins(tree);

    expect(runtimeImportLocal(tree, 'oxiquill/runtime/InteractiveCell')).toBe('__OxiquillInteractiveCell1');
    expect(runtimeImportLocal(tree, 'oxiquill/runtime/MermaidDiagram')).toBe('__OxiquillMermaidDiagram1');
    expect(cellImportLocals(tree)).toEqual(['__oxiquillCell01']);
  });

  it('reserves destructured names and fills free preferred numeric names deterministically', () => {
    const tree = parseMdxTree(`export const { __oxiquillCell0, __oxiquillCell01, __oxiquillCell2 } = bindings;

\`\`\`rust
//| id: cell-zero
println!("zero");
\`\`\`

\`\`\`python
#| id: cell-one
print("one")
\`\`\`

\`\`\`haskell
--| id: cell-two
putStrLn "two"
\`\`\``);

    remarkInteractiveCells({ root: '/repo' })(tree, { path: '/repo/content/docs/page.mdx' });

    expect(cellImportLocals(tree)).toEqual(['__oxiquillCell02', '__oxiquillCell1', '__oxiquillCell21']);
  });

  it('reserves simple and root JSX component identifiers', () => {
    const tree = parseMdxTree(`<__OxiquillInteractiveCell />

<__OxiquillMermaidDiagram.Part />

\`\`\`rust
//| id: rust-one
println!("ok");
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`mermaid
flowchart LR
  B --> C
\`\`\``);

    applyRuntimeRemarkPlugins(tree);

    expect(runtimeImportLocal(tree, 'oxiquill/runtime/InteractiveCell')).toBe('__OxiquillInteractiveCell1');
    expect(runtimeImportLocal(tree, 'oxiquill/runtime/MermaidDiagram')).toBe('__OxiquillMermaidDiagram1');
    expect(transformedElements(tree, 'client:load').map(({ name }) => name)).toEqual([
      '__OxiquillMermaidDiagram1',
      '__OxiquillMermaidDiagram1'
    ]);
  });

  it('produces identical trees and keeps textual ESM, ESTree, JSX, and expressions aligned', () => {
    const source = `export const __OxiquillInteractiveCell = null;
export const __OxiquillMermaidDiagram = null;
export const __oxiquillCell0 = null;

\`\`\`rust
//| id: rust-one
println!("ok");
\`\`\`

\`\`\`python
#| id: python-one
print("ok")
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`mermaid
sequenceDiagram
  A->>B: hi
\`\`\``;
    const first = parseMdxTree(source);
    const second = parseMdxTree(source);

    applyRuntimeRemarkPlugins(first);
    applyRuntimeRemarkPlugins(second);

    expect(first).toEqual(second);
    expectInjectedBindingsAgree(first, 'oxiquill/runtime/InteractiveCell', 'client:visible');
    expectInjectedBindingsAgree(first, 'oxiquill/runtime/MermaidDiagram', 'client:load');
  });
});

describe('remark public asset base', () => {
  it('prefixes Markdown and string-valued MDX media URLs with the configured base path', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'image', url: '/media/examples/sample.png' },
        { type: 'link', url: '/media/examples/sample.pdf' },
        { type: 'link', url: '/features/media/' },
        {
          type: 'mdxJsxFlowElement',
          name: 'iframe',
          attributes: [
            { type: 'mdxJsxAttribute', name: 'src', value: '/media/examples/sample.pdf' },
            { type: 'mdxJsxAttribute', name: 'href', value: '/media/examples/sample.png' },
            {
              type: 'mdxJsxAttribute',
              name: 'src',
              value: { type: 'mdxJsxAttributeValueExpression', value: 'dynamicSource' }
            },
            { type: 'mdxJsxAttribute', name: 'title', value: 'Sample PDF' }
          ],
          children: []
        }
      ]
    };

    remarkPublicAssetBase({ base: '/oxiquill' })(tree);

    expect(tree.children[0].url).toBe('/oxiquill/media/examples/sample.png');
    expect(tree.children[1].url).toBe('/oxiquill/media/examples/sample.pdf');
    expect(tree.children[2].url).toBe('/features/media/');
    expect(tree.children[3].attributes[0].value).toBe('/oxiquill/media/examples/sample.pdf');
    expect(tree.children[3].attributes[1].value).toBe('/oxiquill/media/examples/sample.png');
    expect(tree.children[3].attributes[2].value).toEqual({
      type: 'mdxJsxAttributeValueExpression',
      value: 'dynamicSource'
    });
  });

  it.each([
    ['/media/examples/sample.png', '/media', '/media/media/examples/sample.png'],
    ['/media/docs/guide.pdf', '/media/docs', '/media/docs/media/docs/guide.pdf'],
    ['/media/examples/sample.png', '/oxiquill', '/oxiquill/media/examples/sample.png']
  ])('prefixes authored media URL %s under base %s', (url, base, expected) => {
    expect(withPublicAssetBase(url, base)).toBe(expected);
  });

  it.each([undefined, '', '/'])('leaves media URLs unchanged when base is %s', (base) => {
    const tree = { type: 'root', children: [{ type: 'image', url: '/media/examples/sample.png' }] };

    remarkPublicAssetBase({ base })(tree);

    expect(tree.children[0].url).toBe('/media/examples/sample.png');
  });

  it.each(['/features/media/', 'media/examples/sample.png', 'https://example.com/media/sample.png', '#media'])(
    'leaves non-media URL %s unchanged',
    (url) => {
      expect(withPublicAssetBase(url, '/media')).toBe(url);
    }
  );

  it('applies an overlapping base consistently to Markdown and MDX nodes', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'image', url: '/media/examples/sample.png' },
        { type: 'link', url: '/media/docs/guide.pdf' },
        {
          type: 'mdxJsxFlowElement',
          name: 'a',
          attributes: [
            { type: 'mdxJsxAttribute', name: 'src', value: '/media/examples/sample.png' },
            { type: 'mdxJsxAttribute', name: 'href', value: '/media/docs/guide.pdf' }
          ],
          children: []
        }
      ]
    };

    remarkPublicAssetBase({ base: '/media' })(tree);

    expect(tree.children[0].url).toBe('/media/media/examples/sample.png');
    expect(tree.children[1].url).toBe('/media/media/docs/guide.pdf');
    expect(tree.children[2].attributes[0].value).toBe('/media/media/examples/sample.png');
    expect(tree.children[2].attributes[1].value).toBe('/media/media/docs/guide.pdf');
  });
});

function parseMdxTree(source) {
  const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');
  expect(parsed.diagnostics).toEqual([]);
  return parsed.tree;
}

function applyRuntimeRemarkPlugins(tree) {
  remarkInteractiveCells({ root: '/repo' })(tree, { path: '/repo/content/docs/page.mdx' });
  remarkMermaidDiagrams()(tree);
}

function runtimeImportNode(tree, source) {
  return tree.children.find((node) =>
    node?.data?.estree?.body?.some(
      (declaration) => declaration.type === 'ImportDeclaration' && declaration.source.value === source
    )
  );
}

function runtimeImportLocal(tree, source) {
  const declaration = runtimeImportNode(tree, source).data.estree.body.find(
    (candidate) => candidate.type === 'ImportDeclaration' && candidate.source.value === source
  );
  return declaration.specifiers[0].local.name;
}

function cellImportLocals(tree) {
  return runtimeImportNode(tree, 'oxiquill/runtime/InteractiveCell')
    .data.estree.body.filter((declaration) => declaration.source.value.startsWith('virtual:oxiquill/cell?'))
    .map((declaration) => declaration.specifiers[0].local.name);
}

function transformedElements(tree, clientDirective) {
  return tree.children.filter(
    (node) =>
      node?.type === 'mdxJsxFlowElement' && node.attributes.some((attribute) => attribute.name === clientDirective)
  );
}

function expectInjectedBindingsAgree(tree, componentSource, clientDirective) {
  const importNode = runtimeImportNode(tree, componentSource);
  const localNames = importNode.data.estree.body.map((declaration) => declaration.specifiers[0].local.name);

  localNames.forEach((name) => expect(importNode.value).toContain(name));

  const elements = transformedElements(tree, clientDirective);
  elements.forEach((element, index) => {
    expect(element.name).toBe(localNames[0]);
    if (clientDirective !== 'client:visible') return;

    const expression = element.attributes.find((attribute) => attribute.name === 'cell').value;
    expect(expression.value).toBe(localNames[index + 1]);
    expect(expression.data.estree.body[0].expression.name).toBe(localNames[index + 1]);
  });
}
