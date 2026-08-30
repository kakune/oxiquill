import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, isPathWithin } from './paths.mjs';

const correctiveAction =
  'Choose a dedicated generated directory that does not overlap authored, protected, persistent-cache, or other generated paths.';

const cleanupRootDefinitions = Object.freeze([
  { field: 'cacheDir', property: 'cacheDir', role: 'generated cache root' },
  { field: 'outDir', property: 'outDir', role: 'generated Astro output root' },
  { field: 'paths.publicAssetsDir', property: 'publicAssetsDir', role: 'generated public asset root' }
]);

const cacheChildDefinitions = Object.freeze([
  { field: 'paths.generatedDir', property: 'generatedDir', role: 'generated manifest root' },
  { field: 'paths.haskellCellsDir', property: 'haskellCellsDir', role: 'generated Haskell root' },
  { field: 'paths.rustCellsDir', property: 'rustCellsDir', role: 'generated Rust root' }
]);

const publicChildDefinitions = Object.freeze([
  { field: 'paths.haskellWasmPublicDir', property: 'haskellWasmPublicDir', role: 'generated Haskell asset root' },
  { field: 'paths.licensesPublicDir', property: 'licensesPublicDir', role: 'generated license asset root' },
  { field: 'paths.pyodidePublicDir', property: 'pyodidePublicDir', role: 'generated Pyodide asset root' },
  { field: 'paths.rustWasmPublicDir', property: 'rustWasmPublicDir', role: 'generated Rust asset root' }
]);

const workspaceProjectFileNames = Object.freeze([
  'astro.config.js',
  'astro.config.mjs',
  'astro.config.mts',
  'astro.config.ts',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'yarn.lock'
]);

const protectedEntryRoles = Object.freeze(
  new Map([
    ['.git', 'Git repository metadata'],
    ['.hg', 'Mercurial repository metadata'],
    ['.pnp.cjs', 'Yarn dependency state'],
    ['.pnp.loader.mjs', 'Yarn dependency state'],
    ['.svn', 'Subversion repository metadata'],
    ['.yarn', 'Yarn dependency state'],
    ['node_modules', 'installed package dependencies']
  ])
);

export const cleanupRootFields = Object.freeze(cleanupRootDefinitions.map(({ property }) => property));

export function cleanupPathRoles(paths) {
  return cleanupRootDefinitions.map((definition) => pathRole(definition, paths));
}

export function validateProjectPathSafety({ configFile, paths, protectedPaths = [] }) {
  if (!paths) throw new TypeError('Path safety validation requires resolved project paths.');

  const workspaceRoot = canonicalPath(paths.workspaceRoot);
  const cleanupRoots = cleanupPathRoles(paths);
  const cacheChildren = cacheChildDefinitions.map((definition) => pathRole(definition, paths));
  const publicChildren = publicChildDefinitions.map((definition) => pathRole(definition, paths));

  assertStrictlyWithin(workspaceRoot, paths.cacheDir, 'cacheDir', 'workspaceRoot');
  assertStrictlyWithin(workspaceRoot, paths.outDir, 'outDir', 'workspaceRoot');
  assertStrictlyWithin(workspaceRoot, paths.publicDir, 'paths.publicDir', 'workspaceRoot');
  assertStrictlyWithin(workspaceRoot, paths.publicAssetsDir, 'paths.publicAssetsDir', 'workspaceRoot');
  assertStrictlyWithin(workspaceRoot, paths.downloadCacheDir, 'paths.downloadCacheDir', 'workspaceRoot');
  assertStrictlyWithin(paths.publicDir, paths.publicAssetsDir, 'paths.publicAssetsDir', 'paths.publicDir');

  cacheChildren.forEach((child) => assertStrictlyWithin(paths.cacheDir, child.path, child.field, 'cacheDir'));
  publicChildren.forEach((child) =>
    assertStrictlyWithin(paths.publicAssetsDir, child.path, child.field, 'paths.publicAssetsDir')
  );

  const authoredAndProtected = [
    role('docsDir', paths.docsDir, 'authored documentation input'),
    role('cratesDir', paths.cratesDir, 'authored helper-crate input'),
    role('paths.publicDir', paths.publicDir, 'authored public asset root'),
    role('paths.frameworkRoot', paths.frameworkRoot, 'Oxiquill framework input'),
    role('paths.downloadCacheDir', paths.downloadCacheDir, 'persistent verified download cache'),
    ...(configFile ? [role('configFile', configFile, 'selected Astro configuration')] : []),
    ...workspaceProjectFileNames.map((fileName) =>
      role(`project file ${fileName}`, path.join(workspaceRoot, fileName), 'authored project configuration')
    ),
    ...Array.from(protectedEntryRoles, ([entryName, protectedRole]) =>
      role(entryName, path.join(workspaceRoot, entryName), protectedRole)
    ),
    ...protectedPaths.map(({ field, path: protectedPath, role: protectedRole }) =>
      role(field, protectedPath, protectedRole)
    )
  ];

  cleanupRoots.forEach((cleanupRoot) => {
    authoredAndProtected.forEach((protectedPath) => {
      if (cleanupRoot.property === 'publicAssetsDir' && protectedPath.field === 'paths.publicDir') return;
      assertPathsDisjoint(cleanupRoot, protectedPath);
    });

    const protectedAncestor = protectedPathSegment(workspaceRoot, cleanupRoot.path);
    if (protectedAncestor) assertPathsDisjoint(cleanupRoot, protectedAncestor);
  });

  assertPairwiseDisjoint(cleanupRoots);
  assertPairwiseDisjoint(cacheChildren);
  assertPairwiseDisjoint(publicChildren);

  return Object.freeze({ cacheChildren, cleanupRoots, publicChildren });
}

export async function discoverProtectedPathRoles({ fileSystem = { readdir }, roots }) {
  const protectedPaths = await Promise.all(roots.map((root) => findProtectedEntries(root.path, fileSystem)));
  return protectedPaths.flat();
}

async function findProtectedEntries(rootPath, fileSystem) {
  let entries;
  try {
    entries = await fileSystem.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }

  const discovered = entries.flatMap((entry) => {
    const entryPath = path.join(rootPath, entry.name);
    const protectedRole = protectedEntryRoles.get(entry.name);
    if (protectedRole) return [role(entry.name, entryPath, protectedRole)];
    return [];
  });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !protectedEntryRoles.has(entry.name))
      .map((entry) => findProtectedEntries(path.join(rootPath, entry.name), fileSystem))
  );

  return [...discovered, ...nested.flat()];
}

function assertStrictlyWithin(parentPath, candidatePath, fieldName, parentField) {
  const canonicalParent = canonicalPath(parentPath);
  const canonicalCandidate = canonicalPath(candidatePath);
  if (isPathWithin(canonicalParent, canonicalCandidate)) return;

  throw new Error(
    `Unsafe path ${fieldName} at ${canonicalCandidate}: it must be strictly inside ${parentField} at ${canonicalParent}. ${correctiveAction}`
  );
}

function assertPairwiseDisjoint(paths) {
  paths.forEach((left, index) => {
    paths.slice(index + 1).forEach((right) => assertPathsDisjoint(left, right));
  });
}

function assertPathsDisjoint(left, right) {
  const relationship = pathRelationship(left.path, right.path);
  if (!relationship) return;

  throw new Error(
    `Unsafe cleanup path ${left.field} at ${left.path}: it is ${relationship} ${right.field} (${right.role}) at ${right.path}. ${correctiveAction}`
  );
}

function pathRelationship(leftPath, rightPath) {
  const left = canonicalPath(leftPath);
  const right = canonicalPath(rightPath);
  if (left === right) return 'equal to';
  if (isPathWithin(left, right)) return 'an ancestor of';
  if (isPathWithin(right, left)) return 'a descendant of';
  return undefined;
}

function pathRole(definition, paths) {
  return Object.freeze({
    ...definition,
    path: canonicalPath(paths[definition.property])
  });
}

function protectedPathSegment(workspaceRoot, candidatePath) {
  const relative = path.relative(workspaceRoot, candidatePath);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;

  const segments = relative.split(path.sep);
  const protectedIndex = segments.findIndex((segment) => protectedEntryRoles.has(segment));
  if (protectedIndex < 0) return undefined;

  const entryName = segments[protectedIndex];
  return role(
    entryName,
    path.join(workspaceRoot, ...segments.slice(0, protectedIndex + 1)),
    protectedEntryRoles.get(entryName)
  );
}

function role(field, value, roleName) {
  return Object.freeze({ field, path: canonicalPath(value), role: roleName });
}
