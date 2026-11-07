import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Run against the installed tarball, with no imports from Oxiquill's source tree.
export async function assertPackedLinks({ consumerRoot, cliPath, environment }) {
  const configPath = path.join(consumerRoot, 'astro.config.mjs');
  const original = await readFile(configPath, 'utf8');
  const pageDir = path.join(consumerRoot, 'pages');
  const publicFile = path.join(consumerRoot, 'public/link-fixture.pdf');
  // Keep custom output under the starter's excluded dist tree so subsequent
  // Astro checks do not type-check generated JavaScript bundles.
  const outputDir = path.join(consumerRoot, 'dist/link output');
  const invoke = (args, status = 0) => {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: consumerRoot,
      env: environment,
      encoding: 'utf8'
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const events = (args, status = 0) =>
    invoke([...args, '--format=json'], status)
      .trim()
      .split(/\r?\n/u)
      .map(JSON.parse);
  const page = (links) =>
    `<!doctype html><html lang="en"><head><title>Links</title></head><body><h1 id="日本語">日本語</h1><a name="legacy"></a>${links}</body></html>`;
  const anchor = (href) => `<a href="${href}">Link</a>`;
  try {
    await mkdir(pageDir, { recursive: true });
    await mkdir(path.dirname(publicFile), { recursive: true });
    await writeFile(publicFile, 'fixture');
    for (const [format, trailingSlash] of [
      ['directory', 'always'],
      ['directory', 'never'],
      ['file', 'never']
    ]) {
      const suffix = trailingSlash === 'always' ? '/' : '';
      const route = `/manual/link-target${suffix}`;
      const redirects = { '/link-old': route };
      const fixtureConfig = (mapping) =>
        original.replace(
          'framework: { starlight },',
          [
            'framework: { starlight },',
            "  base: '/manual/',",
            `  trailingSlash: '${trailingSlash}', build: { format: '${format}' },`,
            `  redirects: ${JSON.stringify(mapping)},`
          ].join('\n')
        );
      const cleanConfig = fixtureConfig(redirects);
      await writeFile(configPath, cleanConfig);
      await mkdir(pageDir, { recursive: true });
      const pagePath = path.join(pageDir, 'link-target.astro');
      const links = [
        route + '#%E6%97%A5%E6%9C%AC%E8%AA%9E',
        route + '?q=1#legacy',
        `/manual/link-old${suffix}#日本語`,
        '/manual/link-fixture.pdf#page=2',
        '#',
        '#top',
        'https://external.invalid/',
        'mailto:test@example.test'
      ];
      await writeFile(pagePath, page(links.map(anchor).join('')));
      const buildEvents = events(['build', '--check-links', '--outDir', outputDir]);
      assert.equal(buildEvents.at(-1).exitStatus, 0);
      assert.equal(buildEvents.at(-1).linkCheck.failures, 0);
      const buildReport = JSON.parse(await readFile(path.join(consumerRoot, '.oxiquill/build-report.json'), 'utf8'));
      assert.equal(path.resolve(buildReport.outDir), outputDir);
      assert.equal(buildReport.build.format, format);
      assert.equal(events(['check-links']).at(-1).linkCheck.failures, 0);
      const broken = [route + '#absent', '/manual/ja/missing/', '/outside/', `/manual/link-target${suffix ? '' : '/'}`];
      await writeFile(pagePath, page([...links, ...broken].map(anchor).join('')));
      // Plain build must still pass with broken links.
      invoke(['build', '--outDir', outputDir]);
      const failed = events(['check-links'], 1);
      assert.deepEqual(
        [...new Set(failed.filter(({ type }) => type === 'link-failure').map(({ reason }) => reason))].sort(),
        ['missing-fragment', 'missing-page', 'outside-base', 'trailing-slash']
      );
      assert.equal(failed.at(-1).exitStatus, 1);
      assert.equal(events(['build', '--check-links', '--outDir', outputDir], 1).at(-1).exitStatus, 1);
      assert.ok(
        await readFile(path.join(outputDir, format === 'file' ? 'link-target.html' : 'link-target/index.html'), 'utf8')
      );
      if (format === 'directory' && trailingSlash === 'always') {
        await writeFile(
          configPath,
          fixtureConfig({
            ...redirects,
            '/link-loop-a': '/manual/link-loop-b/',
            '/link-loop-b': '/manual/link-loop-a/'
          })
        );
        await writeFile(pagePath, page(anchor('/manual/link-loop-a/')));
        invoke(['build', '--outDir', outputDir]);
        assert.ok(events(['check-links'], 1).some(({ reason }) => reason === 'redirect-loop'));
      }
    }
  } finally {
    await writeFile(configPath, original);
    await rm(pageDir, { recursive: true, force: true });
    await rm(publicFile, { force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
}
