import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineStarlightTableOfContentsToggle } from '../../packages/oxiquill/src/components/starlight/table-of-contents-toggle';

type TestMediaQuery = MediaQueryList & {
  listeners: Set<(event: MediaQueryListEvent) => void>;
};

function createMediaQuery(matches = true): TestMediaQuery {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  return {
    matches,
    media: '(min-width: 72rem)',
    onchange: null,
    listeners,
    addEventListener: vi.fn((_type, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  } as unknown as TestMediaQuery;
}

function tableOfContentsMarkup(
  collapse = 'Collapse table of contents',
  expand = 'Expand table of contents'
): HTMLElement {
  const toggle = document.createElement('starlight-table-of-contents-toggle');
  toggle.dataset.collapseLabel = collapse;
  toggle.dataset.expandLabel = expand;
  toggle.innerHTML = '<button type="button" aria-controls="test-table-of-contents"></button>';
  return toggle;
}

describe('StarlightTableOfContentsToggle', () => {
  let mediaQuery: TestMediaQuery;

  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-sidebar-collapsed');
    document.documentElement.removeAttribute('data-table-of-contents-collapsed');
    sessionStorage.clear();
    mediaQuery = createMediaQuery();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaQuery)
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('toggles an independent persisted state and accessible disclosure attributes', () => {
    const tableOfContents = document.createElement('aside');
    tableOfContents.id = 'test-table-of-contents';
    const toggle = tableOfContentsMarkup();
    document.body.append(tableOfContents, toggle);

    defineStarlightTableOfContentsToggle();

    const button = toggle.querySelector('button') as HTMLButtonElement;
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-label', 'Collapse table of contents');

    button.click();

    expect(document.documentElement).toHaveAttribute('data-table-of-contents-collapsed');
    expect(document.documentElement).not.toHaveAttribute('data-sidebar-collapsed');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-label', 'Expand table of contents');
    expect(button).toHaveAttribute('title', 'Expand table of contents');
    expect(tableOfContents).toHaveAttribute('aria-hidden', 'true');
    expect(tableOfContents).toHaveAttribute('inert');
    expect(sessionStorage.getItem('oxiquill-table-of-contents-collapsed')).toBe('true');
    expect(sessionStorage.getItem('oxiquill-sidebar-collapsed')).toBeNull();

    button.click();

    expect(document.documentElement).not.toHaveAttribute('data-table-of-contents-collapsed');
    expect(tableOfContents).not.toHaveAttribute('aria-hidden');
    expect(tableOfContents).not.toHaveAttribute('inert');
    expect(sessionStorage.getItem('oxiquill-table-of-contents-collapsed')).toBeNull();
  });

  it('restores storage on reconnect without duplicate listeners', () => {
    defineStarlightTableOfContentsToggle();
    sessionStorage.setItem('oxiquill-table-of-contents-collapsed', 'true');
    const tableOfContents = document.createElement('aside');
    tableOfContents.id = 'test-table-of-contents';
    const toggle = tableOfContentsMarkup('目次を折りたたむ', '目次を展開する');
    document.body.append(tableOfContents, toggle);

    expect(mediaQuery.listeners).toHaveLength(1);
    expect(document.documentElement).toHaveAttribute('data-table-of-contents-collapsed');
    expect(toggle.querySelector('button')).toHaveAttribute('aria-label', '目次を展開する');

    toggle.remove();
    expect(mediaQuery.listeners).toHaveLength(0);
    document.body.append(toggle);

    expect(mediaQuery.listeners).toHaveLength(1);
    expect(toggle.querySelector('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the mobile table of contents interactive and restores focus before a desktop collapse', () => {
    defineStarlightTableOfContentsToggle();
    Object.defineProperty(mediaQuery, 'matches', { configurable: true, value: false });
    sessionStorage.setItem('oxiquill-table-of-contents-collapsed', 'true');
    const tableOfContents = document.createElement('aside');
    tableOfContents.id = 'test-table-of-contents';
    const link = document.createElement('a');
    link.href = '#heading';
    tableOfContents.append(link);
    const toggle = tableOfContentsMarkup();
    document.body.append(tableOfContents, toggle);

    const button = toggle.querySelector('button') as HTMLButtonElement;
    expect(document.documentElement).not.toHaveAttribute('data-table-of-contents-collapsed');
    expect(tableOfContents).not.toHaveAttribute('inert');
    expect(button).toHaveAttribute('aria-expanded', 'true');

    link.focus();
    Object.defineProperty(mediaQuery, 'matches', { configurable: true, value: true });
    mediaQuery.listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));

    expect(button).toHaveFocus();
    expect(tableOfContents).toHaveAttribute('inert');
  });

  it('ignores malformed or missing table-of-contents markup', () => {
    defineStarlightTableOfContentsToggle();
    const malformed = document.createElement('starlight-table-of-contents-toggle');

    expect(() => document.body.append(malformed)).not.toThrow();
    expect(mediaQuery.listeners).toHaveLength(0);
  });
});
