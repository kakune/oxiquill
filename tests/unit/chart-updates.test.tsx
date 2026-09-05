import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChartOutput, {
  chartSpecToEChartsOptions,
  chartStructuralSignature,
  resolveChartChrome
} from '../../packages/oxiquill/src/components/doc-runtime/ChartOutput';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import { chart, echartsInit } from './mocks/external-runtime';

const line: ChartSpec = { kind: 'line', series: [{ points: [[0, 1]] }] };
const labels = labelsForLanguage('en');
const disconnect = vi.fn();
function output(spec: ChartSpec) {
  return <ChartOutput artifact={{ kind: 'chart', spec }} idPrefix="chart" labels={labels} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  chart.setOption.mockReset();
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal(
    'ResizeObserver',
    class {
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
  vi.unstubAllGlobals();
});

describe('persistent chart updates', () => {
  it('merges data on the same canvas and instance without resetting zoom', async () => {
    const view = render(output(line));
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(1));
    const plot = screen.getByTestId('doc-plot');
    const canvas = plot.querySelector('canvas');
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ series: [expect.objectContaining({ id: 'line:0' })] }),
      { notMerge: true }
    );
    view.rerender(output({ ...line, series: [{ points: [[0, 2]] }, { points: [[1, 3]] }] }));
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
    expect(document.querySelector('.doc-chart-output__summary')?.textContent).toBe(summary);
    expect(screen.getByTestId('doc-plot').querySelector('canvas')).toBe(canvas);
    fireEvent.click(screen.getByRole('button', { name: 'Retry chart rendering' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: expect.objectContaining({ text: 'Latest' }) }),
      { notMerge: true }
    );
    expect(echartsInit).toHaveBeenCalledOnce();
    expect(chart.dispose).not.toHaveBeenCalled();
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
    for (const patch of [
      { xType: 'time' },
      { yType: 'log' },
      { title: 'Title' },
      { legend: true },
      { tooltip: false },
      { dataZoom: false }
    ]) {
      expect(chartStructuralSignature({ ...line, ...patch } as ChartSpec)).not.toBe(chartStructuralSignature(line));
    }
    expect(
      chartStructuralSignature({
        ...line,
        series: [
          { name: 'A', points: [] },
          { name: 'B', points: [] }
        ]
      })
    ).not.toBe(chartStructuralSignature(line));
  });

  it.each(['light', 'dark'] as const)('resolves Starlight chrome and curated options in %s', (theme) => {
    const element = document.createElement('div');
    element.style.cssText =
      '--sl-color-text:#123456;--sl-color-gray-2:#234567;--sl-color-gray-5:#345678;--sl-color-bg:#456789;font-family:serif';
    document.body.append(element);
    const chrome = resolveChartChrome(theme, element);
    expect(chrome).toEqual({
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
      grid: { containLabel: true },
      xAxis: { splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
      series: [{ lineStyle: { width: 8, cap: 'round', join: 'round' }, showSymbol: false }],
      tooltip: { confine: true },
      textStyle: { color: '#123456', fontFamily: 'serif' }
    });
    expect(chartSpecToEChartsOptions({ ...line, style: { palette: { light: ['#123'] } } }, 'dark').color).toEqual([
      '#5eead4',
      '#60a5fa',
      '#c4b5fd',
      '#f9a8d4',
      '#fbbf24',
      '#cbd5e1'
    ]);
    expect(chartSpecToEChartsOptions({ kind: 'scatter', series: [], style: { symbolSize: 32 } }, theme).animation).toBe(
      true
    );
    expect(
      chartSpecToEChartsOptions({ kind: 'heatmap', data: [], style: { palette: { [theme]: ['#123', '#456'] } } }, theme)
    ).toMatchObject({ visualMap: { inRange: { color: ['#123', '#456'] } } });
    element.remove();
  });
});
