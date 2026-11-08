import type { RuntimeLocale } from './runtime-localization.js';

const labels = {
  en: {
    title: '3D scene',
    loading: 'Loading 3D scene…',
    controls: 'Controls',
    instructions:
      'Drag to orbit; wheel or pinch to zoom. Arrow keys rotate 15°, +/− zoom, and 0 resets the authored camera. Select two points in the view or table to measure a distance.',
    reset: 'Reset view',
    points: 'Points',
    edges: 'Edges',
    columns: { id: 'ID', label: 'Label', group: 'Group', from: 'From', to: 'To' },
    data: 'Show data as tables',
    select: 'Select point',
    ungrouped: 'Ungrouped',
    empty: 'No visible points.',
    unavailable: 'Canvas unavailable; use the points table to inspect and select points.',
    distance: 'Distance',
    units: 'distance unavailable: axes use different or undeclared units',
    overflow: 'distance exceeds numeric range',
    selection: 'Selected points',
    loadError: 'Unable to load 3D scene',
    exportError: 'Unable to export 3D scene',
    retry: 'Retry'
  },
  ja: {
    title: '3D シーン',
    loading: '3D シーンを読み込み中…',
    controls: '操作方法',
    instructions:
      'ドラッグで回転、ホイールまたはピンチで拡大・縮小します。矢印キーで15°回転、+/−で拡大・縮小、0で初期カメラに戻します。距離を測るには、ビューまたは表で2点を選択してください。',
    reset: 'ビューをリセット',
    points: '点',
    edges: '辺',
    columns: { id: 'ID', label: 'ラベル', group: 'グループ', from: '始点', to: '終点' },
    data: 'データを表で表示',
    select: '点を選択',
    ungrouped: 'グループなし',
    empty: '表示する点がありません。',
    unavailable: 'Canvas を利用できません。点の表で値の確認と点の選択ができます。',
    distance: '距離',
    units: '距離を計算できません：軸の単位が異なるか未指定です',
    overflow: '距離が数値範囲を超えています',
    selection: '選択した点',
    loadError: '3D シーンを読み込めません',
    exportError: '3D シーンを出力できません',
    retry: '再試行'
  }
} as const;

export function scene3dLabels(locale: RuntimeLocale) {
  return labels[locale];
}
