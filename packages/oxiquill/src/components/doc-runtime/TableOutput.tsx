import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { labelsForLanguage, type RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { TableArtifact, TableColumn } from '../../lib/doc-runtime/types.js';

interface TableOutputProps {
  idPrefix?: string;
  labels?: RuntimeLabels;
  resultIdentity?: object;
  table: TableArtifact;
}

type SortDirection = 'asc' | 'desc';
type SortState = {
  columnIndex: number;
  columnKey?: string;
  direction: SortDirection;
};

export type TableCsvResult = { ok: true; csv: string } | { ok: false; error: string };

type CopyStatus = {
  kind: 'copying' | 'success' | 'error';
  message: string;
};

const pageSizes = [10, 25, 50, 100] as const;

export default function TableOutput({
  idPrefix = 'doc-table',
  labels = labelsForLanguage(globalThis.document?.documentElement.lang),
  resultIdentity,
  table
}: TableOutputProps) {
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(pageSizes[0]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState>();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>();
  const identity = resultIdentity ?? table;
  const identityRef = useRef(identity);
  const resultGenerationRef = useRef(0);
  const resultChanged = identityRef.current !== identity;
  if (resultChanged) {
    identityRef.current = identity;
    resultGenerationRef.current += 1;
  }
  const reconciledSort = resultChanged || !isSortValid(sort, table.columns) ? undefined : sort;
  const sortedRows = useMemo(() => sortRows(table.rows, reconciledSort), [table.rows, reconciledSort]);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = resultChanged ? 0 : Math.min(page, pageCount - 1);
  const currentRows = visibleRows(sortedRows, safePage, pageSize);
  const firstRow = sortedRows.length === 0 ? 0 : safePage * pageSize + 1;
  const lastRow = Math.min(sortedRows.length, (safePage + 1) * pageSize);
  const captionId = `${idPrefix}-title`;
  const descriptionId = table.caption ? `${idPrefix}-description` : undefined;
  const columnKeys = table.columns.map((column) => column.key).join('\0');

  useLayoutEffect(() => {
    setPage((current) => (resultChanged ? 0 : Math.min(current, pageCount - 1)));
    setSort((current) => (resultChanged || !isSortValid(current, table.columns) ? undefined : current));
    setCopyStatus(undefined);
  }, [columnKeys, identity, pageCount, resultChanged, table.columns]);

  function updateSort(columnIndex: number): void {
    setPage(0);
    setSort((current) => {
      const columnKey = table.columns[columnIndex]?.key;
      if (!current || current.columnIndex !== columnIndex) return { columnIndex, columnKey, direction: 'asc' };
      return { columnIndex, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  }

  async function copyVisibleCsv(): Promise<void> {
    if (copyStatus?.kind === 'copying') return;
    const resultGeneration = resultGenerationRef.current;
    setCopyStatus({ kind: 'copying', message: labels.copyingCsv });
    const converted = tableToCsv(table.columns, currentRows, labels);
    if (!converted.ok) {
      if (resultGenerationRef.current === resultGeneration) {
        setCopyStatus({ kind: 'error', message: labels.copyCsvError(converted.error) });
      }
      return;
    }
    try {
      const clipboard = globalThis.navigator.clipboard;
      if (!clipboard) {
        if (resultGenerationRef.current === resultGeneration) {
          setCopyStatus({ kind: 'error', message: labels.copyCsvError(labels.clipboardUnavailable) });
        }
        return;
      }
      await clipboard.writeText(converted.csv);
      if (resultGenerationRef.current === resultGeneration) {
        setCopyStatus({ kind: 'success', message: labels.copyCsvSuccess });
      }
    } catch (error) {
      if (resultGenerationRef.current === resultGeneration) {
        setCopyStatus({
          kind: 'error',
          message: labels.copyCsvError(boundedErrorMessage(error))
        });
      }
    }
  }

  return (
    <section class="doc-table-output" aria-labelledby={captionId} data-testid="table-output">
      {table.caption ? (
        <p id={descriptionId} class="doc-table-output__caption">
          {table.caption}
        </p>
      ) : null}
      <div class="doc-table-output__scroller">
        <table aria-describedby={descriptionId}>
          <caption id={captionId} class={table.title ? undefined : 'doc-visually-hidden'}>
            {table.title ?? labels.tableOutput}
          </caption>
          <thead>
            <tr>
              {table.columns.map((column, columnIndex) => (
                <th key={column.key} scope="col" aria-sort={ariaSort(reconciledSort, columnIndex)}>
                  <button type="button" onClick={() => updateSort(columnIndex)}>
                    {column.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {currentRows.map((row, rowIndex) => (
              <tr key={`${safePage}:${rowIndex}`}>
                {table.columns.map((column, columnIndex) => (
                  <td key={column.key} data-type={column.type ?? 'unknown'}>
                    {formatTableCell(row[columnIndex], labels)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="doc-table-output__footer">
        <p>{labels.rowsRange(firstRow, lastRow, table.rowCount ?? sortedRows.length, Boolean(table.truncated))}</p>
        <fieldset class="doc-table-output__controls">
          <legend class="doc-visually-hidden">{labels.tableControls}</legend>
          <label>
            <span>{labels.rowsPerPage}</span>
            <select
              data-testid="table-page-size"
              value={String(pageSize)}
              onInput={(event) => {
                setPage(0);
                setPageSize(Number(event.currentTarget.value) as (typeof pageSizes)[number]);
              }}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-busy={copyStatus?.kind === 'copying'}
            aria-disabled={copyStatus?.kind === 'copying'}
            data-testid="table-copy-csv"
            onClick={copyVisibleCsv}
          >
            {copyStatus?.kind === 'copying' ? labels.copyingCsv : labels.copyCsv}
          </button>
          <button
            type="button"
            data-testid="table-prev"
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            {labels.previousPage}
          </button>
          <button
            type="button"
            data-testid="table-next"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          >
            {labels.nextPage}
          </button>
        </fieldset>
      </div>
      {copyStatus ? (
        <p
          class={copyStatus.kind === 'error' ? 'error-state' : 'doc-table-output__status'}
          data-testid="table-copy-status"
          aria-live={copyStatus.kind === 'error' ? 'assertive' : 'polite'}
          role={copyStatus.kind === 'error' ? 'alert' : 'status'}
        >
          {copyStatus.message}
        </p>
      ) : null}
    </section>
  );
}

export function sortRows(rows: readonly unknown[][], sort?: SortState): readonly unknown[][] {
  if (!sort) return rows;

  return rows
    .map((row, index) => ({ index, row }))
    .sort((left, right) => {
      const compared = compareCellValues(left.row[sort.columnIndex], right.row[sort.columnIndex]);
      return sort.direction === 'asc' ? compared || left.index - right.index : -compared || left.index - right.index;
    })
    .map(({ row }) => row);
}

export function visibleRows(rows: readonly unknown[][], page: number, pageSize: number): readonly unknown[][] {
  return rows.slice(page * pageSize, (page + 1) * pageSize);
}

function isSortValid(sort: SortState | undefined, columns: readonly TableColumn[]): boolean {
  if (!sort) return true;
  const column = columns[sort.columnIndex];
  return Boolean(column && (sort.columnKey === undefined || sort.columnKey === column.key));
}

export function tableToCsv(
  columns: readonly TableColumn[],
  rows: readonly unknown[][],
  labels: RuntimeLabels = labelsForLanguage('en')
): TableCsvResult {
  try {
    return {
      ok: true,
      csv: [
        columns.map((column) => csvCell(column.label, labels)).join(','),
        ...rows.map((row, rowIndex) => {
          if (row.length !== columns.length) {
            throw new Error(labels.tableRowWidthError(rowIndex + 1, row.length, columns.length));
          }
          return columns.map((_, index) => csvCell(row[index], labels)).join(',');
        })
      ].join('\n')
    };
  } catch (error) {
    return { ok: false, error: boundedErrorMessage(error) };
  }
}

export function formatTableCell(value: unknown, labels: RuntimeLabels = labelsForLanguage('en')): string {
  if (value === null) return 'null';
  if (value === undefined) return labels.tableMissingValue;
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? new Intl.NumberFormat(labels.locale === 'ja' ? 'ja-JP' : 'en-US', { maximumSignificantDigits: 6 }).format(value)
      : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  throw new Error(labels.tableCellTypeError(typeof value));
}

function compareCellValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left).localeCompare(String(right));
}

function csvCell(value: unknown, labels: RuntimeLabels): string {
  if (value == null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(labels.tableCellTypeError(typeof value));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(labels.tableFiniteNumberError);
  }
  const text = typeof value === 'string' ? spreadsheetSafeString(value) : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function spreadsheetSafeString(value: string): string {
  return /^\s*[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

function ariaSort(sort: SortState | undefined, columnIndex: number): 'ascending' | 'descending' | 'none' {
  if (!sort || sort.columnIndex !== columnIndex) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}
