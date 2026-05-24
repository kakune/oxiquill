const chartTokens = [
  'emit_line_plot!',
  'emit_line_chart!',
  'emit_scatter_chart!',
  'emit_bar_chart!',
  'emit_histogram!',
  'emit_heatmap!'
];

const imageTokens = [
  'emit_image_svg!',
  'emit_image_png!',
  'emit_svg!',
  'emit_png_base64!'
];

const tableTokens = [
  'emit_table!',
  'emit_table_with_columns!',
  'emit_records_table!'
];

const sourceFeatureDescriptors = [
  ['legacyPlot', ['emit_line_plot!']],
  ['lineChart', ['emit_line_chart!']],
  ['scatterChart', ['emit_scatter_chart!']],
  ['barChart', ['emit_bar_chart!']],
  ['histogramChart', ['emit_histogram!']],
  ['heatmapChart', ['emit_heatmap!']],
  ['html', ['emit_html!']],
  ['json', ['emit_json!']]
];

export function rustOutputCapabilities(rustCells) {
  return rustSourceCapabilities(rustCells.map((cell) => cell.source).join('\n'));
}

export function rustSourceCapabilities(source) {
  return {
    ...Object.fromEntries(
      sourceFeatureDescriptors.map(([key, tokens]) => [key, hasAnyToken(source, tokens)])
    ),
    chart: hasAnyToken(source, chartTokens),
    image: hasAnyToken(source, imageTokens),
    table: hasAnyToken(source, tableTokens)
  };
}

export function hasAnyToken(source, tokens) {
  return tokens.some((token) => source.includes(token));
}
