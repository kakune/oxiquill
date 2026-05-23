import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHighlighter } from 'shiki';
import {
  assertUniqueCellIds,
  assertUniqueRustInputBindings,
  extractCellsFromMarkdown,
  generateCellsJson,
  generateCellsModule,
  generateRustCargoToml,
  generateRustLib,
  helperCratesFromManifests,
  sourceThemes
} from './doc-runtime-core.mjs';

const defaultFileSystem = {
  copyFile,
  existsSync,
  mkdir,
  readFile,
  readdir,
  writeFile
};

export function createDocRuntimePaths(root) {
  const generatedDir = path.join(root, 'src/generated/doc-runtime');

  return {
    docsDir: path.join(root, 'src/content/docs'),
    generatedDir,
    pyodidePublicDir: path.join(root, 'public/pyodide'),
    rustCrateDir: path.join(generatedDir, 'rust-cells'),
    runtimeVersionPath: path.join(generatedDir, 'runtime-version.ts')
  };
}

export async function createDocRuntimeContext({
  fileSystem = defaultFileSystem,
  highlighter,
  readManifests,
  root
} = {}) {
  const paths = createDocRuntimePaths(root);
  return {
    highlighter:
      highlighter ??
      (await createHighlighter({
        langs: ['rust', 'python'],
        themes: Object.values(sourceThemes)
      })),
    paths,
    helperCrates: await listHelperCrates({ fileSystem, paths, readManifests, root })
  };
}

export async function syncDocRuntime({
  fileSystem = defaultFileSystem,
  highlighter,
  helperCrates,
  paths,
  root
}) {
  const cells = await collectCells({
    fileSystem,
    helperCrates,
    highlighter,
    paths,
    root
  });
  const rustCells = cells.filter((cell) => cell.language === 'rust');

  assertUniqueCellIds(cells);
  assertUniqueRustInputBindings(rustCells);

  const writes = await Promise.all([
    writeIfChanged(path.join(paths.generatedDir, 'cells.ts'), generateCellsModule(cells), { fileSystem }),
    writeIfChanged(path.join(paths.generatedDir, 'cells.json'), generateCellsJson(cells), { fileSystem }),
    writeIfChanged(path.join(paths.rustCrateDir, 'Cargo.toml'), generateRustCargoToml(rustCells, helperCrates), {
      fileSystem
    }),
    writeIfChanged(path.join(paths.rustCrateDir, 'src/lib.rs'), generateRustLib(rustCells), { fileSystem })
  ]);
  const pyodideChanged = await copyPyodideAssets({ fileSystem, paths, root });
  const summary = summarizeCells(cells);

  return {
    ...summary,
    cellsChanged: writes[0] || writes[1],
    pyodideChanged,
    rustChanged: writes[2] || writes[3]
  };
}

export async function collectCells({ fileSystem = defaultFileSystem, helperCrates, highlighter, paths, root }) {
  const files = await listFiles(paths.docsDir, { fileSystem });
  const markdownFiles = files.filter((filePath) => filePath.endsWith('.mdx') || filePath.endsWith('.md'));
  const nestedCells = await Promise.all(
    markdownFiles.map(async (filePath) => {
      const pagePath = normalizePath(path.relative(root, filePath));
      const source = await fileSystem.readFile(filePath, 'utf8');
      return extractCellsFromMarkdown(source, pagePath, { helperCrates, highlighter });
    })
  );

  return nestedCells.flat();
}

export async function listFiles(directory, { fileSystem = defaultFileSystem } = {}) {
  const entries = await fileSystem.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath, { fileSystem });
      return entry.isFile() ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}

export async function listHelperCrates({
  fileSystem = defaultFileSystem,
  paths,
  readManifests = readHelperManifests,
  root
}) {
  return helperCratesFromManifests(await readManifests({ fileSystem, root }), {
    rustCrateDir: paths.rustCrateDir
  });
}

export async function readHelperManifests({ fileSystem = defaultFileSystem, root }) {
  const cratesDir = path.join(root, 'crates');
  let entries;
  try {
    entries = await fileSystem.readdir(cratesDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = path.join(cratesDir, entry.name, 'Cargo.toml');
        try {
          return {
            content: await fileSystem.readFile(manifestPath, 'utf8'),
            manifestPath
          };
        } catch (error) {
          if (error && error.code === 'ENOENT') return undefined;
          throw error;
        }
      })
  );

  return manifests.filter(Boolean).sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

export async function writeIfChanged(filePath, content, { fileSystem = defaultFileSystem } = {}) {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });

  if (await hasTextContent(filePath, content, { fileSystem })) return false;

  await fileSystem.writeFile(filePath, content, 'utf8');
  return true;
}

export async function copyFileIfChanged(sourcePath, targetPath, { fileSystem = defaultFileSystem } = {}) {
  await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });

  if (await hasBinaryContent(sourcePath, targetPath, { fileSystem })) return false;

  await fileSystem.copyFile(sourcePath, targetPath);
  return true;
}

export async function copyPyodideAssets({ fileSystem = defaultFileSystem, paths, root }) {
  const packageDir = path.join(root, 'node_modules/pyodide');
  if (!fileSystem.existsSync(packageDir)) return false;

  const changed = await Promise.all(
    [
      'pyodide.mjs',
      'pyodide.mjs.map',
      'pyodide.asm.js',
      'pyodide.asm.wasm',
      'python_stdlib.zip',
      'pyodide-lock.json'
    ].map((file) =>
      copyFileIfChanged(path.join(packageDir, file), path.join(paths.pyodidePublicDir, file), {
        fileSystem
      })
    )
  );

  return changed.some(Boolean);
}

export function summarizeCells(cells) {
  const rustCells = cells.filter((cell) => cell.language === 'rust');

  return {
    cellCount: cells.length,
    manifestFingerprint: stableFingerprint(cells),
    rustCellCount: rustCells.length,
    rustFingerprint: stableFingerprint(
      rustCells.map((cell) => ({
        crates: cell.crates,
        id: cell.id,
        inputs: cell.inputs,
        source: cell.source
      }))
    )
  };
}

export function shouldBuildWasm({ changeKinds = new Set(), current, force = false, previous }) {
  if (current.rustCellCount === 0) return false;
  if (force || !previous) return true;
  if (changeKinds.has('crate')) return true;
  return previous.rustFingerprint !== current.rustFingerprint;
}

export async function buildRustWasm({ mode, root, runCommand = runCommandWithInheritedStdio }) {
  const modeFlag = mode === 'build' ? '--release' : '--dev';
  await runCommand('wasm-pack', [
    'build',
    'src/generated/doc-runtime/rust-cells',
    '--target',
    'web',
    modeFlag,
    '--out-dir',
    '../rust-wasm',
    '--out-name',
    'doc_rust_cells'
  ], { cwd: root });
  await runCommand(process.execPath, ['scripts/postprocess-rust-wasm.mjs'], { cwd: root });
}

export async function markRuntimeReady({
  fileSystem = defaultFileSystem,
  paths,
  summary,
  version = createRuntimeVersion(summary)
}) {
  return writeIfChanged(paths.runtimeVersionPath, generateRuntimeVersionModule(version), { fileSystem });
}

export function createRuntimeVersion(summary) {
  return stableFingerprint({
    readyAt: Date.now(),
    manifest: hashText(summary?.manifestFingerprint ?? ''),
    rust: hashText(summary?.rustFingerprint ?? '')
  });
}

export function generateRuntimeVersionModule(version) {
  return `// @generated by scripts/generate-doc-runtime.mjs. Do not edit by hand.\nexport const runtimeVersion = ${JSON.stringify(version)};\n`;
}

export function stableFingerprint(value) {
  return JSON.stringify(value);
}

export function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hasTextContent(filePath, content, { fileSystem }) {
  try {
    return (await fileSystem.readFile(filePath, 'utf8')) === content;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasBinaryContent(sourcePath, targetPath, { fileSystem }) {
  try {
    const [source, target] = await Promise.all([
      fileSystem.readFile(sourcePath),
      fileSystem.readFile(targetPath)
    ]);
    return Buffer.compare(source, target) === 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/* v8 ignore start -- external process adapter covered through injected runCommand in tests. */
function runCommandWithInheritedStdio(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}`));
      }
    });
  });
}
/* v8 ignore stop */

function normalizePath(value) {
  return value.split(path.sep).join('/');
}
