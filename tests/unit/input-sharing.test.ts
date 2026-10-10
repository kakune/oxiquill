import { afterEach, describe, expect, it } from 'vitest';
import {
  createInputShareUrl,
  parseSharedInputs,
  registerSharedInputs,
  restoreSharedInputs,
  sharedInputMetadata
} from '../../packages/oxiquill/src/lib/doc-runtime/input-sharing';
import type { CellManifest } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import { parseInteractiveCellNode } from '../../packages/oxiquill/src/lib/doc-runtime/cell-authoring.mjs';

const cell: Pick<CellManifest, 'id' | 'inputs' | 'pagePath'> = {
  id: 'ja__page__example',
  pagePath: 'content/docs/ja/page.mdx',
  inputs: [
    { name: 'count', type: 'integer', label: 'Count', value: 2, min: 0, max: 10, step: 2, share: true, options: [] },
    { name: 'text', type: 'text', label: 'Text', value: '', share: true, options: [] },
    { name: 'private', type: 'text', label: 'Private', value: 'default', options: [] },
    { name: 'choice', type: 'select', label: 'Choice', value: 'a', share: true, options: [{ label: 'A', value: 'a' }] }
  ]
};
const link = (values: unknown, v = 1) =>
  `https://example.com/base/ja/page/?q=keep&oxiquill-inputs=${encodeURIComponent(JSON.stringify({ v, cells: { [cell.id]: values, other: { count: 4 } } }))}#heading`;

afterEach(() => {
  document.body.replaceChildren();
});

describe('input sharing', () => {
  it('accepts only boolean sharing metadata', () => {
    const parse = (share: string) =>
      parseInteractiveCellNode(
        {
          type: 'code',
          lang: 'python',
          value: `#| id: shared\n#| inputs:\n#|   count: { type: integer, value: 2, share: ${share} }\nprint(count)`
        },
        'page.mdx'
      );
    expect(parse('true')).toMatchObject({ kind: 'cell', cell: { inputs: [{ share: true }] } });
    expect(parse('false')).toMatchObject({ kind: 'cell' });
    expect(parse('"true"')).toMatchObject({ kind: 'invalid' });
  });
  it('restores only opted-in valid inputs and preserves Unicode', () => {
    expect(
      restoreSharedInputs(cell, link({ count: 4, text: '日本語 🌸', private: 'secret', unknown: 1, choice: 'removed' }))
    ).toEqual({ count: 4, text: '日本語 🌸', private: 'default', choice: 'a' });
    for (const value of [-2, 3, 12, '4', null, false, {}, 2147483648]) {
      expect(restoreSharedInputs(cell, link({ count: value })).count).toBe(2);
    }
  });
  it('ignores unsupported, malformed, duplicate, and excessive URLs', () => {
    for (const href of [
      link({ count: 4 }, 2),
      'invalid',
      'https://example.com/?oxiquill-inputs={',
      link({ text: 'x'.repeat(8192) }),
      `${link({ count: 4 }).split('#')[0]}&oxiquill-inputs={}`
    ]) {
      expect(parseSharedInputs(href)).toEqual({});
      expect(restoreSharedInputs(cell, href).count).toBe(2);
    }
  });
  it('shares differences across hydrated and offscreen cells on the current page', () => {
    const other = { ...cell, id: 'ja__page__second' };
    const foreign = { ...cell, id: 'foreign', pagePath: 'other.mdx' };
    for (const current of [cell, other, foreign]) {
      const element = document.createElement('section');
      element.dataset.shareInputs = sharedInputMetadata(current);
      document.body.append(element);
    }
    const unregister = registerSharedInputs(document.body.children[1], () => ({
      valid: true,
      values: { count: 6, private: 'secret' }
    }));
    const url = new URL(createInputShareUrl(cell.pagePath, link({ count: 4, text: '日本語', private: 'secret' })));
    expect(url.pathname).toBe('/base/ja/page/');
    expect(url.hash).toBe('#heading');
    expect(url.searchParams.get('q')).toBe('keep');
    expect(parseSharedInputs(url.href)).toEqual({ [cell.id]: { count: 4, text: '日本語' }, [other.id]: { count: 6 } });
    unregister();
    expect(parseSharedInputs(createInputShareUrl(cell.pagePath, 'https://example.com/'))).toEqual({});
  });
  it('rejects invalid edits and overlong shares without silently truncating them', () => {
    const element = document.createElement('section');
    element.dataset.shareInputs = sharedInputMetadata(cell);
    document.body.append(element);
    registerSharedInputs(element, () => ({ valid: false, values: { count: 4 } }));
    expect(() => createInputShareUrl(cell.pagePath, 'https://example.com/')).toThrow('invalid inputs');
    registerSharedInputs(element, () => ({ valid: true, values: { text: 'x'.repeat(8192) } }));
    expect(() => createInputShareUrl(cell.pagePath, 'https://example.com/')).toThrow('8192');
  });
});
