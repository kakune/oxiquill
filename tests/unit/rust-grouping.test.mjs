// @vitest-environment node
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import {
  assignRustGroups,
  describeRustGroup,
  rustDocsPagePath,
  rustGroupId,
  rustGroupMode,
  rustGroupPackage,
  rustPageKey
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-grouping.mjs';

const paths = createOxiquillPaths({ workspaceRoot: path.resolve('/book') });
const cell = (page, id = 'cell') => ({
  id: `${page.replaceAll('/', '__').replace(/\.mdx$/u, '')}__${id}`,
  pagePath: `content/docs/${page}`
});

describe('Rust group keys', () => {
  it('derives page, directory, and site keys from docs-relative POSIX paths', () => {
    expect(rustPageKey('guides/a.mdx', 'page')).toEqual({ mode: 'page', key: 'guides/a.mdx' });
    expect(rustPageKey('index.mdx', 'directory')).toEqual({ mode: 'directory', key: '.' });
    expect(rustPageKey('guides/deep/a.mdx', 'directory')).toEqual({ mode: 'directory', key: 'guides/deep' });
    expect(rustPageKey('ja/guides/a.mdx', 'directory')).toEqual({ mode: 'directory', key: 'ja/guides' });
    expect(rustPageKey('ja/guides/a.mdx', 'site')).toEqual({ mode: 'site', key: 'site' });
    expect(rustGroupMode(() => 'x')).toBe('custom');
    expect(() => rustGroupMode('pages')).toThrow("'page', 'directory', 'site', or a function");
  });

  it('normalizes locale-prefixed paths and Unicode forms', () => {
    const nfd = 'ja/ガイド/a.mdx'.normalize('NFD');
    expect(rustDocsPagePath(`content/docs/${nfd}`, paths)).toBe('ja/ガイド/a.mdx'.normalize('NFC'));
    expect(rustPageKey('a.mdx', () => 'カ\u3099')).toEqual({ mode: 'custom', key: 'ガ' });
  });

  it('validates function results with the page path in the error', () => {
    for (const [result, message] of [
      [undefined, 'a value of type undefined'],
      [null, 'null'],
      ['', 'an empty string'],
      [['a'], 'an array'],
      ['x'.repeat(257), 'a string of 257 characters'],
      ['\uD800', 'a string with unpaired surrogates'],
      [Promise.resolve('a'), 'returned a promise']
    ])
      expect(() => rustPageKey('guides/a.mdx', () => result)).toThrow(
        new RegExp(`${message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}.*guides/a\\.mdx|guides/a\\.mdx.*${message}`, 'u')
      );
    expect(rustPageKey('a.mdx', () => '界'.repeat(256)).key).toHaveLength(256);
    expect(() =>
      rustPageKey('guides/a.mdx', () => {
        throw new Error('boom');
      })
    ).toThrow('rust.grouping function failed for page guides/a.mdx: boom');
    expect(() =>
      rustPageKey('guides/a.mdx', () => {
        throw 'plain';
      })
    ).toThrow('plain');
  });

  it('uses short lowercase ids and crate names that are valid on every file system', () => {
    const id = rustGroupId('directory', 'Guides/Ünïcode');
    expect(id).toMatch(/^directory-[a-f0-9]{16}$/u);
    expect(rustGroupId('directory', 'guides/ünïcode')).not.toBe(id);
    expect(rustGroupPackage('page-0123456789abcdef')).toEqual({
      packageName: 'doc-rust-page-0123456789abcdef',
      crateName: 'doc_rust_page_0123456789abcdef'
    });
  });
});

describe('Rust group assignment', () => {
  it('calls the grouping function once per page and merges pages across directories', () => {
    const grouping = vi.fn(({ path: pagePath }) => (pagePath.endsWith('a.mdx') ? 'a' : 'rest'));
    const cells = [
      cell('guides/a.mdx', 'one'),
      cell('guides/a.mdx', 'two'),
      cell('ja/guides/a.mdx'),
      cell('index.mdx'),
      cell('reference/b.mdx')
    ];
    const groups = assignRustGroups({ cells: [...cells].reverse(), paths, grouping });
    expect(grouping).toHaveBeenCalledTimes(4);
    expect(Object.isFrozen(grouping.mock.calls[0][0])).toBe(true);
    expect(groups.map(({ key, pages }) => [key, pages])).toEqual(
      [
        ['a', ['guides/a.mdx', 'ja/guides/a.mdx']],
        ['rest', ['index.mdx', 'reference/b.mdx']]
      ].sort((left, right) => (rustGroupId('custom', left[0]) < rustGroupId('custom', right[0]) ? -1 : 1))
    );
    const first = groups.find((group) => group.key === 'a');
    expect(first.cells.map((entry) => entry.id)).toEqual(['guides__a__one', 'guides__a__two', 'ja__guides__a__cell']);
    expect(first.sourceDir).toBe(path.join(paths.rustCellsDir, 'modules', first.id));
    expect(describeRustGroup(first)).toBe(`${first.id} (guides/a.mdx, ja/guides/a.mdx)`);
    expect(describeRustGroup({ id: 'x', pages: ['a', 'b', 'c', 'd'] })).toBe('x (a, b, c, and 1 more)');
  });

  it('is independent of cell order and gives each page exactly one group', () => {
    const cells = ['guides/a.mdx', 'guides/b.mdx', 'index.mdx'].map((page) => cell(page));
    const forward = assignRustGroups({ cells, paths, grouping: 'directory' });
    expect(assignRustGroups({ cells: [...cells].reverse(), paths, grouping: 'directory' })).toEqual(forward);
    expect(forward.flatMap((group) => group.pages).sort()).toEqual(['guides/a.mdx', 'guides/b.mdx', 'index.mdx']);
  });

  it('rejects distinct keys that map to one module id', () => {
    const cells = [cell('a.mdx'), cell('b.mdx')];
    expect(() => assignRustGroups({ cells, paths, groupId: () => 'page-0000000000000000' })).toThrow(
      'Rust group keys "a.mdx" and "b.mdx" map to the same module id page-0000000000000000'
    );
  });
});
