type Direction = 'ltr' | 'rtl';
type ToggleTarget = 'sidebar' | 'tableOfContents';
type ArrowIcon = 'left-arrow' | 'right-arrow';

interface TogglePresentation {
  collapseIcon: ArrowIcon;
  collapseLabel: string;
  expandIcon: ArrowIcon;
  expandLabel: string;
}

const labels = {
  en: {
    sidebar: { collapse: 'Collapse sidebar', expand: 'Expand sidebar' },
    tableOfContents: { collapse: 'Collapse table of contents', expand: 'Expand table of contents' }
  },
  ja: {
    sidebar: { collapse: 'サイドバーを折りたたむ', expand: 'サイドバーを展開する' },
    tableOfContents: { collapse: '目次を折りたたむ', expand: '目次を展開する' }
  }
} as const;

export function togglePresentation(lang: string, direction: Direction, target: ToggleTarget): TogglePresentation {
  const primaryLanguage = lang.trim().split(/[-_]/u)[0]?.toLowerCase();
  const localizedLabels = primaryLanguage === 'ja' ? labels.ja[target] : labels.en[target];
  const collapseIcon =
    target === 'sidebar'
      ? direction === 'rtl'
        ? 'right-arrow'
        : 'left-arrow'
      : direction === 'rtl'
        ? 'left-arrow'
        : 'right-arrow';

  return {
    collapseIcon,
    collapseLabel: localizedLabels.collapse,
    expandIcon: collapseIcon === 'left-arrow' ? 'right-arrow' : 'left-arrow',
    expandLabel: localizedLabels.expand
  };
}
