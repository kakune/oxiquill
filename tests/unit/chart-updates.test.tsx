import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChartOutput, {
  chartSpecToEChartsOptions,
  chartStructuralSignature,
  resolveChartChrome
} from '../../packages/oxiquill/src/components/doc-runtime/ChartOutput';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import { chartPalette } from '../../packages/oxiquill/src/lib/doc-runtime/chart-palette';
import { chart, echartsInit } from './mocks/external-runtime';

const line: ChartSpec = { kind: 'line', series: [{ points: [[0, 1]] }] };
const labels = labelsForLanguage('en');
const disconnect = vi.fn();
let resizeCallback: ResizeObserverCallback;
function output(spec: ChartSpec) {
  return <ChartOutput artifact={{ kind: 'chart', spec }} idPrefix="chart" labels={labels} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  chart.getOption.mockReturnValue({});
  chart.setOption.mockReset();
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  echartsInit.mockImplementation((element) => {
    element?.replaceChildren(document.createElement('canvas'));
    return chart;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('persistent chart updates', () => {
  it.each([false, true])('switches renderers while respecting a changed range (%s)', async (changedRange) => {
    const view = render(output(line));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    chart.getOption.mockReturnValue({
      dataZoom: [{ start: 20, end: 80 }],
      legend: [{ selected: { 'line:0': false } }]
    });
    view.rerender(output({ ...line, style: { renderer: 'svg' }, ...(changedRange ? { xMin: 0, xMax: 10 } : {}) }));
    await waitFor(() => expect(echartsInit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(chart.setOption).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dataZoom: [expect.objectContaining({ start: changedRange ? 0 : 20, end: changedRange ? 100 : 80 })],
          legend: expect.objectContaining({ selected: { 'line:0': false } })
        }),
        { notMerge: true }
      )
    );
  });

  it('offers a lazy data table, keyboard legend actions, and an explicit zoom reset', async () => {
    const spec: ChartSpec = {
      kind: 'line',
      series: [
        { name: 'First', points: [[0, 1]] },
        { name: 'Second', points: [[1, 2]] }
      ]
    };
    render(output(spec));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeEnabled());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const first = screen.getByRole('button', { name: 'First' });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(first);
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'legendToggleSelect', name: 'line:0' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'dataZoom', start: 0, end: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Show data as a table' }));
    expect(screen.getByRole('table')).toHaveTextContent('First');
    fireEvent.click(screen.getByRole('button', { name: 'Hide data table' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show data as a table' })).toHaveFocus();
  });

  it('tracks legend selection from events and restored state without cloning chart options', async () => {
    const spec = (y: number): ChartSpec => ({
      kind: 'line',
      series: [
        { name: 'First', points: [[0, y]] },
        { name: 'Second', points: [[1, y]] }
      ]
    });
    const view = render(output(spec(1)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toBeEnabled());
    const selectionChanged = chart.on.mock.calls.find(([event]) => event === 'legendselectchanged')?.[1] as (
      params: unknown
    ) => void;
    act(() => selectionChanged({ name: 'line:0', selected: { 'line:0': false, 'line:1': true } }));
    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Second' })).toHaveAttribute('aria-pressed', 'true');
    view.rerender(output(spec(2)));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-pressed', 'false');
    expect(chart.getOption).not.toHaveBeenCalled();

    chart.getOption.mockReturnValue({ legend: [{ selected: { 'line:1': false } }] });
    view.rerender(output({ ...spec(2), style: { renderer: 'svg' } }));
    await waitFor(() => expect(echartsInit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Second' })).toHaveAttribute('aria-pressed', 'false')
    );
    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([false, true])('respects explicit showSymbol=%s through viewport updates', async (showSymbol) => {
    let extent = [0, 2];
    const instance = {
      ...chart,
      getModel: () => ({ getComponent: () => ({ axis: { scale: { parse: Number, getExtent: () => extent } } }) })
    };
    echartsInit.mockReturnValue(instance);
    const spec: ChartSpec = {
      kind: 'line',
      series: [
        {
          id: 'stable',
          points: [
            [0, 0],
            [1, 1],
            [2, 2]
          ],
          style: { showSymbol }
        }
      ]
    };
    render(output(spec));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    expect(chart.setOption.mock.calls[0][0].series).toMatchObject([{ id: 'line:id:stable', showSymbol }]);
    const zoom = chart.on.mock.calls.find(([event]) => event === 'datazoom')?.[1] as () => void;
    act(() => {
      extent = [0.5, 1.5];
      zoom();
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(chart.setOption).toHaveBeenCalledOnce();
  });
  it('resets only zoom when authored bounds change or are removed', async () => {
    const view = render(output({ ...line, yMin: 0, yMax: 1 }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    view.rerender(output({ ...line, yMin: 0, yMax: 2 }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ dataZoom: [expect.objectContaining({ start: 0, end: 100 })] }),
      expect.objectContaining({ notMerge: false })
    );
    view.rerender(output(line));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(3));
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        yAxis: expect.objectContaining({ min: null, max: null }),
        dataZoom: expect.any(Array)
      }),
      expect.objectContaining({ notMerge: false })
    );
  });
  it('resizes the canvas after an authored height update has already changed layout options', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360);
    const view = render(output(line));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    view.rerender(output({ ...line, style: { height: 600 } }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    height.mockReturnValue(600);
    act(() => resizeCallback([], {} as ResizeObserver));
    await waitFor(() => expect(chart.resize).toHaveBeenCalledOnce());
    expect(chart.setOption).toHaveBeenCalledTimes(2);
  });
  it('updates isolated points and zero visibility from the viewport without converting every point to pixels', async () => {
    let extent = [0, 2];
    let yExtent = [-1, 2];
    const instance = {
      ...chart,
      getModel: () => ({
        getComponent: (axis: string) => ({
          axis: { scale: { parse: Number, getExtent: () => (axis === 'xAxis' ? extent : yExtent) } }
        })
      })
    };
    echartsInit.mockReturnValue(instance);
    render(
      output({
        kind: 'line',
        series: [
          {
            points: [
              [2, 2],
              [0, -1],
              [1, 1]
            ]
          }
        ]
      })
    );
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    const zoom = chart.on.mock.calls.find(([event]) => event === 'datazoom')?.[1] as () => void;
    act(() => {
      extent = [0.5, 1.5];
      yExtent = [0.9, 1.1];
      zoom();
    });
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(chart.setOption).toHaveBeenLastCalledWith({
      xAxis: { axisLine: { show: false } },
      series: [{ id: 'line:0', showSymbol: true }]
    });
    act(() => {
      extent = [0, 2];
      yExtent = [-1, 2];
      zoom();
    });
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(3));
    expect(chart.setOption).toHaveBeenLastCalledWith({
      xAxis: { axisLine: { show: true } },
      series: [{ id: 'line:0', showSymbol: false }]
    });
    expect(chart.convertToPixel).not.toHaveBeenCalled();
  });
  it('coalesces resize notifications and sends only layout changes', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720);
    render(output(line));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    width.mockReturnValue(360);
    act(() => {
      resizeCallback([], {} as ResizeObserver);
      resizeCallback([], {} as ResizeObserver);
    });
    await waitFor(() => expect(chart.resize).toHaveBeenCalledOnce());
    expect(chart.setOption).toHaveBeenCalledTimes(2);
    expect(chart.setOption.mock.calls[1][0]).not.toHaveProperty('series');
    expect(chart.setOption.mock.calls[1][0]).not.toHaveProperty('dataZoom');
    expect(echartsInit).toHaveBeenCalledOnce();
  });
  it('merges data on the same canvas and instance without resetting zoom', async () => {
    const view = render(output({ ...line, legend: false }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(1));
    const plot = screen.getByTestId('doc-plot');
    const canvas = plot.querySelector('canvas');
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ series: [expect.objectContaining({ id: 'line:0' })] }),
      { notMerge: true }
    );
    view.rerender(output({ ...line, legend: false, series: [{ points: [[0, 2]] }, { points: [[1, 3]] }] }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(chart.setOption).toHaveBeenLastCalledWith(expect.not.objectContaining({ dataZoom: expect.anything() }), {
      notMerge: false,
      lazyUpdate: true,
      replaceMerge: ['series']
    });
    expect(screen.getByTestId('doc-plot')).toBe(plot);
    expect(plot.querySelector('canvas')).toBe(canvas);
    expect(echartsInit).toHaveBeenCalledOnce();
    expect(chart.dispose).not.toHaveBeenCalled();
    view.rerender(output({ kind: 'bar', categories: ['a'], series: [{ values: [2] }] }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(3));
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ series: [expect.objectContaining({ id: 'bar:0' })] }),
      { notMerge: true }
    );
    expect(echartsInit).toHaveBeenCalledOnce();
    view.unmount();
    expect(chart.dispose).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the last successful canvas and accessible summary after an update fails, and retries the latest spec', async () => {
    const view = render(output(line));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    const canvas = screen.getByTestId('doc-plot').querySelector('canvas');
    const summary = document.querySelector('.doc-chart-output__summary')?.textContent;
    chart.setOption.mockImplementationOnce(() => {
      throw new Error('update failed');
    });
    const latest: ChartSpec = {
      ...line,
      title: 'Latest',
      style: { height: 700 },
      series: [
        {
          points: [
            [0, 7],
            [1, 9]
          ]
        }
      ]
    };
    view.rerender(output(latest));
    await screen.findByRole('alert');
    expect(screen.getByTestId('doc-plot').style.height).toBe('360px');
    expect(document.querySelector('.doc-chart-output__summary')?.textContent).toBe(summary);
    expect(screen.getByTestId('doc-plot').querySelector('canvas')).toBe(canvas);
    fireEvent.click(screen.getByRole('button', { name: 'Retry chart rendering' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: [
          expect.objectContaining({
            data: [
              [0, 7],
              [1, 9]
            ]
          })
        ]
      }),
      { notMerge: true }
    );
    expect(echartsInit).toHaveBeenCalledOnce();
    expect(chart.dispose).not.toHaveBeenCalled();
    expect(screen.getByText('Latest')).toBeInTheDocument();
    expect(screen.getByTestId('doc-plot').style.height).toBe('700px');
  });

  it('cleans up failed initialization before retrying', async () => {
    chart.setOption.mockImplementationOnce(() => {
      throw new Error('initialization failed');
    });
    render(output(line));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry chart rendering' }));
    await waitFor(() => expect(echartsInit).toHaveBeenCalledTimes(2));
    expect(chart.dispose).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reacts to reduced motion without recreating the chart and removes the listener', async () => {
    let matches = true;
    const events = new EventTarget();
    const remove = vi.fn(events.removeEventListener.bind(events));
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: remove
      }))
    );
    const view = render(output({ ...line, style: { animation: true, animationDurationMs: 900 } }));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledOnce());
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ animation: false, animationDuration: 0, animationDurationUpdate: 0 }),
      { notMerge: true }
    );
    expect(screen.getByTestId('doc-plot')).toHaveAttribute('data-chart-motion', 'reduced');
    act(() => {
      matches = false;
      events.dispatchEvent(new Event('change'));
    });
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ animation: true, animationDurationUpdate: 900 }),
      expect.anything()
    );
    expect(screen.getByTestId('doc-plot')).toHaveAttribute('data-chart-motion', 'full');
    expect(echartsInit).toHaveBeenCalledOnce();
    view.unmount();
    expect(remove).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('compares effective structures, excluding data and cosmetic changes', () => {
    expect(chartStructuralSignature(line)).toBe(
      chartStructuralSignature({
        ...line,
        xType: 'value',
        yType: 'value',
        tooltip: true,
        dataZoom: true,
        legend: false,
        style: { lineWidth: 8 }
      })
    );
    for (const patch of [{ xType: 'time' }, { yType: 'log' }, { tooltip: false }, { dataZoom: false }]) {
      expect(chartStructuralSignature({ ...line, ...patch } as ChartSpec)).not.toBe(chartStructuralSignature(line));
    }
    expect(chartStructuralSignature({ ...line, title: 'Title', style: { height: 240 } })).toBe(
      chartStructuralSignature(line)
    );
    expect(
      chartStructuralSignature({
        ...line,
        series: [
          { name: 'A', points: [] },
          { name: 'B', points: [] }
        ]
      })
    ).toBe(chartStructuralSignature(line));
  });

  it.each(['light', 'dark'] as const)('resolves Starlight chrome and curated options in %s', (theme) => {
    const element = document.createElement('div');
    element.style.cssText =
      '--sl-color-text:#123456;--sl-color-gray-2:#234567;--sl-color-gray-5:#345678;--sl-color-bg:#456789;font-family:serif';
    document.body.append(element);
    const chrome = resolveChartChrome(theme, element);
    expect(chrome).toEqual({
      background: theme === 'light' ? '#fefefe' : '#181a1e',
      text: '#123456',
      axis: '#234567',
      border: '#345678',
      splitLine: '#345678',
      tooltipBackground: '#456789',
      fontFamily: 'serif'
    });
    const options = chartSpecToEChartsOptions(
      { ...line, style: { lineWidth: 8, showGrid: false, palette: { light: ['#123'], dark: ['#456'] } } },
      theme,
      { chrome }
    );
    expect(options).toMatchObject({
      color: [theme === 'light' ? '#123' : '#456'],
      animation: true,
      animationDurationUpdate: 180,
      animationEasingUpdate: 'cubicOut',
      grid: { outerBoundsContain: 'all', outerBoundsMode: 'auto' },
      xAxis: { splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
      series: [{ lineStyle: { width: 8, cap: 'round', join: 'round' }, showSymbol: true }],
      tooltip: { confine: true },
      textStyle: { color: '#123456', fontFamily: 'serif' }
    });
    expect(chartSpecToEChartsOptions({ ...line, style: { palette: { light: ['#123'] } } }, 'dark').color).toEqual(
      chartPalette
    );
    expect(chartSpecToEChartsOptions({ kind: 'scatter', series: [], style: { symbolSize: 32 } }, theme).animation).toBe(
      true
    );
    expect(
      chartSpecToEChartsOptions({ kind: 'heatmap', data: [], style: { palette: { [theme]: ['#123', '#456'] } } }, theme)
    ).toMatchObject({ visualMap: { inRange: { color: ['#123', '#456'] } } });
    element.remove();
  });
});
