import { createPersistentToggle } from './persistent-toggle.js';

const TableOfContentsToggleElement = createPersistentToggle({
  collapsedAttribute: 'data-table-of-contents-collapsed',
  defaultCollapseLabel: 'Collapse table of contents',
  defaultExpandLabel: 'Expand table of contents',
  mediaQuery: '(min-width: 72rem)',
  storageKey: 'oxiquill-table-of-contents-collapsed'
});

export class StarlightTableOfContentsToggle extends TableOfContentsToggleElement {}

export function defineStarlightTableOfContentsToggle(): void {
  if (!customElements.get('starlight-table-of-contents-toggle')) {
    customElements.define('starlight-table-of-contents-toggle', StarlightTableOfContentsToggle);
  }
}
