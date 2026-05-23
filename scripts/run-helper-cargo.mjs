import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultFileSystem = {
  readFile,
  readdir
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* v8 ignore start -- CLI entrypoint delegates to runHelperCargo, which is covered directly. */
export async function main(argv = process.argv.slice(2)) {
  await runHelperCargo({ argv, root });
}
/* v8 ignore stop */

export async function runHelperCargo({
  argv,
  fileSystem = defaultFileSystem,
  log = console.log,
  root,
  runCommand = runCommandWithInheritedStdio
}) {
  if (argv.length === 0) {
    throw new Error('Expected a Cargo subcommand.');
  }

  const state = await helperWorkspaceState({ fileSystem, root });
  if (!state.hasHelperCrates) {
    log('[rust] no helper crates found; skipping Cargo command');
    return;
  }
  if (!state.hasWorkspaceManifest) {
    throw new Error('Found helper crates under crates/, but crates/Cargo.toml does not exist.');
  }

  await runCommand('cargo', cargoArgsForHelperWorkspace(argv, state.workspaceManifestPath), { cwd: root });
}

export async function helperWorkspaceState({ fileSystem = defaultFileSystem, root }) {
  const cratesDir = path.join(root, 'crates');
  let entries;
  try {
    entries = await fileSystem.readdir(cratesDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        hasHelperCrates: false,
        hasWorkspaceManifest: false,
        workspaceManifestPath: path.join('crates', 'Cargo.toml')
      };
    }
    throw error;
  }

  const helperManifestChecks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => fileExists(fileSystem, path.join(cratesDir, entry.name, 'Cargo.toml')))
  );

  const workspaceManifestPath = path.join('crates', 'Cargo.toml');
  return {
    hasHelperCrates: helperManifestChecks.some(Boolean),
    hasWorkspaceManifest: await fileExists(fileSystem, path.join(root, workspaceManifestPath)),
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
