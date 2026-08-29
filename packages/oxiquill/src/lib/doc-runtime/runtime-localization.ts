export type RuntimeLocale = 'en' | 'ja';

export type ChartKind = 'area' | 'bar' | 'heatmap' | 'histogram' | 'line' | 'scatter';
export type MermaidDiagramKind =
  'class' | 'diagram' | 'entityRelationship' | 'flowchart' | 'journey' | 'sequence' | 'state' | 'timeline';

export type ChartSummaryDetails = {
  dataCount: number;
  seriesCount: number;
  seriesNames: string;
  xRange?: string;
  yRange?: string;
};

export type RuntimeLabels = {
  locale: RuntimeLocale;
  artifactError: (index: number, detail: string) => string;
  artifactRenderError: (index: number, detail: string) => string;
  cellActions: string;
  cellCompleted: string;
  cellCompletedWithoutOutput: string;
  cellInputs: string;
  cellOutput: (title: string) => string;
  cellRunningAnnouncement: string;
  chartCaption: string;
  chartLoadError: (detail: string) => string;
  chartLoading: string;
  chartSummary: (details: ChartSummaryDetails) => string;
  chartTitle: (kind: ChartKind) => string;
  clipboardUnavailable: string;
  copyCsv: string;
  copyCsvError: (detail: string) => string;
  copyCsvSuccess: string;
  copyingCsv: string;
  diagnosticDetail: (detail: string) => string;
  executionError: (detail: string) => string;
  executionErrorLabel: string;
  hideCode: string;
  htmlOutput: string;
  idleButton: string;
  idleReactive: string;
  imageOutput: string;
  inputMaximum: (maximum: number) => string;
  inputMinimum: (minimum: number) => string;
  inputNumber: string;
  inputStep: string;
  mermaidDescription: (source: string) => string;
  mermaidError: (detail: string) => string;
  mermaidLoading: string;
  mermaidTitle: (kind: MermaidDiagramKind) => string;
  nextPage: string;
  noChartData: string;
  outputTruncated: string;
  previousPage: string;
  rowsPerPage: string;
  rowsRange: (first: number, last: number, total: number, truncated: boolean) => string;
  run: string;
  runtimeLanguage: (language: 'haskell' | 'python' | 'rust') => string;
  running: string;
  runningCell: string;
  showCode: string;
  tableControls: string;
  tableCellTypeError: (type: string) => string;
  tableFiniteNumberError: string;
  tableMissingValue: string;
  tableOutput: string;
  tableRowWidthError: (row: number, received: number, expected: number) => string;
  unknownCell: (cellId: string) => string;
};

const chartTitles = {
  en: {
    area: 'Area chart',
    bar: 'Bar chart',
    heatmap: 'Heatmap',
    histogram: 'Histogram',
    line: 'Line chart',
    scatter: 'Scatter chart'
  },
  ja: {
    area: '面グラフ',
    bar: '棒グラフ',
    heatmap: 'ヒートマップ',
    histogram: 'ヒストグラム',
    line: '折れ線グラフ',
    scatter: '散布図'
  }
} satisfies Record<RuntimeLocale, Record<ChartKind, string>>;

const mermaidTitles = {
  en: {
    class: 'Mermaid class diagram',
    diagram: 'Mermaid diagram',
    entityRelationship: 'Mermaid entity relationship diagram',
    flowchart: 'Mermaid flowchart',
    journey: 'Mermaid journey diagram',
    sequence: 'Mermaid sequence diagram',
    state: 'Mermaid state diagram',
    timeline: 'Mermaid timeline'
  },
  ja: {
    class: 'Mermaid クラス図',
    diagram: 'Mermaid 図',
    entityRelationship: 'Mermaid ER 図',
    flowchart: 'Mermaid フローチャート',
    journey: 'Mermaid ジャーニー図',
    sequence: 'Mermaid シーケンス図',
    state: 'Mermaid 状態遷移図',
    timeline: 'Mermaid タイムライン'
  }
} satisfies Record<RuntimeLocale, Record<MermaidDiagramKind, string>>;

const runtimeLabels = {
  en: {
    locale: 'en',
    artifactError: (index, detail) => `Artifact ${index}: ${detail}`,
    artifactRenderError: (index, detail) => `Artifact ${index} failed to render: ${detail}`,
    cellActions: 'Cell actions',
    cellCompleted: 'Cell completed.',
    cellCompletedWithoutOutput: 'Cell completed without output.',
    cellInputs: 'Cell inputs',
    cellOutput: (title) => `Output for ${title}`,
    cellRunningAnnouncement: 'Cell execution started.',
    chartCaption: 'Chart data summary',
    chartLoadError: (detail) => `Chart renderer could not be loaded: ${detail}`,
    chartLoading: 'Loading chart renderer...',
    chartSummary: ({ dataCount, seriesCount, seriesNames, xRange, yRange }) =>
      `Series: ${seriesCount}${seriesNames ? ` (${seriesNames})` : ''}. Data items: ${dataCount}.${xRange ? ` X range: ${xRange}.` : ''}${yRange ? ` Y range: ${yRange}.` : ''}`,
    chartTitle: (kind) => chartTitles.en[kind],
    clipboardUnavailable: 'Clipboard access is unavailable.',
    copyCsv: 'Copy visible rows as CSV',
    copyCsvError: (detail) => `Unable to copy CSV: ${detail}`,
    copyCsvSuccess: 'Copied visible rows as CSV.',
    copyingCsv: 'Copying CSV…',
    diagnosticDetail: (detail) => detail,
    executionError: (detail) => `Cell execution failed: ${detail}`,
    executionErrorLabel: 'Cell execution failed:',
    hideCode: 'Hide code',
    htmlOutput: 'HTML output',
    idleButton: 'Run the cell to show its output.',
    idleReactive: 'Waiting for the runtime to start.',
    imageOutput: 'Image output',
    inputMaximum: (maximum) => `Enter a value no greater than ${maximum}.`,
    inputMinimum: (minimum) => `Enter a value of at least ${minimum}.`,
    inputNumber: 'Enter a number.',
    inputStep: 'Enter a value that matches the allowed step.',
    mermaidDescription: (source) => `Diagram source: ${boundedDescription(source)}`,
    mermaidError: (detail) => `Mermaid diagram could not be rendered: ${detail}`,
    mermaidLoading: 'Rendering diagram...',
    mermaidTitle: (kind) => mermaidTitles.en[kind],
    nextPage: 'Next page',
    noChartData: 'The chart contains no data.',
    outputTruncated: 'Output truncated.',
    previousPage: 'Previous page',
    rowsPerPage: 'Rows per page',
    rowsRange: (first, last, total, truncated) => `Rows ${first}-${last} of ${total}${truncated ? ' (truncated)' : ''}`,
    run: 'Run',
    runtimeLanguage: runtimeLanguageLabel,
    running: 'Running',
    runningCell: 'Running cell...',
    showCode: 'Show code',
    tableControls: 'Table controls',
    tableCellTypeError: (type) => `Unsupported validated table cell type: ${type}.`,
    tableFiniteNumberError: 'Validated table cells must contain finite numbers.',
    tableMissingValue: 'missing',
    tableOutput: 'Data table',
    tableRowWidthError: (row, received, expected) => `Row ${row} has ${received} cells; expected ${expected}.`,
    unknownCell: (cellId) => `Unknown interactive cell: ${cellId}`
  },
  ja: {
    locale: 'ja',
    artifactError: (index, detail) => `成果物 ${index}: ${detail}`,
    artifactRenderError: (index, detail) => `成果物 ${index} を表示できませんでした: ${detail}`,
    cellActions: 'セルの操作',
    cellCompleted: 'セルの実行が完了しました。',
    cellCompletedWithoutOutput: 'セルの実行が完了しました。出力はありません。',
    cellInputs: 'セルの入力',
    cellOutput: (title) => `${title} の出力`,
    cellRunningAnnouncement: 'セルの実行を開始しました。',
    chartCaption: 'グラフデータの概要',
    chartLoadError: (detail) => `グラフ表示を読み込めませんでした: ${detail}`,
    chartLoading: 'グラフ表示を読み込んでいます…',
    chartSummary: ({ dataCount, seriesCount, seriesNames, xRange, yRange }) =>
      `系列数: ${seriesCount}${seriesNames ? `（${seriesNames}）` : ''}。データ数: ${dataCount}。${xRange ? `X の範囲: ${xRange}。` : ''}${yRange ? `Y の範囲: ${yRange}。` : ''}`,
    chartTitle: (kind) => chartTitles.ja[kind],
    clipboardUnavailable: 'クリップボードを利用できません。',
    copyCsv: '表示中の行を CSV としてコピー',
    copyCsvError: (detail) => `CSV をコピーできませんでした: ${translateDiagnostic(detail)}`,
    copyCsvSuccess: '表示中の行を CSV としてコピーしました。',
    copyingCsv: 'CSV をコピーしています…',
    diagnosticDetail: translateDiagnostic,
    executionError: (detail) => `セルの実行に失敗しました: ${translateDiagnostic(detail)}`,
    executionErrorLabel: 'セルの実行に失敗しました:',
    hideCode: 'コードを隠す',
    htmlOutput: 'HTML 出力',
    idleButton: 'セルを実行すると出力が表示されます。',
    idleReactive: 'ランタイムの起動を待っています。',
    imageOutput: '画像出力',
    inputMaximum: (maximum) => `${maximum} 以下の値を入力してください。`,
    inputMinimum: (minimum) => `${minimum} 以上の値を入力してください。`,
    inputNumber: '数値を入力してください。',
    inputStep: '指定された間隔に合う値を入力してください。',
    mermaidDescription: (source) => `図のソース: ${boundedDescription(source)}`,
    mermaidError: (detail) => `Mermaid 図を表示できませんでした: ${translateDiagnostic(detail)}`,
    mermaidLoading: '図を表示しています…',
    mermaidTitle: (kind) => mermaidTitles.ja[kind],
    nextPage: '次のページ',
    noChartData: 'グラフにデータがありません。',
    outputTruncated: '出力は省略されています。',
    previousPage: '前のページ',
    rowsPerPage: '1ページあたりの行数',
    rowsRange: (first, last, total, truncated) => `${total} 行中 ${first}–${last} 行${truncated ? '（省略あり）' : ''}`,
    run: '実行',
    runtimeLanguage: runtimeLanguageLabel,
    running: '実行中…',
    runningCell: 'セルを実行中…',
    showCode: 'コードを表示',
    tableControls: '表の操作',
    tableCellTypeError: (type) => `検証済み表セルの型 ${type} には対応していません。`,
    tableFiniteNumberError: '検証済み表セルには有限の数値が必要です。',
    tableMissingValue: '値なし',
    tableOutput: 'データ表',
    tableRowWidthError: (row, received, expected) =>
      `${row} 行目のセルは ${received} 個ですが、${expected} 個である必要があります。`,
    unknownCell: (cellId) => `不明な実行可能セル: ${cellId}`
  }
} satisfies Record<RuntimeLocale, RuntimeLabels>;

export function labelsForLanguage(languageTag?: string): RuntimeLabels {
  return runtimeLabels[localeFromLanguage(languageTag)];
}

export function localeFromLanguage(languageTag?: string): RuntimeLocale {
  const primarySubtag = languageTag?.trim().split('-')[0]?.toLowerCase();
  return primarySubtag === 'ja' ? 'ja' : 'en';
}

function boundedDescription(source: string): string {
  const normalized = source.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 997)}…`;
}

function runtimeLanguageLabel(language: 'haskell' | 'python' | 'rust'): string {
  switch (language) {
    case 'rust':
      return 'Rust + Wasm';
    case 'python':
      return 'Python + Pyodide';
    case 'haskell':
      return 'Haskell + WASI';
  }
}

function translateDiagnostic(detail: string): string {
  const timeout = /^(.*) timed out after (\d+)ms$/u.exec(detail);
  if (timeout) {
    return `${timeout[1]} は ${timeout[2]} ミリ秒でタイムアウトしました。`;
  }
  const artifactLimit = /^Artifact limit exceeded: received (\d+), maximum (\d+)\.$/u.exec(detail);
  if (artifactLimit) {
    return `成果物の上限を超えました。${artifactLimit[1]} 件を受け取りましたが、上限は ${artifactLimit[2]} 件です。`;
  }
  if (detail.includes('exceeds the remaining 16 MiB run limit')) {
    return '実行あたり 16 MiB の残り上限を超えています。';
  }
  const chartLimit = /^Chart data item limit exceeded: received (\d+), maximum (\d+)\.$/u.exec(detail);
  if (chartLimit) {
    return `グラフデータの上限を超えました。${chartLimit[1]} 件を受け取りましたが、上限は ${chartLimit[2]} 件です。`;
  }
  return detail;
}
