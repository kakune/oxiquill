import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupPathRoles,
  cleanupRootFields,
  discoverAuthoredPublicPathRoles,
  discoverProtectedPathRoles,
  validateProjectPathSafety
} from '../config/path-safety.mjs';
import { canonicalPath, normalizePath } from '../config/paths.mjs';

export const CLEANUP_OWNERSHIP_MARKER = '.oxiquill-ownership.json';

const markerSchemaVersion = 1;
const defaultFileSystem = { lstat, mkdir, readFile, readdir, writeFile };
const ownershipCorrection =
  'Use a missing or empty dedicated directory so Oxiquill can establish ownership, or restore its valid ownership marker.';

export async function prepareCleanupOwnership({
  configFile,
  fields = cleanupRootFields,
  fileSystem = defaultFileSystem,
  paths
}) {
  const services = { ...defaultFileSystem, ...fileSystem };
  const roots = await validatedCleanupRoots({ configFile, fields, fileSystem: services, paths });
  const inspections = await Promise.all(
    roots.map((root) => inspectOwnership(root, paths, services, { allowClaim: true }))
  );

  await Promise.all(
    inspections.map(async (inspection) => {
      if (!inspection.writeMarker) return;
      await services.mkdir(inspection.root.path, { recursive: true });
      await services.writeFile(inspection.markerPath, inspection.markerSource, {
        encoding: 'utf8',
        flag: 'wx'
      });
    })
  );

  return Object.freeze(
    inspections.map((inspection) =>
      Object.freeze({
        markerPath: inspection.markerPath,
        markerSource: inspection.markerSource,
        root: inspection.root
      })
    )
  );
}

export async function maintainCleanupOwnership({ fileSystem = defaultFileSystem, ownership }) {
  const services = { ...defaultFileSystem, ...fileSystem };
  await Promise.all(
    ownership.map(async ({ markerPath, markerSource, root }) => {
      await services.mkdir(root.path, { recursive: true });
      await services.writeFile(markerPath, markerSource, 'utf8');
    })
  );
}

export async function verifyCleanupOwnership({
  configFile,
  fields = cleanupRootFields,
  fileSystem = defaultFileSystem,
  paths
}) {
  const services = { ...defaultFileSystem, ...fileSystem };
  const roots = await validatedCleanupRoots({ configFile, fields, fileSystem: services, paths });
  const inspections = await Promise.all(
    roots.map((root) => inspectOwnership(root, paths, services, { allowClaim: false }))
  );
  return Object.freeze(inspections.filter(({ exists }) => exists).map(({ root }) => root));
}

async function validatedCleanupRoots({ configFile, fields, fileSystem, paths }) {
  const selectedFields = new Set(fields);
  const unknownFields = Array.from(selectedFields).filter((field) => !cleanupRootFields.includes(field));
  if (unknownFields.length > 0) throw new TypeError(`Unknown cleanup root field: ${unknownFields.sort().join(', ')}.`);

  const roots = cleanupPathRoles(paths).filter(({ property }) => selectedFields.has(property));
  validateProjectPathSafety({ configFile, paths });
  const protectedPaths = [
    ...(await discoverProtectedPathRoles({ fileSystem, roots })),
    ...(await discoverAuthoredPublicPathRoles({ fileSystem, paths }))
  ];
  validateProjectPathSafety({ configFile, paths, protectedPaths });
  return roots;
}

async function inspectOwnership(root, paths, fileSystem, { allowClaim }) {
  const markerPath = path.join(root.path, CLEANUP_OWNERSHIP_MARKER);
  const markerSource = ownershipMarkerSource(root, paths);
  const targetState = await pathState(root.path, fileSystem);
  if (!targetState.exists) {
    return { exists: false, markerPath, markerSource, root, writeMarker: allowClaim };
  }
  if (!targetState.directory) {
    throw ownershipError(root, 'the cleanup target exists but is not a directory');
  }

  const marker = await readMarker(markerPath, fileSystem);
  if (marker.exists) {
    if (marker.source !== markerSource) {
      throw ownershipError(root, `the ownership marker ${markerPath} does not match this workspace and path role`);
    }
    return { exists: true, markerPath, markerSource, root, writeMarker: false };
  }

  if (isDefaultCleanupRoot(root, paths)) {
    return { exists: true, markerPath, markerSource, root, writeMarker: allowClaim };
  }

  const entries = await fileSystem.readdir(root.path);
  if (allowClaim && entries.length === 0) {
    return { exists: true, markerPath, markerSource, root, writeMarker: true };
  }

  throw ownershipError(root, `the custom cleanup target has no ${CLEANUP_OWNERSHIP_MARKER} marker`);
}

async function pathState(targetPath, fileSystem) {
  try {
    const stats = await fileSystem.lstat(targetPath);
    return { directory: stats.isDirectory(), exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { directory: false, exists: false };
    throw error;
  }
}

async function readMarker(markerPath, fileSystem) {
  try {
    return { exists: true, source: await fileSystem.readFile(markerPath, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, source: undefined };
    throw error;
  }
}

function ownershipMarkerSource(root, paths) {
  return `${JSON.stringify(
    {
      field: root.field,
      owner: 'oxiquill',
      path: normalizePath(path.relative(canonicalPath(paths.workspaceRoot), root.path)),
      schemaVersion: markerSchemaVersion
    },
    null,
    2
  )}\n`;
}

function isDefaultCleanupRoot(root, paths) {
  const defaultPath =
    root.property === 'cacheDir'
      ? path.join(paths.workspaceRoot, '.oxiquill')
      : root.property === 'outDir'
        ? path.join(paths.workspaceRoot, 'dist')
        : path.join(paths.publicDir, 'oxiquill');
  return root.path === canonicalPath(defaultPath);
}

function ownershipError(root, reason) {
  return new Error(`Unsafe cleanup root ${root.field} at ${root.path}: ${reason}. ${ownershipCorrection}`);
}
