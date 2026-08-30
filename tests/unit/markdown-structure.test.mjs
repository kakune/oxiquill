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
    const source = '# Guide\n\n## Contributing\n\n## Contributing!\n';
    expect(() => checkMarkdownStructure('duplicate.md', source)).toThrow('duplicates heading');
  });

  it('allows conventional subsection names under different parent headings', () => {
    const source = '# Changelog\n\n## Unreleased\n\n### Added\n\n## 0.3.0\n\n### Added\n';
    expect(() => checkMarkdownStructure('CHANGELOG.md', source)).not.toThrow();
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
