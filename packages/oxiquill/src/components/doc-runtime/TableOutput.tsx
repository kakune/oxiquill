import { useEffect, useMemo, useState } from 'preact/hooks';
import type { TableArtifact, TableColumn } from '../../lib/doc-runtime/types.js';

interface TableOutputProps {
  table: TableArtifact;
}

type SortDirection = 'asc' | 'desc';
type SortState = {
  columnIndex: number;
  direction: SortDirection;
};

export type TableCsvResult = { ok: true; csv: string } | { ok: false; error: string };

type CopyStatus = {
  kind: 'success' | 'error';
  message: string;
};

const pageSizes = [10, 25, 50, 100] as const;

export default function TableOutput({ table }: TableOutputProps) {
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(pageSizes[0]);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState>();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>();
  const sortedRows = useMemo(() => sortRows(table.rows, sort), [table.rows, sort]);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const currentRows = visibleRows(sortedRows, safePage, pageSize);
  const firstRow = sortedRows.length === 0 ? 0 : safePage * pageSize + 1;
  const lastRow = Math.min(sortedRows.length, (safePage + 1) * pageSize);

  useEffect(() => setCopyStatus(undefined), [table]);

  function updateSort(columnIndex: number): void {
    setPage(0);
    setSort((current) => {
      if (!current || current.columnIndex !== columnIndex) return { columnIndex, direction: 'asc' };
      return { columnIndex, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  }

  async function copyVisibleCsv(): Promise<void> {
    const converted = tableToCsv(table.columns, currentRows);
    if (!converted.ok) {
      setCopyStatus({ kind: 'error', message: `Unable to copy CSV: ${converted.error}` });
      return;
    }
    try {
      const clipboard = globalThis.navigator.clipboard;
      if (!clipboard) {
        setCopyStatus({ kind: 'error', message: 'Unable to copy CSV: Clipboard access is unavailable.' });
        return;
      }
      await clipboard.writeText(converted.csv);
      setCopyStatus({ kind: 'success', message: 'Copied visible rows as CSV.' });
    } catch (error) {
      setCopyStatus({
        kind: 'error',
        message: `Unable to copy CSV: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return (
    <section class="doc-table-output" data-testid="table-output">
      {table.caption ? <p class="doc-table-output__caption">{table.caption}</p> : null}
      <div class="doc-table-output__scroller">
        <table>
          {table.title ? <caption>{table.title}</caption> : null}
          <thead>
            <tr>
              {table.columns.map((column, columnIndex) => (
                <th key={column.key} scope="col" aria-sort={ariaSort(sort, columnIndex)}>
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
                    {formatTableCell(row[columnIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="doc-table-output__footer">
        <p>
          Rows {firstRow}-{lastRow} of {table.rowCount ?? sortedRows.length}
          {table.truncated ? ' (truncated)' : ''}
        </p>
        <div class="doc-table-output__controls">
          <label>
            <span>Rows</span>
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
          <button type="button" data-testid="table-copy-csv" onClick={copyVisibleCsv}>
            Copy CSV
          </button>
          <button
            type="button"
            data-testid="table-prev"
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            Prev
          </button>
          <button
            type="button"
            data-testid="table-next"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          >
            Next
          </button>
        </div>
      </div>
      {copyStatus ? (
        <p
          class={copyStatus.kind === 'error' ? 'error-state' : 'doc-table-output__status'}
          data-testid="table-copy-status"
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

export function tableToCsv(columns: readonly TableColumn[], rows: readonly unknown[][]): TableCsvResult {
  try {
    return {
      ok: true,
      csv: [
        columns.map((column) => csvCell(column.label)).join(','),
        ...rows.map((row, rowIndex) => {
          if (row.length !== columns.length) {
            throw new Error(`Row ${rowIndex + 1} has ${row.length} cells; expected ${columns.length}.`);
          }
          return columns.map((_, index) => csvCell(row[index])).join(',');
        })
      ].join('\n')
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function formatTableCell(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value)
      : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  throw new Error(`Unsupported validated table cell type: ${typeof value}.`);
}

function compareCellValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left).localeCompare(String(right));
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(`Unsupported validated table cell type: ${typeof value}.`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Validated table cells must contain finite numbers.');
  }
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function ariaSort(sort: SortState | undefined, columnIndex: number): 'ascending' | 'descending' | 'none' {
  if (!sort || sort.columnIndex !== columnIndex) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}
