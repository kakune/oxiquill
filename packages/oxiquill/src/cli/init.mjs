import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rm as fsRm,
  rmdir as fsRmdir,
  writeFile as fsWriteFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const starterFiles = Object.freeze([
  '.gitignore',
  'README.md',
  'astro.config.mjs',
  'content.config.ts',
  'content/docs/index.mdx',
  'crates/.gitkeep',
  'package.json',
  'pnpm-workspace.yaml',
  'public/favicon.svg',
  'tsconfig.json'
]);

const fallbackPackageName = 'oxiquill-docs';
const reservedPackageNames = new Set(['favicon.ico', 'node_modules']);
const defaultFileSystem = Object.freeze({
  lstat: fsLstat,
  mkdir: fsMkdir,
  readFile: fsReadFile,
  readdir: fsReaddir,
  rm: fsRm,
  rmdir: fsRmdir,
  writeFile: fsWriteFile
});

export async function initializeProject({
  cwd = process.cwd(),
  directory,
  fileSystem: fileSystemOverrides = {},
  files = starterFiles,
  log = console.log,
  starterRoot = fileURLToPath(new URL('./starter/v1/', import.meta.url))
} = {}) {
  const fileSystem = { ...defaultFileSystem, ...fileSystemOverrides };
  const targetPath = path.resolve(cwd, directory ?? '.');
  const packageName = packageNameFromTarget(targetPath);
  const starter = await loadStarter({ fileSystem, files, packageName, starterRoot, targetPath });
  const targetExisted = await assertEmptyTarget(targetPath, fileSystem);
  const createdFiles = [];
  const createdDirectories = [];

  try {
    if (!targetExisted) {
      await fileSystem.mkdir(targetPath);
      createdDirectories.push(targetPath);
    }

    for (const { content, target } of starter) {
      await createParentDirectories(path.dirname(target), targetPath, createdDirectories, fileSystem);
      await fileSystem.writeFile(target, content, { flag: 'wx' });
      createdFiles.push(target);
    }
  } catch (error) {
    await rollbackCreation({ createdDirectories, createdFiles, fileSystem });
    throw new Error(`Could not initialize an Oxiquill project in ${targetPath}: ${errorMessage(error)}`, {
      cause: error
    });
  }

  printNextSteps({ cwd, log, targetPath });
  return Object.freeze({ packageName, targetPath });
}

export function packageNameFromTarget(target) {
  const basename =
    String(target)
      .replace(/[\\/]+$/gu, '')
      .split(/[\\/]/u)
      .at(-1) ?? '';
  const normalized = basename
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 214)
    .replace(/[._-]+$/gu, '');

  return normalized && !reservedPackageNames.has(normalized) ? normalized : fallbackPackageName;
}

async function loadStarter({ fileSystem, files, packageName, starterRoot, targetPath }) {
  return Promise.all(
    files.map(async (relativePath) => {
      const source = await resolveStarterSource({ fileSystem, relativePath, starterRoot });
      const target = containedPath(targetPath, relativePath, 'starter target');
      const sourceStat = await fileSystem.lstat(source);
      if (!sourceStat.isFile()) throw new Error(`Starter source is not a regular file: ${source}`);
      const sourceContent = await fileSystem.readFile(source);
      const content =
        relativePath === 'package.json' ? renderPackageJson(sourceContent, packageName, source) : sourceContent;
      return Object.freeze({ content, target });
    })
  );
}

async function resolveStarterSource({ fileSystem, relativePath, starterRoot }) {
  const candidates = relativePath === '.gitignore' ? ['gitignore', '.gitignore'] : [relativePath];
  let missingError;

  for (const candidate of candidates) {
    const source = containedPath(starterRoot, candidate, 'starter source');
    try {
      await fileSystem.lstat(source);
      return source;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missingError = error;
    }
  }

  throw missingError;
}

function containedPath(root, relativePath, label) {
  if (path.isAbsolute(relativePath)) throw new Error(`${label} must be relative: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

function renderPackageJson(content, packageName, source) {
  try {
    return `${JSON.stringify({ ...JSON.parse(content.toString('utf8')), name: packageName }, null, 2)}\n`;
  } catch (error) {
    throw new Error(`Starter package metadata is invalid: ${source}`, { cause: error });
  }
}

async function assertEmptyTarget(targetPath, fileSystem) {
  let targetStat;
  try {
    targetStat = await fileSystem.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Oxiquill init target is not a directory: ${targetPath}`);
  }
  if ((await fileSystem.readdir(targetPath)).length > 0) {
    throw new Error(`Oxiquill init target is not empty: ${targetPath}`);
  }
  return true;
}

async function createParentDirectories(directory, targetRoot, createdDirectories, fileSystem) {
  const relative = path.relative(targetRoot, directory);
  if (!relative) return;

  let current = targetRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await fileSystem.mkdir(current);
      createdDirectories.push(current);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}

async function rollbackCreation({ createdDirectories, createdFiles, fileSystem }) {
  for (const filePath of createdFiles.reverse()) {
    await fileSystem.rm(filePath, { force: true }).catch(() => undefined);
  }
  for (const directory of createdDirectories.reverse()) {
    await fileSystem.rmdir(directory).catch(() => undefined);
  }
}

function printNextSteps({ cwd, log, targetPath }) {
  const relativeTarget = path.relative(cwd, targetPath) || '.';
  log(`Created an Oxiquill project in ${targetPath}.`);
  log('');
  log('Next steps:');
  if (relativeTarget !== '.') log(`  cd ${shellArgument(relativeTarget)}`);
  log('  pnpm install');
  log('  pnpm dev');
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./\\:-]+$/u.test(value) ? value : JSON.stringify(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
