import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { buildFingerprint, createOutputPlan, needsColdBuild } from './build-plan.mjs';

const defaultPackageRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

export async function buildPackage({ packageRoot = defaultPackageRoot } = {}) {
  const dist = path.join(packageRoot, 'dist');
  const cache = path.join(packageRoot, 'node_modules/.cache/oxiquill');
  const manifestPath = path.join(cache, 'package-output.json');
  const manifest = await readManifest(manifestPath);
  // An interrupted or failed build must never leave a successful output manifest.
  await rm(manifestPath, { force: true });

  const configPath = path.join(packageRoot, 'tsconfig.build.json');
  const configs = {};
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      readFile(file) {
        const content = ts.sys.readFile(file);
        configs[relative(packageRoot, file)] = content;
        return content;
      },
      onUnRecoverableConfigFileDiagnostic: failDiagnostic
    }
  );
  if (config.errors.length) config.errors.forEach(failDiagnostic);
  const buildInfo = config.options.tsBuildInfoFile && path.resolve(config.options.tsBuildInfoFile);
  if (!config.options.incremental || !buildInfo || !buildInfo.startsWith(`${cache}${path.sep}`)) {
    throw new Error('Package build info must be configured under node_modules/.cache/oxiquill.');
  }

  const fingerprint = buildFingerprint({ compilerVersion: ts.version, configs });
  const distInfo = await fileInfo(dist);
  if (distInfo && !distInfo.isDirectory()) await rm(dist, { force: true });
  // Never compile or copy through links left in generated output.
  const previousFiles = await listFiles(dist);
  const outputFiles = [];
  for (const file of previousFiles) {
    if ((await lstat(file)).isSymbolicLink()) await rm(file, { force: true });
    else outputFiles.push(relative(dist, file));
  }
  if (needsColdBuild({ manifest, fingerprint, outputFiles })) await rm(buildInfo, { force: true });

  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', configPath], {
    cwd: packageRoot,
    stdio: 'inherit'
  });
  if (result.error || result.status !== 0) {
    await rm(buildInfo, { force: true });
    throw result.error ?? new Error(`Package TypeScript compilation failed (${result.status ?? result.signal}).`);
  }

  const compiledFiles = config.fileNames.flatMap((file) =>
    ts.getOutputFileNames(config, file, !ts.sys.useCaseSensitiveFileNames).map((output) => relative(dist, output))
  );
  const assets = await packageAssets(packageRoot);
  for (const { source, target } of assets) {
    const destination = path.join(dist, target);
    const content = await readFile(source);
    if (!(await readOptional(destination))?.equals(content)) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }
  const plan = createOutputPlan({
    compiledFiles,
    assets,
    outputFiles: (await listFiles(dist)).map((file) => relative(dist, file))
  });
  await Promise.all(plan.remove.map((file) => rm(path.join(dist, file), { force: true })));
  await removeEmptyDirectories(dist);
  for (const file of plan.files) {
    if (!(await fileInfo(path.join(dist, file)))?.isFile()) throw new Error(`Missing package output: ${file}`);
  }
  const cli = path.join(dist, 'cli/index.mjs');
  if (process.platform !== 'win32' && ((await lstat(cli)).mode & 0o777) !== 0o755) await chmod(cli, 0o755);
  await mkdir(cache, { recursive: true });
  const temporaryManifest = `${manifestPath}.tmp`;
  await writeFile(
    temporaryManifest,
    `${JSON.stringify({ schemaVersion: 1, fingerprint, files: plan.files }, null, 2)}\n`
  );
  await rename(temporaryManifest, manifestPath);
}

async function packageAssets(packageRoot) {
  const sourceRoot = path.join(packageRoot, 'src');
  const sourceFiles = await listFiles(sourceRoot);
  const assets = sourceFiles
    .map((source) => ({ source, target: relative(sourceRoot, source) }))
    .filter(
      ({ target }) =>
        /\.(?:astro|css)$/u.test(target) ||
        target === 'env.d.ts' ||
        target.startsWith('generator/license-data/') ||
        target.startsWith('generator/runtime-data/')
    );
  const starterRoot = path.resolve(packageRoot, '../../templates/basic');
  const starterFiles = await listFiles(starterRoot);
  return [
    ...assets,
    { source: path.join(packageRoot, 'tsconfigs/strict.json'), target: 'tsconfigs/strict.json' },
    ...starterFiles.map((source) => ({
      source,
      target: `cli/starter/v1/${relative(starterRoot, source) === '.gitignore' ? 'gitignore' : relative(starterRoot, source)}`
    }))
  ];
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(file) : [file];
    })
  );
  return files.flat().sort();
}

async function removeEmptyDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => removeEmptyDirectories(path.join(directory, entry.name)))
  );
  if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true });
}

async function fileInfo(file) {
  return lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function readOptional(file) {
  return readFile(file).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function readManifest(file) {
  const content = await readOptional(file);
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function failDiagnostic(diagnostic) {
  throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildPackage().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
