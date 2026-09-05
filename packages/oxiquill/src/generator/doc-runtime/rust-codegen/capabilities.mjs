import { scanRustMacroInvocations } from './macro-invocations.mjs';

const chartTokens = [
  'emit_line_plot',
  'emit_line_chart',
  'emit_scatter_chart',
  'emit_bar_chart',
  'emit_histogram',
  'emit_heatmap'
];

const imageTokens = ['emit_image_svg', 'emit_image_png', 'emit_svg', 'emit_png_base64'];

const tableTokens = ['emit_table', 'emit_table_with_columns', 'emit_records_table'];

const sourceFeatureDescriptors = [
  ['legacyPlot', ['emit_line_plot']],
  ['lineChart', ['emit_line_chart']],
  ['scatterChart', ['emit_scatter_chart']],
  ['barChart', ['emit_bar_chart']],
  ['histogramChart', ['emit_histogram']],
  ['heatmapChart', ['emit_heatmap']],
  ['html', ['emit_html']],
  ['json', ['emit_json']]
];

export function rustOutputCapabilities(
  rustCells,
  macroSets = rustCells.map((cell) => scanRustMacroInvocations(cell.source, cell))
) {
  return rustSourceCapabilities('', new Set(macroSets.flatMap((macros) => [...macros])));
}

export function rustSourceCapabilities(source, macros = scanRustMacroInvocations(source)) {
  return {
    ...Object.fromEntries(sourceFeatureDescriptors.map(([key, names]) => [key, hasAnyMacro(macros, names)])),
    chart: hasAnyMacro(macros, chartTokens),
    image: hasAnyMacro(macros, imageTokens),
    table: hasAnyMacro(macros, tableTokens),
    text: hasAnyMacro(macros, ['emit_text'])
  };
}

export function hasAnyMacro(macros, names) {
  return names.some((name) => macros.has(name));
}
