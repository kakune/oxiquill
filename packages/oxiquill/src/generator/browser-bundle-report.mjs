import path from 'node:path';
import { pathFromUrl } from '../config/paths.mjs';
import { defaultFileSystem, writeIfChanged } from './doc-runtime/file-system.mjs';
import { normalizePath } from './doc-runtime/path-utils.mjs';

export const CLIENT_CHUNK_LIMIT_BYTES = 650 * 1024;
export const BROWSER_BUNDLE_REPORT_FILE = 'bundle-report.json';

export function createBrowserBundleCollector() {
  const chunks = new Map();

  return {
    add(source, bundle) {
      Object.values(bundle)
        .filter((output) => output.type === 'chunk' && output.fileName.endsWith('.js'))
        .map((chunk) => collectedChunk(source, chunk))
        .forEach((chunk) => {
          chunks.set(collectedChunkKey(chunk), chunk);
        });
    },
    reset() {
      chunks.clear();
    },
    snapshot() {
      return Array.from(chunks.values()).sort(compareCollectedChunks);
    }
  };
}

export function createBrowserBundleReport(
  chunks,
  { frameworkRoot, limitBytes = CLIENT_CHUNK_LIMIT_BYTES, workspaceRoot = process.cwd() } = {}
) {
  return {
    schemaVersion: 1,
    limitBytes,
    chunks: chunks
      .map((chunk) => publicChunk(chunk, { frameworkRoot, workspaceRoot }))
      .sort((left, right) => left.fileName.localeCompare(right.fileName))
  };
}

export function generateBrowserBundleReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function assertBrowserBundleBudget(report) {
  const oversized = report.chunks.filter((chunk) => chunk.uncompressedBytes > report.limitBytes);
  if (oversized.length === 0) return;

  const details = oversized.map((chunk) => `- ${chunk.fileName}: ${chunk.uncompressedBytes} bytes`).join('\n');
  throw new Error(`Oxiquill client chunk budget exceeded (${report.limitBytes} bytes):\n${details}`);
}

export async function syncBrowserBundleReport({
  chunks,
  fileSystem = defaultFileSystem,
  frameworkRoot,
  limitBytes = CLIENT_CHUNK_LIMIT_BYTES,
  outputDirectory,
  workspaceRoot
}) {
  const finalChunks = await filterFinalChunks(chunks, outputDirectory, { fileSystem });
  const report = createBrowserBundleReport(finalChunks, {
    frameworkRoot,
    limitBytes,
    workspaceRoot
  });
  const reportPath = path.join(pathFromUrl(outputDirectory), 'oxiquill', BROWSER_BUNDLE_REPORT_FILE);

  await writeIfChanged(reportPath, generateBrowserBundleReport(report), { fileSystem });
  assertBrowserBundleBudget(report);
  return report;
}

async function filterFinalChunks(chunks, outputDirectory, { fileSystem }) {
  const outputPath = pathFromUrl(outputDirectory);
  const finalChunks = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const output = await fileSystem.readFile(path.join(outputPath, chunk.fileName));
        return { ...chunk, uncompressedBytes: output.byteLength };
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    })
  );
  const unique = new Map();

  finalChunks.filter(Boolean).forEach((chunk) => {
    unique.set(`${chunk.source}:${chunk.fileName}`, chunk);
  });

  return Array.from(unique.values());
}

function collectedChunk(source, chunk) {
  return {
    dynamicImports: [...chunk.dynamicImports].sort(),
    entryModule: chunk.facadeModuleId ?? null,
    fileName: chunk.fileName,
    imports: [...chunk.imports].sort(),
    isDynamicEntry: chunk.isDynamicEntry,
    isEntry: chunk.isEntry,
    modules: Object.keys(chunk.modules ?? {}).sort(),
    source,
    uncompressedBytes: Buffer.byteLength(chunk.code)
  };
}

function publicChunk(chunk, roots) {
  return {
    fileName: chunk.fileName,
    source: chunk.source,
    uncompressedBytes: chunk.uncompressedBytes,
    isEntry: chunk.isEntry,
    isDynamicEntry: chunk.isDynamicEntry,
    entryModule: chunk.entryModule ? publicModuleId(chunk.entryModule, roots) : null,
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports,
    modules: Array.from(new Set(chunk.modules.map((moduleId) => publicModuleId(moduleId, roots)))).sort()
  };
}

function publicModuleId(moduleId, { frameworkRoot, workspaceRoot }) {
  const cleanId = String(moduleId).replace(/^\0/u, '').split(/[?#]/u, 1)[0];
  const normalizedId = normalizePath(cleanId);
  const packageIndex = normalizedId.lastIndexOf('/node_modules/');

  if (packageIndex !== -1) {
    return normalizedId.slice(packageIndex + '/node_modules/'.length);
  }

  if (!path.isAbsolute(cleanId)) return normalizedId;

  if (frameworkRoot) {
    const frameworkRelative = relativeModuleId(frameworkRoot, cleanId);
    if (frameworkRelative) return `oxiquill/${frameworkRelative}`;
  }

  const workspaceRelative = relativeModuleId(workspaceRoot, cleanId);
  if (workspaceRelative) return workspaceRelative;

  return `<external>/${path.basename(cleanId)}`;
}

function relativeModuleId(root, moduleId) {
  const relative = normalizePath(path.relative(pathFromUrl(root), moduleId));
  return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : undefined;
}

function collectedChunkKey(chunk) {
  return [chunk.source, chunk.fileName, chunk.uncompressedBytes, chunk.entryModule ?? ''].join(':');
}

function compareCollectedChunks(left, right) {
  return collectedChunkKey(left).localeCompare(collectedChunkKey(right));
}
