import { describe, expect, it } from 'vitest';
import {
  cargoArgsForHelperWorkspace,
  helperWorkspaceState,
  runHelperCargo
} from '../../scripts/run-helper-cargo.mjs';

function createMemoryFileSystem(initialFiles = {}) {
  const files = new Set(Object.keys(initialFiles));
  const directories = new Set(['/repo']);

  for (const filePath of files) {
    const parts = filePath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      directories.add(current);
    }
  }

  return {
    readFile: async (filePath) => {
      if (files.has(filePath)) return initialFiles[filePath];
      const error = new Error(`missing ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
    readdir: async (directory) => {
      if (!directories.has(directory)) {
        const error = new Error(`missing ${directory}`);
        error.code = 'ENOENT';
        throw error;
      }

      const childNames = new Set();
      for (const filePath of files) {
        if (filePath.startsWith(`${directory}/`)) {
          childNames.add(filePath.slice(directory.length + 1).split('/')[0]);
        }
      }
      for (const candidate of directories) {
        if (candidate.startsWith(`${directory}/`) && candidate !== directory) {
          childNames.add(candidate.slice(directory.length + 1).split('/')[0]);
        }
      }

      return Array.from(childNames).map((name) => {
        const fullPath = `${directory}/${name}`;
        return {
          isDirectory: () => directories.has(fullPath),
          name
        };
      });
    }
  };
}

describe('helper cargo runner', () => {
  it('inserts helper workspace arguments before cargo pass-through arguments', () => {
    expect(cargoArgsForHelperWorkspace(['test'], 'crates/Cargo.toml')).toEqual([
      'test',
      '--manifest-path',
      'crates/Cargo.toml',
      '--workspace'
    ]);
    expect(cargoArgsForHelperWorkspace(['clippy', '--all-targets', '--', '-D', 'warnings'], 'crates/Cargo.toml')).toEqual([
      'clippy',
      '--all-targets',
      '--manifest-path',
      'crates/Cargo.toml',
      '--workspace',
      '--',
      '-D',
      'warnings'
    ]);
  });

  it('detects helper workspace state and skips when no helper crates exist', async () => {
    await expect(helperWorkspaceState({
      fileSystem: createMemoryFileSystem(),
      root: '/repo'
    })).resolves.toEqual({
      hasHelperCrates: false,
      hasWorkspaceManifest: false,
      workspaceManifestPath: 'crates/Cargo.toml'
    });

    const logs = [];
    await runHelperCargo({
      argv: ['test'],
      fileSystem: createMemoryFileSystem({ '/repo/crates/Cargo.toml': '[workspace]\n' }),
      log: (message) => logs.push(message),
      root: '/repo',
      runCommand: async () => {
        throw new Error('should not run cargo');
      }
    });

    expect(logs).toEqual(['[rust] no helper crates found; skipping Cargo command']);
  });

  it('runs cargo against crates workspace when helper crates exist', async () => {
    const commands = [];
    await runHelperCargo({
      argv: ['doc', '--no-deps'],
      fileSystem: createMemoryFileSystem({
        '/repo/crates/Cargo.toml': '[workspace]\n',
        '/repo/crates/doc-rust/Cargo.toml': '[package]\nname = "doc-rust"\n'
      }),
      root: '/repo',
      runCommand: async (command, args, options) => {
        commands.push([command, args, options]);
      }
    });

    expect(commands).toEqual([
      [
        'cargo',
        ['doc', '--no-deps', '--manifest-path', 'crates/Cargo.toml', '--workspace'],
        { cwd: '/repo' }
      ]
    ]);
  });

  it('rejects invalid runner and workspace states', async () => {
    await expect(runHelperCargo({
      argv: [],
      fileSystem: createMemoryFileSystem(),
      root: '/repo'
    })).rejects.toThrow('Expected a Cargo subcommand');

    await expect(runHelperCargo({
      argv: ['test'],
      fileSystem: createMemoryFileSystem({
        '/repo/crates/doc-rust/Cargo.toml': '[package]\nname = "doc-rust"\n'
      }),
      root: '/repo'
    })).rejects.toThrow('crates/Cargo.toml does not exist');

    const brokenReaddir = {
      readFile: async () => '',
      readdir: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    };
    await expect(helperWorkspaceState({ fileSystem: brokenReaddir, root: '/repo' })).rejects.toThrow(
      'permission denied'
    );

    const brokenRead = {
      readdir: async () => [{ isDirectory: () => true, name: 'doc-rust' }],
      readFile: async () => {
        const error = new Error('broken read');
        error.code = 'EIO';
        throw error;
      }
    };
    await expect(helperWorkspaceState({ fileSystem: brokenRead, root: '/repo' })).rejects.toThrow('broken read');
  });
});
