// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCiResults, chartDependencySignature, classifyChanges } from '../../.github/scripts/ci-changes.mjs';

const { parse } = createRequire(resolve('packages/oxiquill/package.json'))('yaml');
const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('CI change selection', () => {
  it.each([[], ['README.md'], ['packages/oxiquill/README.md', '.github/notes.md']].map((files) => ({ files })))(
    'skips expensive jobs for $files',
    ({ files }) => {
      expect(Object.values(classifyChanges(files))).toEqual([false, false, false, false, false]);
    }
  );
  it.each(['examples/docs-site/content/docs/index.mdx', 'examples/docs-site/crates/helper/src/lib.rs', 'flake.nix'])(
    'runs Linux checks for %s',
    (file) => {
      expect(classifyChanges([file])).toEqual({
        site: true,
        runtime: true,
        consumerLinux: true,
        consumerPlatforms: false,
        charts: false
      });
    }
  );
  it.each([
    'packages/oxiquill/src/index.ts',
    'tests/package/consumer-smoke.mjs',
    'package.json',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml'
  ])('runs every platform for %s', (file) => {
    expect(classifyChanges([file])).toMatchObject({
      site: true,
      runtime: true,
      consumerLinux: true,
      consumerPlatforms: true
    });
  });
  it.each([
    'tests/fixtures/chart-gallery/main.tsx',
    'tests/unit/chart-layout.test.mjs',
    'packages/oxiquill/src/components/doc-runtime/ChartOutput.tsx',
    'packages/oxiquill/src/lib/doc-runtime/echarts-runtime.ts',
    'packages/oxiquill/src/styles/custom.css'
  ])('captures the baseline for %s', (file) => {
    expect(classifyChanges([file]).charts).toBe(true);
  });
  it('preserves deleted source paths in a rename to Markdown', () => {
    expect(classifyChanges(['packages/oxiquill/src/chart-options.ts', 'docs/removed.md']).charts).toBe(true);
  });
  it('runs the full release matrix even for Markdown-only changes', () => {
    expect(Object.values(classifyChanges(['CHANGELOG.md'], { headRef: 'release/v1.0.0' }))).toEqual([
      true,
      true,
      true,
      true,
      true
    ]);
  });
  it('distinguishes ECharts dependency updates from unrelated dependency changes', () => {
    const manifest = JSON.stringify({ dependencies: { echarts: '6.1.0' } });
    const lock =
      'packages:\n  echarts@6.1.0:\n    resolution: {integrity: original}\n\n  unrelated@1:\n    resolution: unchanged\nsnapshots:\n  echarts@6.1.0:\n    dependencies:\n      zrender: 6.1.0\n';
    const baseline = chartDependencySignature(manifest, lock);
    expect(chartDependencySignature(manifest, lock.replace('unrelated@1', 'unrelated@2'))).toBe(baseline);
    expect(chartDependencySignature(manifest, lock.replace('original', 'changed'))).not.toBe(baseline);
    expect(chartDependencySignature(manifest, lock.replace('zrender: 6.1.0', 'zrender: 6.2.0'))).not.toBe(baseline);
    expect(chartDependencySignature(manifest.replace('6.1.0', '6.2.0'), lock)).not.toBe(baseline);
    expect(classifyChanges(['pnpm-lock.yaml'], { chartDependenciesChanged: true }).charts).toBe(true);
  });
});

describe('CI job graph and aggregation', () => {
  it('expands to twelve jobs and only four for documentation', () => {
    expect(Object.values(jobs).reduce((count, job) => count + (job.strategy?.matrix.include.length ?? 1), 0)).toBe(12);
    expect(
      Object.entries(jobs)
        .filter(([, job]) => !job.needs || job.if === 'always()')
        .map(([name]) => name)
    ).toEqual(['changes', 'js-quality', 'rust-quality', 'ci-ok']);
    expect(jobs.browser.needs).toBe('site-build');
    expect(jobs['ci-ok'].needs.toSorted()).toEqual(
      Object.keys(jobs)
        .filter((name) => name !== 'ci-ok')
        .sort()
    );
    expect(jobs['ci-ok'].name).toBe('ci-ok');
  });
  it('keeps static checks independent and all consumer package managers covered', () => {
    expect(jobs['js-quality'].needs).toBeUndefined();
    expect(jobs['rust-quality'].needs).toBeUndefined();
    const jsSteps = jobs['js-quality'].steps;
    expect(jsSteps.findIndex((step) => step.run === 'pnpm build:package')).toBeLessThan(
      jsSteps.findIndex((step) => step.run?.includes('pnpm check:types'))
    );
    for (const [platform, command] of [
      ['linux', 'test:consumer:npm'],
      ['linux', 'test:packed-browser'],
      ['macos', 'test:consumer:pnpm'],
      ['windows', 'test:consumer:npm']
    ])
      expect(jobs[`consumer-${platform}`].steps.some((step) => step.run === `pnpm ${command}`)).toBe(true);
    for (const platform of ['macos', 'windows'])
      expect(jobs[`consumer-${platform}`].steps.some((step) => step.run === 'pnpm test:unit')).toBe(true);
    for (const name of ['site-build', 'runtime', 'consumer-linux', 'consumer-macos', 'consumer-windows']) {
      expect(jobs[name].needs).toBe('changes');
      expect(jobs[name].if).toMatch(/^needs\.changes\.outputs\.\w+ == 'true'$/u);
    }
  });
  it('gates only baseline capture and forwards its decision through the site job', () => {
    expect(jobs['site-build'].outputs.charts).toBe('${{ needs.changes.outputs.charts }}');
    for (const name of ['Prepare baseline chart sources', 'Capture baseline chart gallery'])
      expect(jobs.browser.steps.find((step) => step.name === name).if).toContain(
        "needs.site-build.outputs.charts == 'true'"
      );
  });
  it('accepts intentional skips and successful checks', () => {
    expect(() => assertCiResults({ quality: { result: 'success' }, browser: { result: 'skipped' } })).not.toThrow();
  });
  it.each(['failure', 'cancelled', 'unknown'])('fails the aggregate for %s', (result) => {
    expect(() => assertCiResults({ quality: { result: 'success' }, browser: { result } })).toThrow(
      `browser (${result})`
    );
  });
});
