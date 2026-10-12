// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseCellsFromMarkdown,
  extractCellsFromMarkdown
} from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';
import { resolvePythonSetups } from '../../packages/oxiquill/src/lib/doc-runtime/cell-authoring.mjs';
import {
  summarizeCells,
  createRuntimeVersion
} from '../../packages/oxiquill/src/generator/doc-runtime/runtime-summary.mjs';
import { createOxiquillIntegrationMetadata } from '../../packages/oxiquill/src/config/metadata.mjs';

const pythonOptions = { experimentalSetup: true };
const fence = (id, directives = '', source = 'x = 1', language = 'python') =>
  `\n\`\`\`${language}\n${language === 'python' ? '#|' : '--|'} id: ${id}\n${directives}${source}\n\`\`\`\n`;
const parse = (source, page = 'page.mdx') => parseCellsFromMarkdown(source, page, pythonOptions);

describe('Python setup authoring', () => {
  it('requires explicit opt-in and a single local Python reference', () => {
    const source = fence('body', '#| setup: common\n');
    expect(parseCellsFromMarkdown(source, 'page.mdx').diagnostics[0].message).toContain('experimentalSetup');
    for (const reference of ['[common]', 'other/common', 'null', '42'])
      expect(parse(fence('body', `#| setup: ${reference}\n`)).diagnostics).not.toEqual([]);
    expect(parse(fence('body', '--| setup: common\n', 'pure ()', 'haskell')).diagnostics).not.toEqual([]);
    expect(() => createOxiquillIntegrationMetadata({ python: { experimentalSetup: 'yes' } })).toThrow(
      'must be a boolean'
    );
  });
  it('resolves chains, merges packages, and includes source and timeout changes in identities', async () => {
    const source =
      fence('base', '#| packages: [numpy]\n#| timeoutMs: 1000\n') +
      fence('common', '#| setup: base\n#| timeoutMs: 2000\n', 'values = [1, 2]') +
      fence('body', '#| setup: common\n');
    const context = { pythonOptions, helperCrates: new Map(), highlighter: { codeToHtml: async () => '<pre />' } };
    const cells = await extractCellsFromMarkdown(source, 'page.mdx', context);
    expect(cells[2].setup.map((step) => step.id)).toEqual(['page__base', 'page__common']);
    expect(cells[2].packages).toEqual(['numpy']);
    expect(cells[2].setup[1]).toMatchObject({ source: 'values = [1, 2]', timeoutMs: 2000 });
    const version = createRuntimeVersion(summarizeCells(cells));
    for (const modified of [source.replace('x = 1', 'x = 2'), source.replace('2000', '2001')]) {
      expect(
        createRuntimeVersion(summarizeCells(await extractCellsFromMarkdown(modified, 'page.mdx', context)))
      ).not.toBe(version);
    }
  });
  it('rejects missing, cross-page, cyclic, non-Python, and input-bearing references', () => {
    const body = parse(fence('body', '#| setup: common\n')).cells;
    expect(() => resolvePythonSetups(body)).toThrow('does not exist on this page');
    expect(() => resolvePythonSetups([...body, ...parse(fence('common'), 'other.mdx').cells])).toThrow(
      'does not exist on this page'
    );
    for (const source of [
      fence('common', '#| inputs:\n#|   x: { type: number, value: 1 }\n'),
      fence('common', '', 'pure ()', 'haskell')
    ]) {
      expect(() => resolvePythonSetups([...body, ...parse(source).cells])).toThrow('without inputs');
    }
    expect(() => resolvePythonSetups(parse(fence('common', '#| setup: common\n')).cells)).toThrow('Cyclic');
    expect(() =>
      resolvePythonSetups(parse(fence('common', '#| setup: body\n') + fence('body', '#| setup: common\n')).cells)
    ).toThrow('Cyclic');
    expect(() =>
      resolvePythonSetups(
        parse(fence('common', '#| timeoutMs: 2147483647\n') + fence('body', '#| setup: common\n')).cells
      )
    ).toThrow('Combined setup');
  });
});
