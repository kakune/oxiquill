// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkBuiltLinks,
  classifyLink,
  parseLinkDocument,
  readBuiltSite
} from '../../packages/oxiquill/src/cli/check-links.mjs';
import { writeBuildReport } from '../../packages/oxiquill/src/astro/build-report.mjs';
import { runCli } from '../../packages/oxiquill/src/cli/commands.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { parseCliArguments } from '../../packages/oxiquill/src/cli/arguments.mjs';
import { createEventReporter } from '../../packages/oxiquill/src/cli/events.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const report = (overrides = {}) => ({
  outDir: '/unused',
  site: 'https://example.test',
  base: '/manual/',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  redirects: {},
  ...overrides
});
const entries = (files) =>
  Object.entries(files).map(([file, html]) => ({
    file,
    ...(file.endsWith('.html') ? { document: parseLinkDocument(html) } : {})
  }));
const check = (html, files = {}, options = {}) =>
  checkBuiltLinks(report(options), entries({ 'index.html': html, ...files }));

async function fixture(html = '<a href="#ok">ok</a><h1 id="ok">OK</h1>') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-links-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root, frameworkRoot: path.resolve('packages/oxiquill') });
  await mkdir(paths.outDir, { recursive: true });
  await writeFile(path.join(paths.outDir, 'index.html'), html);
  await writeBuildReport({ cacheDir: paths.cacheDir, dir: pathToFileURL(`${paths.outDir}/`), config: report() });
  return { root, paths };
}

describe('rendered local links', () => {
  it('parses HTML entities, legacy anchors and areas, ignoring comments and script text', () => {
    const parsed = parseLinkDocument(
      '<a name="old"></a><div id="a&amp;b"></div><area href="#a&amp;b"><!-- <a href="bad"> --><script>"<a href=bad>"</script>'
    );
    expect([...parsed.ids]).toEqual(['old', 'a&b']);
    expect(parsed.links).toEqual(['#a&b']);
    expect(parseLinkDocument('<meta http-equiv="REFRESH" content="0; URL=\'/manual/new/\'">').redirect).toBe(
      '/manual/new/'
    );
  });
  it('checks directory, index and explicit HTML URLs and ignores queries for lookup', () => {
    expect(
      check(
        '<a href="a/?q=1#ok"></a><area href="a/index.html#old"><a href="/manual/"></a><a href="#"></a><a href="#top"></a>',
        {
          'a/index.html': '<h1 id="ok"></h1><a name="old"></a><a href="../#top"></a>'
        }
      ).failures
    ).toEqual([]);
  });
  it('uses the document URL for relative resolution in both build formats', () => {
    for (const [file, options] of [
      ['nested/page/index.html', {}],
      ['nested/page.html', { build: { format: 'file' } }]
    ]) {
      const result = checkBuiltLinks(
        report(options),
        entries({
          [file]: '<a href="../target#日本語"></a>',
          ...(options.build
            ? { 'target.html': '<div id="日本語"></div>' }
            : { 'nested/target/index.html': '<div id="日本語"></div>' })
        })
      );
      expect(result.failures).toEqual([]);
    }
  });
  it('decodes Japanese fragments and reports missing and malformed fragments', () => {
    const result = check(
      '<a href="#%E6%97%A5%E6%9C%AC%E8%AA%9E"></a><h2 id="日本語"></h2><a href="#absent"></a><a href="#%FF"></a>'
    );
    expect(result.failures.map(({ reason }) => reason)).toEqual(['missing-fragment', 'missing-fragment']);
  });
  it('checks non-HTML assets for existence without checking their fragments', () => {
    expect(
      check('<a href="file.pdf#page=2"></a><a href="missing.png"></a>', { 'file.pdf': '' }).failures
    ).toMatchObject([{ reason: 'missing-page' }]);
  });
  it('never fetches external links or skipped schemes', () => {
    const fetch = vi.fn(() => {
      throw new Error('Network forbidden');
    });
    vi.stubGlobal('fetch', fetch);
    const hrefs = [
      'https://elsewhere.test/',
      '//elsewhere.test/',
      'https://example.test/outside/',
      'mailto:a@test',
      'tel:123',
      'data:text/plain,test',
      'javascript:void(0)',
      'blob:https://example.test/id',
      'ftp://example.test/'
    ];
    const result = check(hrefs.map((href) => `<a href="${href}"></a>`).join(''));
    expect(result.failures).toEqual([]);
    expect(result.totals.skipped).toBe(hrefs.length);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('distinguishes same-site absolute links from local paths outside base', () => {
    expect(
      check('<a href="https://example.test/manual/missing/"></a><a href="/manualish/"></a><a href="../outside"></a>')
        .failures.map(({ reason }) => reason)
        .sort()
    ).toEqual(['missing-page', 'outside-base', 'outside-base']);
    expect(
      classifyLink('https://oxiquill.invalid/manual/', 'https://oxiquill.invalid/manual/', report({ site: null }))
        .skipped
    ).toBe(true);
    expect(check('<a href="a/"></a>', { 'a/index.html': '' }, { site: null }).failures).toEqual([]);
  });
  it.each([
    ['always', '/manual/a', 'trailing-slash'],
    ['never', '/manual/a/', 'trailing-slash'],
    ['always', '/manual/a/', undefined],
    ['never', '/manual/a', undefined]
  ])('enforces %s for %s', (trailingSlash, href, reason) => {
    expect(check(`<a href="${href}"></a>`, { 'a/index.html': '' }, { trailingSlash }).failures[0]?.reason).toBe(reason);
  });
  it('exempts assets, explicit files and the root slash from slash policies', () => {
    expect(
      check(
        '<a href="/file.pdf"></a><a href="/index.html"></a><a href="/"></a>',
        { 'file.pdf': '' },
        { base: '/', trailingSlash: 'never' }
      ).failures
    ).toEqual([]);
  });
  it('follows configured redirects, preserving and overriding fragments', () => {
    expect(
      check(
        '<a href="old/#ok"></a><a href="override/#bad"></a>',
        { 'new/index.html': '<h2 id="ok"></h2>' },
        {
          redirects: {
            '/old/': '/manual/middle/',
            '/middle/': { destination: '/manual/new/', status: 302 },
            '/override/': '/manual/new/#ok'
          }
        }
      ).failures
    ).toEqual([]);
  });
  it('resolves dynamic and rest redirects without emitted redirect HTML', () => {
    expect(
      check(
        '<a href="old/one/#ok"></a><a href="legacy/a/b/#ok"></a><a href="legacy/#ok"></a>',
        {
          'new/one/index.html': '<h2 id="ok"></h2>',
          'new/a/b/index.html': '<h2 id="ok"></h2>',
          'new/index.html': '<h2 id="ok"></h2>'
        },
        {
          redirects: {
            '/old/[slug]': '/manual/new/[slug]/',
            '/legacy/[...path]': { destination: '/manual/new/[...path]/', status: 301 }
          }
        }
      ).failures
    ).toEqual([]);
  });
  it('reports root-relative redirect destinations outside base without prepending base', () => {
    expect(check('<a href="old/"></a>', {}, { redirects: { '/old': '/outside/' } }).failures).toMatchObject([
      { reason: 'outside-base' }
    ]);
  });
  it('uses canonical source URLs for base roots, dotted routes and encoded filenames', () => {
    for (const trailingSlash of ['always', 'never']) {
      expect(
        check(
          '<a href="#ok"></a><h2 id="ok"></h2>',
          {
            'version.1/index.html': '<a href="#ok"></a><h2 id="ok"></h2>',
            '日本語/index.html': '<a href="#ok"></a><h2 id="ok"></h2>',
            'a#b.html': '<a href="#ok"></a><h2 id="ok"></h2>'
          },
          { trailingSlash }
        ).failures
      ).toEqual([]);
    }
  });
  it('follows parsed HTML redirects, including external destinations', () => {
    expect(
      check('<a href="old/#ok"></a>', {
        'old/index.html': '<meta http-equiv="refresh" content="0;url=/manual/new/">',
        'new/index.html': '<div id="ok"></div>'
      }).failures
    ).toEqual([]);
    expect(
      check('<a href="old/#absent"></a>', {
        'old/index.html': '<meta http-equiv="refresh" content="0;url=https://elsewhere.test/">'
      }).totals.skipped
    ).toBe(1);
  });
  it('detects redirect loops and checks fragments at final targets', () => {
    expect(
      check(
        '<a href="a/"></a><a href="old/#absent"></a>',
        { 'new/index.html': '' },
        {
          redirects: { '/a/': '/manual/b/', '/b/': '/manual/a/', '/old/': '/manual/new/' }
        }
      )
        .failures.map(({ reason }) => reason)
        .sort()
    ).toEqual(['missing-fragment', 'redirect-loop']);
  });
  it('terminates expanding redirects that never revisit exactly the same URL', () => {
    expect(
      check(
        '<a href="old/a/"></a>',
        {},
        {
          redirects: { '/old/[...path]': '/manual/old/more/[...path]/' }
        }
      ).failures
    ).toMatchObject([{ reason: 'redirect-loop' }]);
  });
  it('reports missing locale routes and malformed URLs without crashing', () => {
    expect(
      check('<a href="ja/missing/"></a><a href="http://["></a><a href="bad%FF/"></a><a href="%2E%2E%2Fsecret"></a>')
        .failures
    ).toHaveLength(4);
  });
  it('deduplicates by target and reason with five distinct source examples and a total count', () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `${i}/index.html`,
        '<a href="/manual/missing/"></a><a href="/manual/missing/"></a>'
      ])
    );
    const result = check('', files);
    expect(result.failures).toMatchObject([{ count: 16, examples: expect.any(Array) }]);
    expect(result.failures[0].examples).toHaveLength(5);
    expect(result.totals).toMatchObject({ failures: 1, occurrences: 16 });
  });
});

describe('build inputs and CLI', () => {
  it.each([false, true])('keeps plain build behavior and checks only when opted in: %s', async (enabled) => {
    const { root, paths } = await fixture('<a href="#missing"></a>');
    const lines = [];
    const options = {
      loadProjectConfig: async () => ({ paths, cwd: root, astroConfigArgs: [] }),
      generate: async () => ({ generationId: 'test-generation' }),
      acquireLock: async () => ({ token: 'test-token', release: vi.fn() }),
      selectNode: () => process.execPath,
      runCommand: vi.fn(async () => undefined),
      log: (line) => lines.push(line)
    };
    const task = runCli(['build', '--format=json', ...(enabled ? ['--check-links'] : [])], options);
    if (enabled) await expect(task).rejects.toThrow('broken local');
    else await task;
    const events = lines.map(JSON.parse);
    expect(events.at(-1).exitStatus).toBe(enabled ? 1 : 0);
    expect(events.some(({ type }) => type === 'link-failure')).toBe(enabled);
    expect(options.runCommand.mock.calls.some(([, args]) => args.includes('--check-links'))).toBe(false);
    expect(await readFile(path.join(paths.outDir, 'index.html'), 'utf8')).toContain('#missing');
  });
  it('checks a clean build successfully', async () => {
    const { root, paths } = await fixture();
    const lines = [];
    await runCli(['build', '--check-links', '--format=json'], {
      loadProjectConfig: async () => ({ paths, cwd: root, astroConfigArgs: [] }),
      generate: async () => ({ generationId: 'test-generation' }),
      acquireLock: async () => ({ token: 'test-token', release: vi.fn() }),
      selectNode: () => process.execPath,
      runCommand: vi.fn(async () => undefined),
      log: (line) => lines.push(line)
    });
    expect(lines.map(JSON.parse).at(-1)).toMatchObject({ type: 'summary', exitStatus: 0, linkCheck: { failures: 0 } });
  });
  it('writes the completed output directory and resolved build settings', async () => {
    const { paths } = await fixture();
    const built = await readBuiltSite(paths.cacheDir);
    expect(built.report).toEqual(report({ outDir: paths.outDir }));
    expect(checkBuiltLinks(built.report, built.entries).failures).toEqual([]);
  });
  it('supports a build without a configured site URL', async () => {
    const { paths } = await fixture();
    await writeBuildReport({
      cacheDir: paths.cacheDir,
      dir: pathToFileURL(`${paths.outDir}/`),
      config: report({ site: undefined })
    });
    const built = await readBuiltSite(paths.cacheDir);
    expect(built.report.site).toBeNull();
    expect(checkBuiltLinks(built.report, built.entries).failures).toEqual([]);
  });
  it('distinguishes missing builds from missing pages and fragments', async () => {
    const { paths } = await fixture('<a href="missing/"></a><a href="#missing"></a>');
    const built = await readBuiltSite(paths.cacheDir);
    expect(
      checkBuiltLinks(built.report, built.entries)
        .failures.map(({ reason }) => reason)
        .sort()
    ).toEqual(['missing-fragment', 'missing-page']);
    await rm(paths.outDir, { recursive: true });
    await expect(readBuiltSite(paths.cacheDir)).rejects.toThrow('Run oxiquill build first');
    await rm(path.join(paths.cacheDir, 'build-report.json'));
    await expect(readBuiltSite(paths.cacheDir)).rejects.toThrow('Run oxiquill build first');
  });
  it.each(['{}', '{bad json', JSON.stringify(report({ outDir: 'relative' }))])(
    'rejects invalid reports: %s',
    async (contents) => {
      const { paths } = await fixture();
      await writeFile(path.join(paths.cacheDir, 'build-report.json'), contents);
      await expect(readBuiltSite(paths.cacheDir)).rejects.toThrow('Run oxiquill build first');
    }
  );
  it('runs standalone with no locks, processes, generation or writes', async () => {
    const { root, paths } = await fixture();
    const before = await readFile(path.join(paths.cacheDir, 'build-report.json'), 'utf8');
    const names = await readdir(root, { recursive: true });
    const acquireLock = vi.fn();
    const generate = vi.fn();
    const runCommand = vi.fn();
    const lines = [];
    await runCli(['check-links', '--format=json'], {
      loadProjectConfig: async () => ({ paths, astroConfigArgs: [] }),
      acquireLock,
      generate,
      runCommand,
      log: (line) => lines.push(line)
    });
    expect(acquireLock).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(await readdir(root, { recursive: true })).toEqual(names);
    expect(await readFile(path.join(paths.cacheDir, 'build-report.json'), 'utf8')).toBe(before);
    expect(lines.map(JSON.parse)).toEqual([
      { type: 'summary', linkCheck: { pages: 1, checked: 1, skipped: 0, failures: 0, occurrences: 0 }, exitStatus: 0 }
    ]);
  });
  it('emits failures and exactly one final nonzero summary', async () => {
    const { paths } = await fixture('<a href="#bad"></a>');
    const lines = [];
    await expect(
      runCli(['check-links', '--format=json'], {
        loadProjectConfig: async () => ({ paths, astroConfigArgs: [] }),
        log: (line) => lines.push(line)
      })
    ).rejects.toThrow('broken local');
    const events = lines.map(JSON.parse);
    expect(events[0]).toMatchObject({ type: 'link-failure', reason: 'missing-fragment' });
    expect(events.at(-1)).toMatchObject({ type: 'summary', exitStatus: 1 });
    expect(events.filter(({ type }) => type === 'summary')).toHaveLength(1);
  });
  it('reports input and usage errors as NDJSON with a final summary', async () => {
    const { paths } = await fixture();
    await rm(paths.outDir, { recursive: true });
    for (const args of [
      ['check-links', '--format=json'],
      ['check-links', '--format=json', '--bad']
    ]) {
      const lines = [];
      await expect(
        runCli(args, {
          loadProjectConfig: async () => ({ paths, astroConfigArgs: [] }),
          log: (line) => lines.push(line)
        })
      ).rejects.toThrow();
      expect(lines.map(JSON.parse).at(-1)).toMatchObject({ type: 'summary', exitStatus: 1 });
    }
  });
  it('renders useful human failures and link totals', () => {
    const lines = [];
    const render = createEventReporter({ write: (line) => lines.push(line) });
    const result = check('<a href="#bad"></a>');
    result.failures.forEach(render);
    render({ type: 'summary', linkCheck: result.totals, exitStatus: 1 });
    expect(lines.join('\n')).toContain('missing-fragment:');
    expect(lines.join('\n')).toContain('"#bad"');
    expect(lines.join('\n')).toContain('1 broken target(s)');
  });
  it('consumes build flags and rejects explain and invalid format combinations', () => {
    expect(parseCliArguments(['build', '--check-links', '--', '--outDir', 'output']).commandArgs).toEqual([
      '--outDir',
      'output'
    ]);
    expect(() => parseCliArguments(['build', '--check-links', '--explain'])).toThrow('--explain cannot');
    expect(() => parseCliArguments(['check-links', '--format=yaml'])).toThrow();
  });
});
