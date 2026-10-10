import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import TableOutput from '../../packages/oxiquill/src/components/doc-runtime/TableOutput';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('downloads all sorted retained rows without clipboard access', async () => {
  let saved: Blob | undefined;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL(blob: Blob) {
        saved = blob;
        return 'blob:csv';
      }
      static revokeObjectURL() {}
    }
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const rows = Array.from({ length: 12 }, (_, i) => [i, i === 11 ? '=日本語,"quoted"\nnext' : null]);
  render(
    <TableOutput
      table={{
        kind: 'table',
        columns: [
          { key: 'n', label: 'Number', type: 'integer' },
          { key: 's', label: 'Text' }
        ],
        rows,
        rowCount: 100,
        truncated: true
      }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Number' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save all retrieved rows as CSV' }));
  expect(screen.getByText('CSV includes only the 12 retrieved rows.')).toBeVisible();
  expect(saved?.type).toBe('text/csv;charset=utf-8');
  const csv = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(saved as Blob);
  });
  expect(csv).toContain('11,"\'=日本語,""quoted""\nnext"');
  expect(csv).toContain('\n1,\n0,');
  expect(csv.indexOf('\n11,')).toBeLessThan(csv.indexOf('\n10,'));
});
