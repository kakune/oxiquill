import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOxiquillPaths, pathFromUrl, relativePathFromUrl } from '../config/paths.mjs';

const defaultFileSystem = {
  readFile,
  readdir
};

/* v8 ignore start -- CLI entrypoint delegates to runHelperCargo, which is covered directly. */
export async function main(argv = process.argv.slice(2)) {
  await runHelperCargo({ argv, root: process.cwd() });
}
/* v8 ignore stop */

export async function runHelperCargo({
  argv,
  fileSystem = defaultFileSystem,
  log = console.log,
  paths,
  root = process.cwd(),
  runCommand = runCommandWithInheritedStdio
}) {
  if (argv.length === 0) {
    throw new Error('Expected a Cargo subcommand.');
  }

  const resolvedPaths = paths ?? createOxiquillPaths({ workspaceRoot: root });
  const state = await helperWorkspaceState({ fileSystem, paths: resolvedPaths });
  if (!state.hasHelperCrates) {
    log('[rust] no helper crates found; skipping Cargo command');
    return;
  }
  if (!state.hasWorkspaceManifest) {
    throw new Error('Found helper crates under crates/, but crates/Cargo.toml does not exist.');
  }

  await runCommand('cargo', cargoArgsForHelperWorkspace(argv, state.workspaceManifestPath), {
    cwd: pathFromUrl(resolvedPaths.workspaceRoot)
  });
}

export async function helperWorkspaceState({ fileSystem = defaultFileSystem, paths, root = process.cwd() }) {
  const resolvedPaths = paths ?? createOxiquillPaths({ workspaceRoot: root });
  const cratesDir = pathFromUrl(resolvedPaths.cratesDir);
  let entries;
  try {
    entries = await fileSystem.readdir(cratesDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        hasHelperCrates: false,
        hasWorkspaceManifest: false,
        workspaceManifestPath: relativePathFromUrl(resolvedPaths.workspaceRoot, path.join(cratesDir, 'Cargo.toml'))
      };
    }
    throw error;
  }

  const helperManifestChecks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => fileExists(fileSystem, path.join(cratesDir, entry.name, 'Cargo.toml')))
  );

  const workspaceManifestPath = relativePathFromUrl(resolvedPaths.workspaceRoot, path.join(cratesDir, 'Cargo.toml'));
  return {
    hasHelperCrates: helperManifestChecks.some(Boolean),
    hasWorkspaceManifest: await fileExists(
      fileSystem,
      path.join(pathFromUrl(resolvedPaths.workspaceRoot), workspaceManifestPath)
    ),
    workspaceManifestPath
  };
}

export function cargoArgsForHelperWorkspace(argv, manifestPath) {
  const separatorIndex = argv.indexOf('--');
  const workspaceArgs = ['--manifest-path', manifestPath, '--workspace'];
  if (separatorIndex === -1) return [...argv, ...workspaceArgs];

  return [...argv.slice(0, separatorIndex), ...workspaceArgs, ...argv.slice(separatorIndex)];
}

async function fileExists(fileSystem, filePath) {
  try {
    await fileSystem.readFile(filePath);
    return true;
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

/* v8 ignore start -- CLI guard. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
