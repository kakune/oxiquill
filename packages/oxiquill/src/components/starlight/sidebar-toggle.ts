const storageKey = 'oxiquill-sidebar-collapsed';
const desktopMediaQuery = '(min-width: 50rem)';

export class StarlightSidebarToggle extends HTMLElement {
  private button?: HTMLButtonElement;
  private collapseLabel = 'Collapse sidebar';
  private desktopQuery?: MediaQueryList;
  private expandLabel = 'Expand sidebar';
  private listening = false;
  private sidebar?: HTMLElement;

  connectedCallback(): void {
    this.removeListeners();

    const button = this.querySelector('button');
    const sidebarId = button?.getAttribute('aria-controls');
    const sidebar = sidebarId ? document.getElementById(sidebarId) : null;
    if (!(button instanceof HTMLButtonElement) || !sidebar) return;

    this.button = button;
    this.sidebar = sidebar;
    this.collapseLabel = this.dataset.collapseLabel || 'Collapse sidebar';
    this.expandLabel = this.dataset.expandLabel || 'Expand sidebar';
    this.desktopQuery = matchMedia(desktopMediaQuery);
    this.button.addEventListener('click', this.toggleCollapsed);
    this.desktopQuery.addEventListener('change', this.applyStoredState);
    this.listening = true;
    this.applyStoredState();
  }

  disconnectedCallback(): void {
    this.removeListeners();
  }

  private readonly applyStoredState = (): void => {
    this.setCollapsed(this.getStoredCollapsed());
  };

  private readonly toggleCollapsed = (): void => {
    if (!this.desktopQuery?.matches) return;
    const nextCollapsed = !document.documentElement.hasAttribute('data-sidebar-collapsed');
    this.storeCollapsed(nextCollapsed);
    this.setCollapsed(nextCollapsed);
  };

  private getStoredCollapsed(): boolean {
    try {
      return sessionStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  }

  private storeCollapsed(collapsed: boolean): void {
    try {
      if (collapsed) {
        sessionStorage.setItem(storageKey, 'true');
      } else {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      // Storage can be unavailable in privacy-restricted browsing contexts.
    }
  }

  private setCollapsed(collapsed: boolean): void {
    if (!this.button || !this.sidebar || !this.desktopQuery) return;

    const active = this.desktopQuery.matches && collapsed;
    const label = active ? this.expandLabel : this.collapseLabel;
    document.documentElement.toggleAttribute('data-sidebar-collapsed', active);
    if (active) {
      document.documentElement.style.setProperty('--sl-content-inline-start', '0rem');
      document.documentElement.style.setProperty(
        '--sl-content-width',
        'calc(var(--oq-sidebar-base-content-width) + var(--sl-sidebar-width))'
      );
    } else {
      document.documentElement.style.removeProperty('--sl-content-inline-start');
      document.documentElement.style.removeProperty('--sl-content-width');
    }
    this.button.setAttribute('aria-expanded', String(!active));
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
    if (active) {
      this.sidebar.setAttribute('aria-hidden', 'true');
    } else {
      this.sidebar.removeAttribute('aria-hidden');
    }
    this.sidebar.toggleAttribute('inert', active);
  }

  private removeListeners(): void {
    if (this.listening) {
      this.button?.removeEventListener('click', this.toggleCollapsed);
      this.desktopQuery?.removeEventListener('change', this.applyStoredState);
    }
    this.listening = false;
    this.button = undefined;
    this.desktopQuery = undefined;
    this.sidebar = undefined;
  }
}

export function defineStarlightSidebarToggle(): void {
  if (!customElements.get('starlight-sidebar-toggle')) {
    customElements.define('starlight-sidebar-toggle', StarlightSidebarToggle);
  }
}
