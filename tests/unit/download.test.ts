import { afterEach, expect, it, vi } from 'vitest';
import { artifactDownloadName, downloadBlob } from '../../packages/oxiquill/src/lib/doc-runtime/download';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('creates bounded names without path separators and preserves Unicode', () => {
  expect(artifactDownloadName({ title: '../日本語/plot:*?\n' }, 'svg', 'chart')).toBe('-日本語-plot---.svg');
  expect(artifactDownloadName({}, 'csv', 'table')).toBe('table.csv');
  expect(artifactDownloadName({ id: 'result' }, 'png', 'chart')).toBe('result.png');
  expect(artifactDownloadName({ title: 'a'.repeat(200) }, 'csv', 'table')).toHaveLength(104);
});

it.each([false, true])('releases the URL and anchor after a download (failure: %s)', (fail) => {
  vi.useFakeTimers();
  const create = vi.fn(() => 'blob:download');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('table.csv');
    expect(this.href).toBe('blob:download');
    if (fail) throw new Error('download failed');
  });
  const blob = new Blob(['x']);
  if (fail) expect(() => downloadBlob(blob, 'table.csv')).toThrow('download failed');
  else downloadBlob(blob, 'table.csv');
  expect(click).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(blob);
  expect(document.querySelector('a[download]')).toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith('blob:download');
});
