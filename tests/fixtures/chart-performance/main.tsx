import { render } from 'preact';
import ChartOutput from '@chart-source/components/doc-runtime/ChartOutput';
import { loadECharts } from '@chart-source/lib/doc-runtime/echarts-runtime';
import { chartSpecToEChartsOptions } from '@chart-source/lib/doc-runtime/chart-options';
import { normalizeCellExecutionResult } from '@chart-source/lib/doc-runtime/output-artifacts';
import { labelsForLanguage } from '@chart-source/lib/doc-runtime/runtime-localization';
import '@starlight-props';
import '@chart-source/styles/custom.css';

const app = document.getElementById('app');
if (!app) throw new Error('Missing benchmark container.');
const labels = labelsForLanguage('en');
document.documentElement.dataset.theme = 'light';
const echarts = await loadECharts();
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
await new Promise((resolve) => worker.addEventListener('message', resolve, { once: true }));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
let pending = 0;
let setOptionMs = 0;
let progressiveOff = false;
// Instrument the real component's instances without adding production measurement hooks.
const probe = echarts.init(document.createElement('div'), undefined, { width: 720, height: 360 });
const prototype = Object.getPrototypeOf(probe);
const original = prototype.setOption;
prototype.setOption = function (options, settings) {
  if (progressiveOff && options.series)
    options.series = options.series.map((series) => ({ ...series, progressive: 0 }));
  pending++;
  const finished = () => {
    this.off('finished', finished);
    pending--;
  };
  this.on('finished', finished);
  const start = performance.now();
  try {
    return original.call(this, options, settings);
  } finally {
    setOptionMs += performance.now() - start;
  }
};
probe.dispose();

async function settled() {
  do {
    await frame();
    await frame();
  } while (pending > 0 || !app.querySelector('.doc-plot canvas'));
  const error = app.querySelector('[role="alert"]');
  if (error) throw new Error(error.textContent ?? 'Chart rendering failed.');
}

async function update(kind: string, count: number, revision: number) {
  const sent = performance.now();
  const response = new Promise<MessageEvent>((resolve) => worker.addEventListener('message', resolve, { once: true }));
  worker.postMessage({ kind, count, revision });
  const { data } = await response;
  const received = performance.now();
  const transferMs = performance.timeOrigin + received - data.sentAt;
  const normalized = normalizeCellExecutionResult(data.result);
  const artifact = normalized.outputs[0];
  if (normalized.outputResults.some((output) => output.status !== 'valid') || artifact?.kind !== 'chart')
    throw new Error('Benchmark output did not validate.');
  const normalizedAt = performance.now();
  const optionStart = performance.now();
  chartSpecToEChartsOptions(artifact.spec, 'light', { canvasLegend: false });
  const optionMs = performance.now() - optionStart;
  setOptionMs = 0;
  const start = performance.now();
  render(<ChartOutput artifact={artifact} labels={labels} idPrefix="benchmark" />, app);
  await settled();
  const workerMetrics = { ...data };
  delete workerMetrics.result;
  delete workerMetrics.sentAt;
  return {
    ...workerMetrics,
    workerRoundTripMs: received - sent,
    transferMs,
    normalizationMs: normalizedAt - received,
    optionMs,
    renderMs: performance.now() - start,
    setOptionMs
  };
}

Object.assign(window, {
  chartBenchmark: async (kind: string, count: number, disableProgressive = false) => {
    progressiveOff = disableProgressive;
    const initial = await update(kind, count, 0);
    const updated = await update(kind, count, 1);
    const element = app.querySelector('.doc-plot');
    const chart = element && echarts.getInstanceByDom(element);
    if (!chart) throw new Error('Missing chart instance.');
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const finished = () => {
        chart.off('finished', finished);
        resolve();
      };
      chart.on('finished', finished);
      chart.dispatchAction({ type: 'dataZoom', start: 45, end: 55 });
    });
    const zoomMs = performance.now() - start;
    await settled();
    render(null, app);
    await frame();
    await frame();
    return { initial, updated, zoomMs };
  },
  chartStyleCost: () => {
    const categories = Array.from({ length: 100000 }, (_, index) => String(index));
    return Object.fromEntries(
      [false, true].map((negative) => {
        const spec = {
          kind: 'bar',
          categories,
          series: [{ values: categories.map((_, index) => (negative && index % 2 ? -index : index)) }]
        };
        const samples = Array.from({ length: 7 }, () => {
          const start = performance.now();
          const options = chartSpecToEChartsOptions(spec, 'light');
          return {
            ms: performance.now() - start,
            wrapped: options.series[0].data.filter((value) => typeof value === 'object').length
          };
        }).slice(2);
        return [negative ? 'mixed' : 'positive', samples];
      })
    );
  }
});
