// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBrowserBundleBudget,
  BROWSER_BUNDLE_REPORT_FILE,
  CLIENT_CHUNK_LIMIT_BYTES,
  createBrowserBundleCollector,
  createBrowserBundleReport,
  generateBrowserBundleReport,
  syncBrowserBundleReport
} from '../../packages/oxiquill/src/generator/browser-bundle-report.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('browser bundle report', () => {
  it('collects deterministic main and worker chunk metadata', () => {
    const collector = createBrowserBundleCollector();
    const workspaceRoot = path.join(path.sep, 'repo');

    collector.add('main', {
      asset: { fileName: 'style.css', source: '', type: 'asset' },
      interactive: makeChunk({
        code: 'import "./shared.js";',
        dynamicImports: ['_astro/ChartOutput.js'],
        facadeModuleId: path.join(workspaceRoot, 'packages/oxiquill/src/components/doc-runtime/InteractiveCell.tsx'),
        fileName: '_astro/InteractiveCell.js',
        imports: ['_astro/shared.js'],
        modules: {
          [path.join(workspaceRoot, 'packages/oxiquill/src/components/doc-runtime/InteractiveCell.tsx')]: {},
          [path.join(workspaceRoot, 'node_modules/.pnpm/preact@1/node_modules/preact/dist/preact.js')]: {}
        }
      })
    });
    collector.add('worker', {
      worker: makeChunk({
        code: 'self.onmessage = () => {};',
        facadeModuleId: path.join(workspaceRoot, 'packages/oxiquill/src/lib/doc-runtime/rust-worker.ts'),
        fileName: '_astro/rust-worker.js'
      })
    });

    const report = createBrowserBundleReport(collector.snapshot(), { workspaceRoot });

    expect(report).toEqual({
      schemaVersion: 1,
      limitBytes: CLIENT_CHUNK_LIMIT_BYTES,
      chunks: [
        expect.objectContaining({
          fileName: '_astro/InteractiveCell.js',
          source: 'main',
          entryModule: 'packages/oxiquill/src/components/doc-runtime/InteractiveCell.tsx',
          dynamicImports: ['_astro/ChartOutput.js'],
          modules: ['packages/oxiquill/src/components/doc-runtime/InteractiveCell.tsx', 'preact/dist/preact.js']
        }),
        expect.objectContaining({
          fileName: '_astro/rust-worker.js',
          source: 'worker',
          entryModule: 'packages/oxiquill/src/lib/doc-runtime/rust-worker.ts'
        })
      ]
    });
    expect(generateBrowserBundleReport(report)).toBe(`${JSON.stringify(report, null, 2)}\n`);

    collector.reset();
    expect(collector.snapshot()).toEqual([]);
  });

  it('accepts the exact limit and reports every oversized chunk', () => {
    const atLimit = createBrowserBundleReport([collectedChunk('_astro/at-limit.js', CLIENT_CHUNK_LIMIT_BYTES)]);
    expect(() => assertBrowserBundleBudget(atLimit)).not.toThrow();

    const oversized = createBrowserBundleReport([
      collectedChunk('_astro/large.js', CLIENT_CHUNK_LIMIT_BYTES + 1),
      collectedChunk('_astro/larger.js', CLIENT_CHUNK_LIMIT_BYTES + 20)
    ]);
    expect(() => assertBrowserBundleBudget(oversized)).toThrow(
      `Oxiquill client chunk budget exceeded (${CLIENT_CHUNK_LIMIT_BYTES} bytes):\n` +
        `- _astro/large.js: ${CLIENT_CHUNK_LIMIT_BYTES + 1} bytes\n` +
        `- _astro/larger.js: ${CLIENT_CHUNK_LIMIT_BYTES + 20} bytes`
    );
  });

  it('writes only chunks that exist in the final client output', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-bundle-report-'));
    temporaryDirectories.push(outputDirectory);
    const finalCode = 'export const ready = true;';
    const finalChunk = collectedChunk('_astro/client.js', Buffer.byteLength(finalCode));
    const staleChunk = collectedChunk('_astro/server.js', 20);

    await mkdir(path.join(outputDirectory, '_astro'), { recursive: true });
    await writeFile(path.join(outputDirectory, '_astro/client.js'), finalCode);

    const report = await syncBrowserBundleReport({
      chunks: [staleChunk, finalChunk],
      outputDirectory,
      workspaceRoot: outputDirectory
    });
    const written = JSON.parse(
      await readFile(path.join(outputDirectory, 'oxiquill', BROWSER_BUNDLE_REPORT_FILE), 'utf8')
    );

    expect(report.chunks.map((chunk) => chunk.fileName)).toEqual(['_astro/client.js']);
    expect(written).toEqual(report);
  });

  it('writes the final report before rejecting an oversized client chunk', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-bundle-budget-'));
    temporaryDirectories.push(outputDirectory);
    const finalCode = 'large';
    const finalChunk = collectedChunk('_astro/large.js', 1);

    await mkdir(path.join(outputDirectory, '_astro'), { recursive: true });
    await writeFile(path.join(outputDirectory, '_astro/large.js'), finalCode);

    await expect(
      syncBrowserBundleReport({
        chunks: [finalChunk],
        limitBytes: Buffer.byteLength(finalCode) - 1,
        outputDirectory,
        workspaceRoot: outputDirectory
      })
    ).rejects.toThrow('Oxiquill client chunk budget exceeded');

    const written = JSON.parse(
      await readFile(path.join(outputDirectory, 'oxiquill', BROWSER_BUNDLE_REPORT_FILE), 'utf8')
    );
    expect(written.chunks[0].uncompressedBytes).toBe(Buffer.byteLength(finalCode));
  });
});

function makeChunk({ code, dynamicImports = [], facadeModuleId = null, fileName, imports = [], modules = {} }) {
  return {
    code,
    dynamicImports,
    facadeModuleId,
    fileName,
    imports,
    isDynamicEntry: dynamicImports.length > 0,
    isEntry: facadeModuleId != null,
    modules,
    type: 'chunk'
  };
}

function collectedChunk(fileName, uncompressedBytes) {
  return {
    dynamicImports: [],
    entryModule: null,
    fileName,
    imports: [],
    isDynamicEntry: false,
    isEntry: false,
    modules: [],
    source: 'main',
    uncompressedBytes
  };
}
