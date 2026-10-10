import { beforeEach, expect, it, vi } from 'vitest';
import {
  applyChartViewState,
  chartViewState,
  exportChartImage
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-export';
import { defaultChartChrome } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  setOption: vi.fn(),
  dispose: vi.fn(),
  renderToSVGString: vi.fn(() => '<svg width="720" height="360"/>'),
  renderToCanvas: vi.fn()
}));
vi.mock('../../packages/oxiquill/src/lib/doc-runtime/echarts-runtime', () => ({
  loadECharts: async () => ({ init: mocks.init })
}));
const request = {
  spec: { kind: 'line' as const, series: [{ points: [[0, 1] as const] }] },
  theme: 'dark' as const,
  chrome: defaultChartChrome('dark'),
  locale: 'en' as const,
  width: 720,
  height: 360,
  state: { dataZoom: [{ start: 20, end: 80 }], legend: [{ selected: { 'line:0': false } }] }
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setOption.mockReset();
  mocks.init.mockReturnValue(mocks);
  mocks.renderToCanvas.mockReturnValue({
    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(['png'], { type: 'image/png' }))
  });
});

it.each(['png', 'svg'] as const)(
  'exports %s with a temporary renderer, state, background, and no animation',
  async (format) => {
    const blob = await exportChartImage({ ...request, format });
    expect(blob.type).toContain(`image/${format === 'svg' ? 'svg+xml' : 'png'}`);
    expect(mocks.init).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ renderer: format === 'svg' ? 'svg' : 'canvas', width: 720, height: 360 })
    );
    expect(mocks.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        animation: false,
        backgroundColor: '#181a1e',
        legend: expect.objectContaining({ selected: { 'line:0': false } }),
        dataZoom: [expect.objectContaining({ start: 20, end: 80 })]
      }),
      { notMerge: true }
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
    if (format === 'png')
      expect(mocks.renderToCanvas).toHaveBeenCalledWith({ pixelRatio: 2, backgroundColor: '#181a1e' });
  }
);

it('disposes failed renders and failed encodings', async () => {
  mocks.setOption.mockImplementationOnce(() => {
    throw new Error('render failed');
  });
  await expect(exportChartImage({ ...request, format: 'svg' })).rejects.toThrow('render failed');
  mocks.renderToCanvas.mockReturnValue({ toBlob: (callback: (blob: null) => void) => callback(null) });
  await expect(exportChartImage({ ...request, format: 'png' })).rejects.toThrow('encode');
  expect(mocks.dispose).toHaveBeenCalledTimes(2);
});

it('copies only interaction state and restores heatmap ranges', () => {
  const selected = { first: false };
  const state = chartViewState({
    getOption: () => ({ series: [{ data: [1] }], legend: [{ selected }], visualMap: [{ range: [1, 2] }] })
  } as never);
  selected.first = true;
  expect(state.legend?.[0].selected).toEqual({ first: false });
  const options = { series: [], visualMap: { min: 0, max: 3 } };
  applyChartViewState(options, state);
  expect(options.visualMap).toEqual({ min: 0, max: 3, range: [1, 2] });
});

it.each(['canvas', 'svg', 'webgl'])('validates the authored renderer %s', (renderer) => {
  expect(validateOutputArtifacts([{ kind: 'chart', spec: { ...request.spec, style: { renderer } } }])[0].status).toBe(
    renderer === 'webgl' ? 'error' : 'valid'
  );
});
