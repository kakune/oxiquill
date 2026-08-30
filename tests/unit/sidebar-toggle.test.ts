import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineStarlightSidebarToggle } from '../../packages/oxiquill/src/components/starlight/sidebar-toggle';

type TestMediaQuery = MediaQueryList & {
  listeners: Set<(event: MediaQueryListEvent) => void>;
};

function createMediaQuery(matches = true): TestMediaQuery {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  return {
    matches,
    media: '(min-width: 50rem)',
    onchange: null,
    listeners,
    addEventListener: vi.fn((_type, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  } as unknown as TestMediaQuery;
}

function sidebarMarkup(collapse = 'Collapse sidebar', expand = 'Expand sidebar'): HTMLElement {
  const toggle = document.createElement('starlight-sidebar-toggle');
  toggle.dataset.collapseLabel = collapse;
  toggle.dataset.expandLabel = expand;
  toggle.innerHTML = '<button type="button" aria-controls="test-sidebar"></button>';
  return toggle;
}

describe('StarlightSidebarToggle', () => {
  let mediaQuery: TestMediaQuery;

  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-sidebar-collapsed');
    document.documentElement.removeAttribute('style');
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

  it('upgrades parser-like markup that existed before definition', () => {
    const sidebar = document.createElement('div');
    sidebar.id = 'test-sidebar';
    const toggle = sidebarMarkup();
    document.body.append(sidebar, toggle);

    defineStarlightSidebarToggle();

    const button = toggle.querySelector('button') as HTMLButtonElement;
    expect(button).toHaveAttribute('aria-label', 'Collapse sidebar');
    button.click();
    expect(document.documentElement).toHaveAttribute('data-sidebar-collapsed');
    expect(sidebar).toHaveAttribute('inert');
  });

  it('handles already-defined insertion, malformed markup, and reconnects idempotently', () => {
    defineStarlightSidebarToggle();
    const malformed = document.createElement('starlight-sidebar-toggle');
    expect(() => document.body.append(malformed)).not.toThrow();

    const sidebar = document.createElement('div');
    sidebar.id = 'test-sidebar';
    const toggle = sidebarMarkup('折りたたむ', '展開する');
    document.body.append(sidebar, toggle);
    const firstButton = toggle.querySelector('button') as HTMLButtonElement;
    expect(mediaQuery.listeners).toHaveLength(1);

    toggle.remove();
    expect(mediaQuery.listeners).toHaveLength(0);
    toggle.innerHTML = '<button type="button" aria-controls="test-sidebar"></button>';
    document.body.append(toggle);
    expect(mediaQuery.listeners).toHaveLength(1);
    const replacementButton = toggle.querySelector('button') as HTMLButtonElement;
    replacementButton.click();
    expect(replacementButton).toHaveAttribute('aria-label', '展開する');

    firstButton.click();
    expect(replacementButton).toHaveAttribute('aria-label', '展開する');
  });

  it('applies stored state after a replacement connects', () => {
    defineStarlightSidebarToggle();
    sessionStorage.setItem('oxiquill-sidebar-collapsed', 'true');
    const sidebar = document.createElement('div');
    sidebar.id = 'test-sidebar';
    const toggle = sidebarMarkup();

    document.body.append(sidebar, toggle);

    expect(document.documentElement).toHaveAttribute('data-sidebar-collapsed');
    expect(toggle.querySelector('button')).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  });
});
