import { describe, expect, it } from 'vitest';
import { togglePresentation } from '../../packages/oxiquill/src/components/starlight/toggle-localization';

describe('togglePresentation', () => {
  it.each(['ja', 'ja-JP', 'JA-jp', 'ja_JP'])('uses the primary Japanese language subtag for %s', (language) => {
    expect(togglePresentation(language, 'ltr', 'tableOfContents')).toMatchObject({
      collapseLabel: '目次を折りたたむ',
      expandLabel: '目次を展開する'
    });
  });

  it('falls back to English labels', () => {
    expect(togglePresentation('en-US', 'ltr', 'tableOfContents')).toMatchObject({
      collapseLabel: 'Collapse table of contents',
      expandLabel: 'Expand table of contents'
    });
  });

  it('points collapse controls toward the correct logical edge in LTR and RTL layouts', () => {
    expect(togglePresentation('en', 'ltr', 'sidebar')).toMatchObject({
      collapseIcon: 'left-arrow',
      expandIcon: 'right-arrow'
    });
    expect(togglePresentation('en', 'ltr', 'tableOfContents')).toMatchObject({
      collapseIcon: 'right-arrow',
      expandIcon: 'left-arrow'
    });
    expect(togglePresentation('en', 'rtl', 'sidebar')).toMatchObject({
      collapseIcon: 'right-arrow',
      expandIcon: 'left-arrow'
    });
    expect(togglePresentation('en', 'rtl', 'tableOfContents')).toMatchObject({
      collapseIcon: 'left-arrow',
      expandIcon: 'right-arrow'
    });
  });
});
