// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { checkMarkdownStructure } from '../docs/markdown-structure.mjs';

describe('Markdown structure validation', () => {
  it('accepts escaped table content and ignores fenced examples', () => {
    const source = [
      '# Reference',
      '',
      '| Command | Behavior |',
      '| ------- | -------- |',
      '| `--wasm dev \\| build` | Builds the runtime. |',
      '',
      '```md',
      '# Reference',
      '| `dev | build` |',
      '```',
      ''
    ].join('\n');

    expect(() => checkMarkdownStructure('valid.md', source)).not.toThrow();
  });

  it('rejects duplicate heading slugs', () => {
    expect(() => checkMarkdownStructure('duplicate.md', '## Contributing\n\n## Contributing!\n')).toThrow(
      'duplicates heading'
    );
  });

  it('rejects inconsistent table column counts', () => {
    const source = ['| Command | Behavior |', '| ------- | -------- |', '| `build` |', ''].join('\n');

    expect(() => checkMarkdownStructure('columns.md', source)).toThrow('has 1 table columns; expected 2');
  });

  it('rejects unescaped table separators inside inline code', () => {
    const source = [
      '| Command | Behavior |',
      '| ------- | -------- |',
      '| `--wasm dev | build` | Builds the runtime. |',
      ''
    ].join('\n');

    expect(() => checkMarkdownStructure('separator.md', source)).toThrow('unescaped table separator');
  });
});
