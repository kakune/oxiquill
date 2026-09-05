export type CellLanguage = 'rust' | 'python' | 'haskell';
export type RunMode = 'button' | 'reactive' | 'autorun';
export type InputType = 'range' | 'number' | 'integer' | 'text' | 'textarea' | 'checkbox' | 'select' | 'radio';

export { PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MIN } from './portable-integer.mjs';

export interface InputOption {
  label: string;
  value: string;
}

export interface InputSpec {
  name: string;
  type: InputType;
  label: string;
  description?: string;
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options: readonly InputOption[];
}

export interface CellManifest {
  id: string;
  language: CellLanguage;
  title: string;
  run: RunMode;
  source: string;
  sourceHtml: string;
  inputs: readonly InputSpec[];
  packages: readonly string[];
  crates: readonly string[];
  timeoutMs: number;
  showSource: boolean;
  pagePath: string;
}

export type InputValues = Record<string, string | number | boolean>;

export interface LinePlotSpec {
  kind: 'line';
  x_label: string;
  y_label: string;
  points: readonly [number, number][];
}

export type PlotSpec = LinePlotSpec;

export type ArtifactStream = 'stdout' | 'stderr' | 'display';
export type TableColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'null' | 'unknown';
export type ChartAxisType = 'value' | 'category' | 'time' | 'log';
export type ChartSpec =
  LineChartSpec | ScatterChartSpec | BarChartSpec | HistogramChartSpec | AreaChartSpec | HeatmapChartSpec;
export type OutputArtifact = TextArtifact | JsonArtifact | TableArtifact | ChartArtifact | ImageArtifact | HtmlArtifact;

export interface BaseArtifact {
  id?: string;
  title?: string;
  caption?: string;
}

export interface TextArtifact extends BaseArtifact {
  kind: 'text';
  stream: ArtifactStream;
  content: string;
  truncated?: boolean;
}

export interface JsonArtifact extends BaseArtifact {
  kind: 'json';
  value: unknown;
  truncated?: boolean;
}

export interface TableArtifact extends BaseArtifact {
  kind: 'table';
  columns: readonly TableColumn[];
  rows: readonly unknown[][];
  rowCount?: number;
  truncated?: boolean;
}

export interface TableColumn {
  key: string;
  label: string;
  type?: TableColumnType;
}

export interface ChartArtifact extends BaseArtifact {
  kind: 'chart';
  spec: ChartSpec;
}

export interface ImageArtifact extends BaseArtifact {
  kind: 'image';
  mime: 'image/png' | 'image/jpeg' | 'image/svg+xml';
  data: string;
  alt?: string;
}

export interface HtmlArtifact extends BaseArtifact {
  kind: 'html';
  html: string;
  sandboxed: true;
}

export interface ChartPalette {
  light?: readonly string[];
  dark?: readonly string[];
}

export interface BaseChartStyle {
  palette?: ChartPalette;
  showGrid?: boolean;
  animation?: boolean;
  animationDurationMs?: number;
}

export interface LineChartStyle extends BaseChartStyle {
  lineWidth?: number;
}

export interface ScatterChartStyle extends BaseChartStyle {
  symbolSize?: number;
}

export interface BaseChartSpec {
  style?: BaseChartStyle;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  xType?: ChartAxisType;
  yType?: ChartAxisType;
  legend?: boolean;
  tooltip?: boolean;
  dataZoom?: boolean;
}

export interface XyChartSeries {
  name?: string;
  points: readonly (readonly [number | string, number | string])[];
}

export interface LineChartSpec extends BaseChartSpec {
  style?: LineChartStyle;
  kind: 'line';
  series: readonly XyChartSeries[];
}

export interface ScatterChartSpec extends BaseChartSpec {
  style?: ScatterChartStyle;
  kind: 'scatter';
  series: readonly XyChartSeries[];
}

export interface BarChartSeries {
  name?: string;
  values: readonly (number | null)[];
}

export interface BarChartSpec extends BaseChartSpec {
  kind: 'bar';
  categories: readonly string[];
  series: readonly BarChartSeries[];
}

export interface HistogramChartSpec extends BaseChartSpec {
  kind: 'histogram';
  bins: readonly (readonly [number, number, number])[];
}

export interface AreaChartSpec extends BaseChartSpec {
  style?: LineChartStyle;
  kind: 'area';
  series: readonly XyChartSeries[];
}

export interface HeatmapChartSpec extends BaseChartSpec {
  kind: 'heatmap';
  xType?: 'category';
  yType?: 'category';
  xCategories?: readonly string[];
  yCategories?: readonly string[];
  data: readonly (readonly [number | string, number | string, number])[];
}

export interface RawCellExecutionResult {
  stdout?: string;
  stderr?: string;
  value?: unknown;
  plots?: readonly PlotSpec[];
  outputs?: readonly unknown[];
}

export interface CellExecutionResult {
  stdout: string;
  stderr?: string;
  value?: unknown;
  plots: readonly PlotSpec[];
  outputs: readonly OutputArtifact[];
}

export interface RuntimeWorkerRequest {
  requestId: number;
  cellId: string;
  haskellFingerprintHash?: string;
  inputArgs?: readonly string[];
  integerInputNames?: readonly string[];
  inputs: InputValues;
  source?: string;
  packages?: readonly string[];
}

export type RuntimeWorkerResponse =
  | {
      requestId: number;
      ok: true;
      result: RawCellExecutionResult;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
