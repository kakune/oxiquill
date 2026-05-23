import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cargoArgsForHelperWorkspace,
  helperWorkspaceState,
  runHelperCargo
} from '../../scripts/run-helper-cargo.mjs';

function memoryPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function createMemoryFileSystem(initialFiles = {}) {
  const files = new Set(Object.keys(initialFiles).map(memoryPath));
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
      const normalizedPath = memoryPath(filePath);
      if (files.has(normalizedPath)) return initialFiles[normalizedPath];
      const error = new Error(`missing ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
    readdir: async (directory) => {
      const normalizedDirectory = memoryPath(directory);
      if (!directories.has(normalizedDirectory)) {
        const error = new Error(`missing ${directory}`);
        error.code = 'ENOENT';
        throw error;
      }

      const childNames = new Set();
      for (const filePath of files) {
        if (filePath.startsWith(`${normalizedDirectory}/`)) {
          childNames.add(filePath.slice(normalizedDirectory.length + 1).split('/')[0]);
        }
      }
      for (const candidate of directories) {
        if (candidate.startsWith(`${normalizedDirectory}/`) && candidate !== normalizedDirectory) {
          childNames.add(candidate.slice(normalizedDirectory.length + 1).split('/')[0]);
        }
      }

      return Array.from(childNames).map((name) => {
        const fullPath = `${normalizedDirectory}/${name}`;
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
    const manifestPath = path.join('crates', 'Cargo.toml');

    expect(cargoArgsForHelperWorkspace(['test'], manifestPath)).toEqual([
      'test',
      '--manifest-path',
      manifestPath,
      '--workspace'
    ]);
    expect(cargoArgsForHelperWorkspace(['clippy', '--all-targets', '--', '-D', 'warnings'], manifestPath)).toEqual([
      'clippy',
      '--all-targets',
      '--manifest-path',
      manifestPath,
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
      workspaceManifestPath: path.join('crates', 'Cargo.toml')
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
        ['doc', '--no-deps', '--manifest-path', path.join('crates', 'Cargo.toml'), '--workspace'],
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
    })).rejects.toThrow(/crates[\\/]Cargo\.toml does not exist/);

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
