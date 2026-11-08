export type CellLanguage = 'rust' | 'python' | 'haskell';
export type RunMode = 'button' | 'reactive' | 'autorun';
export type InputType = 'range' | 'number' | 'integer' | 'text' | 'textarea' | 'checkbox' | 'select' | 'radio';

export { PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MIN } from './portable-integer.mjs';

export interface InputOption {
  label: string;
  value: string;
}

export interface InputSpec {
  share?: boolean;
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

export interface InputCase {
  id: string;
  label: string;
  description?: string;
  inputs: InputValues;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [name: string]: JsonValue };
export type CellDependency = { readonly cell: string; readonly type?: string };
export interface PageCellManifest {
  readonly cells: readonly CellManifest[];
  readonly rust?: RustRuntimeRegistry;
}

export interface CellManifest {
  exports?: readonly string[];
  dependsOn?: Readonly<Record<string, CellDependency>>;
  cache?: 'inputs';
  producerFingerprint?: string;
  uses?: readonly string[];
  ref?: string;
  cases?: readonly InputCase[];
  setup?: readonly PythonSetupStep[];
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
  editable: boolean;
  /** `columns` lets charts and images share rows when the cell is wide enough. */
  outputLayout?: OutputLayout;
  pagePath: string;
}

export type OutputLayout = 'stack' | 'columns';

export interface DefinitionsBlockManifest {
  kind: 'definitions';
  id: string;
  language: 'rust';
  title: string;
  source: string;
  sourceHtml: string;
  crates: readonly string[];
  uses: readonly string[];
  showSource: boolean;
  pagePath: string;
}

export type AuthoredBlockManifest = CellManifest | DefinitionsBlockManifest;

export interface CellCompileError {
  cellId: string;
  file: string;
  line: number;
  column: number;
  code?: string;
  message: string;
}

export interface PythonSetupStep {
  id: string;
  source: string;
  packages: readonly string[];
  timeoutMs: number;
}

export type InputValues = Record<string, string | number | boolean>;

export interface RustRuntimeModule {
  readonly id: string;
  readonly fingerprint: string;
  readonly glue: { readonly url: string };
  readonly wasm: { readonly url: string; readonly integrity: string; readonly bytes: number };
  readonly cells: readonly string[];
}

export interface RustRuntimeRegistry {
  readonly version: 1;
  readonly modules: readonly RustRuntimeModule[];
}

export type RustWorkerRequest = RuntimeWorkerRequest | { type: 'registry'; registry: RustRuntimeRegistry };

export type ArtifactStream = 'stdout' | 'stderr' | 'display';
export type TableColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'null' | 'unknown';
export type ChartAxisType = 'value' | 'category' | 'time' | 'log';
export type ChartSpec =
  | XyChartSpec
  | LineChartSpec
  | ScatterChartSpec
  | BarChartSpec
  | HistogramChartSpec
  | AreaChartSpec
  | HeatmapChartSpec
  | IntervalChartSpec
  | BoxplotChartSpec
  | BubbleChartSpec
  | FieldChartSpec;
export type OutputArtifact =
  | TextArtifact
  | JsonArtifact
  | TableArtifact
  | ChartArtifact
  | Scene3dArtifact
  | ImageArtifact
  | HtmlArtifact
  | OutcomeArtifact;

export interface Scene3dPoint {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly label?: string;
  readonly group?: string;
}

export interface Scene3dEdge {
  readonly from: string;
  readonly to: string;
}

export interface Scene3dGroup {
  readonly id: string;
  readonly label?: string;
}

export interface Scene3dAxis {
  readonly label?: string;
  readonly unit?: string;
}

export interface Scene3dCamera {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly zoom?: number;
}

export interface Scene3dArtifact extends BaseArtifact {
  readonly kind: 'scene3d';
  readonly points: readonly Scene3dPoint[];
  readonly edges?: readonly Scene3dEdge[];
  readonly groups?: readonly Scene3dGroup[];
  readonly axes?: Readonly<Partial<Record<'x' | 'y' | 'z', Scene3dAxis>>>;
  readonly camera?: Scene3dCamera;
}

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
  format?: NumberFormat;
  nullText?: string;
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

export interface NumberFormat {
  significantDigits?: number;
  fractionDigits?: number;
  unit?: string;
  notation?: 'auto' | 'standard' | 'scientific' | 'si';
}

export type ChartNumberFormat = NumberFormat;

export type OutcomeState = 'satisfied' | 'partial' | 'failed' | 'unavailable';

export interface OutcomeDiagnostic {
  name: string;
  value: number;
  unit?: string;
}

export interface OutcomeArtifact extends BaseArtifact {
  kind: 'outcome';
  state: OutcomeState;
  label: string;
  explanation?: string;
  status?: string;
  diagnostics?: readonly OutcomeDiagnostic[];
}

export interface BaseChartStyle {
  renderer?: 'canvas' | 'svg';
  xFormat?: ChartNumberFormat;
  yFormat?: ChartNumberFormat;
  valueFormat?: ChartNumberFormat;
  height?: number;
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

export interface ChartLink {
  group: string;
  zoom?: boolean;
  cursor?: boolean;
}

export interface BaseChartSpec {
  annotations?: readonly ChartAnnotation[];
  style?: BaseChartStyle;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  xType?: ChartAxisType;
  yType?: ChartAxisType;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  xIncludeZero?: boolean;
  yIncludeZero?: boolean;
  legend?: boolean;
  tooltip?: boolean;
  dataZoom?: boolean;
}

export type ChartAnnotation = {
  axis: 'x' | 'y';
  label?: string;
} & (
  | {
      kind: 'line';
      value: number | string;
      style?: { color?: string; lineType?: 'solid' | 'dashed' | 'dotted'; width?: number };
    }
  | { kind: 'range'; from: number | string; to: number | string; style?: { color?: string; opacity?: number } }
);

export type ChartSymbol = 'circle' | 'emptyCircle' | 'rect' | 'triangle' | 'diamond' | 'none';
export type ChartSeriesColor = string | { light?: string; dark?: string };

export interface ChartSeriesStyle {
  color?: ChartSeriesColor;
}

export interface ScatterSeriesStyle extends ChartSeriesStyle {
  symbol?: ChartSymbol;
}

export interface LineSeriesStyle extends ScatterSeriesStyle {
  lineType?: 'solid' | 'dashed' | 'dotted';
  step?: false | 'start' | 'middle' | 'end';
  smooth?: boolean;
  showSymbol?: boolean;
}

export interface XyChartSeries {
  id?: string;
  style?: LineSeriesStyle;
  name?: string;
  points: readonly (readonly [number | string, number | string])[];
}

export type XyChartLayer =
  | (Omit<XyChartSeries, 'id'> & { id: string; kind: 'line' })
  | (Omit<ScatterChartSeries, 'id'> & { id: string; kind: 'scatter' })
  | (Omit<IntervalChartSeries, 'id'> & { id: string; kind: 'band' });

export interface XyChartSpec extends BaseChartSpec {
  link?: ChartLink;
  kind: 'xy';
  xType?: 'value' | 'time';
  yType?: 'value' | 'log';
  style?: LineChartStyle & ScatterChartStyle;
  layers: readonly XyChartLayer[];
}

export interface LineChartSpec extends BaseChartSpec {
  link?: ChartLink;
  style?: LineChartStyle;
  kind: 'line';
  series: readonly XyChartSeries[];
}

export interface ScatterChartSeries extends Omit<XyChartSeries, 'style'> {
  style?: ScatterSeriesStyle;
}

export interface ScatterChartSpec extends BaseChartSpec {
  link?: ChartLink;
  style?: ScatterChartStyle;
  kind: 'scatter';
  series: readonly ScatterChartSeries[];
}

export interface BarChartSeries {
  stack?: string;
  id?: string;
  style?: ChartSeriesStyle;
  name?: string;
  values: readonly (number | null)[];
}

export interface BarChartSpec extends BaseChartSpec {
  kind: 'bar';
  orientation?: 'vertical' | 'horizontal';
  categories: readonly string[];
  series: readonly BarChartSeries[];
}

export interface HistogramChartSpec extends BaseChartSpec {
  kind: 'histogram';
  xType?: 'value' | 'category';
  mode?: 'count' | 'density';
  yType?: 'value' | 'log';
  bins: readonly (readonly [number, number, number])[];
}

export interface AreaChartSpec extends BaseChartSpec {
  link?: ChartLink;
  style?: LineChartStyle;
  kind: 'area';
  series: readonly AreaChartSeries[];
}

export interface AreaChartSeries extends XyChartSeries {
  stack?: string;
}

export interface HeatmapChartSpec extends BaseChartSpec {
  colorScale?: 'sequential' | 'diverging';
  colorMin?: number;
  colorMax?: number;
  center?: number;
  kind: 'heatmap';
  xType?: 'category';
  yType?: 'category';
  xCategories?: readonly string[];
  yCategories?: readonly string[];
  data: readonly (readonly [number | string, number | string, number])[];
}

export type IntervalPoint =
  readonly [number | string, number, number, number] | readonly [number | string, null, null, null];

export interface IntervalChartSeries {
  id?: string;
  name?: string;
  style?: ChartSeriesStyle;
  points: readonly IntervalPoint[];
}

export interface IntervalChartSpec extends BaseChartSpec {
  link?: ChartLink;
  kind: 'errorbar' | 'band';
  style?: LineChartStyle;
  yType?: 'value' | 'log';
  series: readonly IntervalChartSeries[];
}

export interface RawCellExecutionResult {
  exports?: JsonObject;
  outputs: readonly unknown[];
}

export interface CellExecutionResult {
  exports?: JsonObject;
  outputs: readonly OutputArtifact[];
}

export interface RuntimeWorkerRequest {
  dependencies?: Readonly<Record<string, JsonObject>>;
  rustModule?: RustRuntimeModule;
  setup?: readonly PythonSetupStep[];
  requestId: number;
  cellId: string;
  haskellFingerprintHash?: string;
  inputArgs?: readonly string[];
  integerInputNames?: readonly string[];
  inputs: InputValues;
  source?: string;
  packages?: readonly string[];
  shippedPackages?: readonly string[];
}

export type RuntimeExecutionPhase = 'preparing' | 'executing';

export interface PythonPrepareRequest {
  type: 'prepare';
  requestId: number;
  packages: readonly string[];
}

export type PythonWorkerRequest = RuntimeWorkerRequest | PythonPrepareRequest;
export type PythonWorkerResponse =
  | RuntimeWorkerResponse
  | { type: 'ready'; requestId: number; ok: true }
  | { type: 'progress'; requestId: number; phase: RuntimeExecutionPhase };

export type RuntimeWorkerResponse = { rustModule?: Pick<RustRuntimeModule, 'id' | 'fingerprint'> } & (
  | {
      requestId: number;
      ok: true;
      result: RawCellExecutionResult;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
      partialResult?: RawCellExecutionResult;
    }
);

export type BoxplotValue = readonly [number, number, number, number, number];
export interface BoxplotChartSpec extends BaseChartSpec {
  kind: 'boxplot';
  xType?: 'category';
  yType?: 'value' | 'log';
  categories: readonly string[];
  series: readonly { id?: string; name?: string; style?: ChartSeriesStyle; values: readonly (BoxplotValue | null)[] }[];
}

export type BubblePoint = readonly [number | string, number | string, number, (number | null)?];
export interface BubbleSizeMapping {
  maxValue?: number;
  minPixels?: number;
  maxPixels?: number;
  scale?: 'area' | 'radius';
}
export interface BubbleChartSpec extends BaseChartSpec {
  kind: 'bubble';
  sizeMapping?: BubbleSizeMapping;
  colorMapping?: { min: number; max: number; palette?: ChartPalette };
  series: readonly { id?: string; name?: string; style?: ScatterSeriesStyle; points: readonly BubblePoint[] }[];
}

export interface FieldChartSpec extends BaseChartSpec {
  kind: 'field';
  xType?: 'value';
  yType?: 'value';
  xEdges: readonly number[];
  yEdges: readonly number[];
  values: readonly (readonly (number | null)[])[];
}
