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

    expect(tree.children[0].value).toContain('import InteractiveCell');
    expect(tree.children[1]).toMatchObject({
      type: 'paragraph'
    });
    expect(tree.children[2]).toMatchObject({
      type: 'mdxJsxFlowElement',
      name: 'InteractiveCell',
      attributes: [
        { type: 'mdxJsxAttribute', name: 'client:load', value: null },
        { type: 'mdxJsxAttribute', name: 'cellId', value: 'page__rust-one' }
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

    expect(tree.children[0].value).toBe(
      "import InteractiveCell from 'oxiquill/runtime/InteractiveCell';"
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

    expect(tree.children[0].value).toBe(
      "import InteractiveCell from 'oxiquill/runtime/InteractiveCell';"
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

    expect(() => remarkInteractiveCells({ root: '/repo' })(tree, {
      path: '/repo/content/docs/page.mdx'
    })).toThrow('content/docs/page.mdx:9 [cell "Bad.id"] id:');
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

    expect(() => remarkInteractiveCells({ root: '/repo' })(tree, {
      path: '/repo/content/docs/page.mdx'
    })).toThrow('content/docs/page.mdx:5 [cell "repeated"] id: Duplicate page-local cell id');
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

    expect(tree.children[0].value).toContain('import MermaidDiagram');
    expect(tree.children[1]).toMatchObject({
      type: 'mdxJsxFlowElement',
      name: 'MermaidDiagram',
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

    expect(tree.children[0].value).toBe(
      "import MermaidDiagram from 'oxiquill/runtime/MermaidDiagram';"
    );
  });

  it('keeps package-stable Mermaid imports for non-docs files', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'code', lang: 'mermaid', value: 'flowchart LR\nA-->B' }]
    };

    remarkMermaidDiagrams({ root: '/repo' })(tree, {
      path: '/repo/src/components/doc-runtime/example.mdx'
    });

    expect(tree.children[0].value).toBe(
      "import MermaidDiagram from 'oxiquill/runtime/MermaidDiagram';"
    );
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

describe('remark public asset base', () => {
  it('prefixes public media URLs with the configured base path', () => {
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
  });

  it('leaves URLs unchanged when no base path is configured', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'image', url: '/media/examples/sample.png' }]
    };

    remarkPublicAssetBase()(tree);

    expect(tree.children[0].url).toBe('/media/examples/sample.png');
  });

  it('does not double-prefix public media URLs', () => {
    expect(withPublicAssetBase('/oxiquill/media/examples/sample.png', '/oxiquill')).toBe(
      '/oxiquill/media/examples/sample.png'
    );
  });
});
