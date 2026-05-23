export type CellLanguage = 'rust' | 'python';
export type RunMode = 'button' | 'reactive' | 'autorun' | 'hidden';
export type InputType =
  | 'range'
  | 'number'
  | 'integer'
  | 'text'
  | 'textarea'
  | 'checkbox'
  | 'select'
  | 'radio';

export interface InputOption {
  label: string;
  value: string;
}

export interface InputSpec {
  name: string;
  type: InputType;
  label: string;
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

export interface CellExecutionResult {
  stdout: string;
  stderr?: string;
  value?: unknown;
  plots: readonly PlotSpec[];
}

export interface RuntimeWorkerRequest {
  requestId: number;
  cellId: string;
  inputs: InputValues;
  source?: string;
  packages?: readonly string[];
}

export type RuntimeWorkerResponse =
  | {
      requestId: number;
      ok: true;
      result: CellExecutionResult;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };
