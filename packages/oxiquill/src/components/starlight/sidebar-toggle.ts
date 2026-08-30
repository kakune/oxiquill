import { createPersistentToggle } from './persistent-toggle.js';

const SidebarToggleElement = createPersistentToggle({
  collapsedAttribute: 'data-sidebar-collapsed',
  defaultCollapseLabel: 'Collapse sidebar',
  defaultExpandLabel: 'Expand sidebar',
  mediaQuery: '(min-width: 50rem)',
  storageKey: 'oxiquill-sidebar-collapsed'
});

export class StarlightSidebarToggle extends SidebarToggleElement {}

export function defineStarlightSidebarToggle(): void {
  if (!customElements.get('starlight-sidebar-toggle')) {
    customElements.define('starlight-sidebar-toggle', StarlightSidebarToggle);
  }
}
