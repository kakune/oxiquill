interface PersistentToggleOptions {
  collapsedAttribute: string;
  defaultCollapseLabel: string;
  defaultExpandLabel: string;
  mediaQuery: string;
  storageKey: string;
}

export function createPersistentToggle(options: PersistentToggleOptions): typeof HTMLElement {
  return class PersistentToggle extends HTMLElement {
    private button?: HTMLButtonElement;
    private collapseLabel = options.defaultCollapseLabel;
    private controlledElement?: HTMLElement;
    private expandLabel = options.defaultExpandLabel;
    private listening = false;
    private mediaQuery?: MediaQueryList;

    connectedCallback(): void {
      this.removeListeners();

      const button = this.querySelector('button');
      const controlledId = button?.getAttribute('aria-controls');
      const controlledElement = controlledId ? document.getElementById(controlledId) : null;
      if (!(button instanceof HTMLButtonElement) || !controlledElement) return;

      this.button = button;
      this.controlledElement = controlledElement;
      this.collapseLabel = this.dataset.collapseLabel || options.defaultCollapseLabel;
      this.expandLabel = this.dataset.expandLabel || options.defaultExpandLabel;
      this.mediaQuery = matchMedia(options.mediaQuery);
      this.button.addEventListener('click', this.toggleCollapsed);
      this.mediaQuery.addEventListener('change', this.applyStoredState);
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
      if (!this.mediaQuery?.matches) return;
      const nextCollapsed = !document.documentElement.hasAttribute(options.collapsedAttribute);
      this.storeCollapsed(nextCollapsed);
      this.setCollapsed(nextCollapsed);
    };

    private getStoredCollapsed(): boolean {
      try {
        return sessionStorage.getItem(options.storageKey) === 'true';
      } catch {
        return false;
      }
    }

    private storeCollapsed(collapsed: boolean): void {
      try {
        if (collapsed) {
          sessionStorage.setItem(options.storageKey, 'true');
        } else {
          sessionStorage.removeItem(options.storageKey);
        }
      } catch {
        // Storage can be unavailable in privacy-restricted browsing contexts.
      }
    }

    private setCollapsed(collapsed: boolean): void {
      if (!this.button || !this.controlledElement || !this.mediaQuery) return;

      const active = this.mediaQuery.matches && collapsed;
      const label = active ? this.expandLabel : this.collapseLabel;
      if (active && this.controlledElement.contains(document.activeElement)) this.button.focus();
      document.documentElement.toggleAttribute(options.collapsedAttribute, active);
      this.button.setAttribute('aria-expanded', String(!active));
      this.button.setAttribute('aria-label', label);
      this.button.title = label;
      if (active) {
        this.controlledElement.setAttribute('aria-hidden', 'true');
      } else {
        this.controlledElement.removeAttribute('aria-hidden');
      }
      this.controlledElement.toggleAttribute('inert', active);
    }

    private removeListeners(): void {
      if (this.listening) {
        this.button?.removeEventListener('click', this.toggleCollapsed);
        this.mediaQuery?.removeEventListener('change', this.applyStoredState);
      }
      this.listening = false;
      this.button = undefined;
      this.controlledElement = undefined;
      this.mediaQuery = undefined;
    }
  };
}
