// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeProject, packageNameFromTarget, starterFiles } from '../../packages/oxiquill/src/cli/init.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const starterRoot = path.join(repositoryRoot, 'templates/basic');
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe('oxiquill init', () => {
  it('creates the complete starter in a new target and prints executable next steps', async () => {
    const cwd = await temporaryDirectory();
    const log = vi.fn();

    const result = await initializeProject({ cwd, directory: 'My Docs!', log, starterRoot });

    expect(result).toEqual({ packageName: 'my-docs', targetPath: path.join(cwd, 'My Docs!') });
    expect(await relativeFiles(result.targetPath)).toEqual([...starterFiles].sort());
    const packageJson = JSON.parse(await readFile(path.join(result.targetPath, 'package.json'), 'utf8'));
    expect(packageJson).toEqual(
      expect.objectContaining({
        engines: { node: '>=24.0.0' },
        name: 'my-docs',
        packageManager: 'pnpm@11.2.2',
        scripts: {
          build: 'oxiquill build',
          check: 'oxiquill check',
          clean: 'oxiquill clean',
          dev: 'oxiquill dev',
          preview: 'oxiquill preview'
        }
      })
    );
    await expect(access(path.join(result.targetPath, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(result.targetPath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    const navigationCommand =
      process.platform === 'win32' ? "  Set-Location -LiteralPath 'My Docs!'" : "  cd -- 'My Docs!'";
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      `Created an Oxiquill project in ${result.targetPath}.`,
      '',
      'Next steps:',
      navigationCommand,
      '  pnpm install',
      '  pnpm dev'
    ]);
  });

  it.each([
    ['a path with spaces', "cd -- 'a path with spaces'"],
    ["apostrophe's", "cd -- 'apostrophe'\\''s'"],
    ['$(touch injected)', "cd -- '$(touch injected)'"],
    ['`touch injected`', "cd -- '`touch injected`'"],
    ['$PROJECT', "cd -- '$PROJECT'"],
    ['back\\slash', "cd -- 'back\\slash'"],
    ['Windows\\Style Path', "cd -- 'Windows\\Style Path'"]
  ])('prints a safely quoted POSIX navigation command for %s', async (directory, expected) => {
    const cwd = await temporaryDirectory();
    const log = vi.fn();

    await initializeProject({ cwd, directory, log, platform: 'linux', starterRoot });

    expect(log.mock.calls.flat()).toContain(`  ${expected}`);
  });

  it.each([
    ['a path with spaces', "Set-Location -LiteralPath 'a path with spaces'"],
    ["apostrophe's", "Set-Location -LiteralPath 'apostrophe''s'"],
    ['$(touch injected)', "Set-Location -LiteralPath '$(touch injected)'"],
    ['`touch injected`', "Set-Location -LiteralPath '`touch injected`'"],
    ['$PROJECT', "Set-Location -LiteralPath '$PROJECT'"],
    ['back\\slash', "Set-Location -LiteralPath 'back\\slash'"],
    ['Windows\\Style Path', "Set-Location -LiteralPath 'Windows\\Style Path'"]
  ])('prints a literal PowerShell navigation command for %s', async (directory, expected) => {
    const cwd = await temporaryDirectory();
    const log = vi.fn();

    await initializeProject({ cwd, directory, log, platform: 'win32', starterRoot });

    expect(log.mock.calls.flat()).toContain(`  ${expected}`);
  });

  it.runIf(process.platform !== 'win32')('does not execute shell content embedded in a POSIX path', async () => {
    const cwd = await temporaryDirectory();
    const directory = '$(touch dollar-injected)`touch backtick-injected`';
    const log = vi.fn();
    const result = await initializeProject({ cwd, directory, log, platform: 'linux', starterRoot });
    const command = log.mock.calls
      .flat()
      .find((message) => message.startsWith('  cd -- '))
      .trim();

    const executed = spawnSync('sh', ['-c', `${command}\npwd`], { cwd, encoding: 'utf8' });

    expect(executed.status).toBe(0);
    expect(await realpath(executed.stdout.trim())).toBe(await realpath(result.targetPath));
    await expect(access(path.join(cwd, 'dollar-injected'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(cwd, 'backtick-injected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['newline', 'bad\npath'],
    ['tab', 'bad\tpath'],
    ['escape', 'bad\u001bpath'],
    ['delete', 'bad\u007fpath']
  ])('rejects a %s control character before creating files', async (_name, directory) => {
    const cwd = await temporaryDirectory();

    await expect(initializeProject({ cwd, directory, starterRoot })).rejects.toThrow('contains control characters');

    expect(await readdir(cwd)).toEqual([]);
  });

  it('initializes an existing empty current directory without printing a cd command', async () => {
    const cwd = await temporaryDirectory();
    const log = vi.fn();

    await initializeProject({ cwd, log, starterRoot });

    expect(await relativeFiles(cwd)).toEqual([...starterFiles].sort());
    expect(log.mock.calls.flat()).not.toContain(expect.stringMatching(/^ {2}cd /u));
  });

  it('initializes a nested target whose parent directories do not exist', async () => {
    const cwd = await temporaryDirectory();

    const result = await initializeProject({ cwd, directory: path.join('nested', 'my-docs'), starterRoot });

    expect(result.targetPath).toBe(path.join(cwd, 'nested', 'my-docs'));
    expect(await relativeFiles(result.targetPath)).toEqual([...starterFiles].sort());
  });

  it('never changes a non-empty target or a file target', async () => {
    const cwd = await temporaryDirectory();
    const nonEmptyTarget = path.join(cwd, 'existing');
    const fileTarget = path.join(cwd, 'file-target');
    await mkdir(nonEmptyTarget);
    await writeFile(path.join(nonEmptyTarget, 'keep.txt'), 'keep');
    await writeFile(fileTarget, 'keep-file');

    await expect(initializeProject({ cwd, directory: 'existing', starterRoot })).rejects.toThrow('is not empty');
    await expect(initializeProject({ cwd, directory: 'file-target', starterRoot })).rejects.toThrow(
      'is not a directory'
    );

    expect(await readFile(path.join(nonEmptyTarget, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(fileTarget, 'utf8')).toBe('keep-file');
  });

  it.runIf(process.platform !== 'win32')('rejects a symbolic-link target', async () => {
    const cwd = await temporaryDirectory();
    const actualTarget = path.join(cwd, 'actual');
    const linkedTarget = path.join(cwd, 'linked');
    await mkdir(actualTarget);
    await symlink(actualTarget, linkedTarget, 'dir');

    await expect(initializeProject({ cwd, directory: 'linked', starterRoot })).rejects.toThrow('is not a directory');
    expect(await readdir(actualTarget)).toEqual([]);
  });

  it('rolls back only the files and directories created during a failed initialization', async () => {
    const cwd = await temporaryDirectory();
    const targetPath = path.join(cwd, 'existing-empty');
    let writes = 0;
    await mkdir(targetPath);

    await expect(
      initializeProject({
        cwd,
        directory: 'existing-empty',
        fileSystem: {
          writeFile: async (...args) => {
            writes += 1;
            if (writes === 3) throw new Error('injected write failure');
            return writeFile(...args);
          }
        },
        starterRoot
      })
    ).rejects.toThrow('injected write failure');

    expect((await lstat(targetPath)).isDirectory()).toBe(true);
    expect(await readdir(targetPath)).toEqual([]);
  });

  it('rolls back a newly created nested target and its empty parent structure', async () => {
    const cwd = await temporaryDirectory();

    await expect(
      initializeProject({
        cwd,
        directory: path.join('nested', 'my-docs'),
        fileSystem: {
          writeFile: async () => {
            throw new Error('injected nested write failure');
          }
        },
        starterRoot
      })
    ).rejects.toThrow('injected nested write failure');

    expect(await readdir(cwd)).toEqual([]);
  });

  it('rejects escaping or missing starter sources before creating the target', async () => {
    const cwd = await temporaryDirectory();
    const emptyStarter = await temporaryDirectory();

    await expect(initializeProject({ cwd, directory: 'escape', files: ['../outside'], starterRoot })).rejects.toThrow(
      'starter source escapes its root'
    );
    await expect(initializeProject({ cwd, directory: 'missing', starterRoot: emptyStarter })).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(access(path.join(cwd, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(cwd, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates starter metadata and file types before creating the target', async () => {
    const cwd = await temporaryDirectory();
    const invalidMetadataStarter = await temporaryDirectory();
    const directoryStarter = await temporaryDirectory();
    await writeFile(path.join(invalidMetadataStarter, 'package.json'), '{ invalid json');
    await mkdir(path.join(directoryStarter, 'README.md'));

    await expect(
      initializeProject({
        cwd,
        directory: 'invalid-metadata',
        files: ['package.json'],
        starterRoot: invalidMetadataStarter
      })
    ).rejects.toThrow('Starter package metadata is invalid');
    await expect(
      initializeProject({ cwd, directory: 'directory-source', files: ['README.md'], starterRoot: directoryStarter })
    ).rejects.toThrow('Starter source is not a regular file');

    await expect(access(path.join(cwd, 'invalid-metadata'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(cwd, 'directory-source'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite a file created after the target emptiness check', async () => {
    const cwd = await temporaryDirectory();
    const targetPath = path.join(cwd, 'raced-target');
    const racedFile = path.join(targetPath, '.gitignore');
    let injectCollision = true;
    await mkdir(targetPath);

    await expect(
      initializeProject({
        cwd,
        directory: 'raced-target',
        fileSystem: {
          writeFile: async (...args) => {
            if (injectCollision) {
              injectCollision = false;
              await writeFile(racedFile, 'created concurrently\n');
            }
            return writeFile(...args);
          }
        },
        starterRoot
      })
    ).rejects.toThrow('Could not initialize an Oxiquill project');

    expect(await readFile(racedFile, 'utf8')).toBe('created concurrently\n');
    expect(await relativeFiles(targetPath)).toEqual(['.gitignore']);
  });

  it.each([
    ['My Docs', 'my-docs'],
    ['UPPER_case', 'upper_case'],
    ['Hello, world!!!', 'hello-world'],
    ['Crème Brûlée', 'creme-brulee'],
    ['node_modules', 'oxiquill-docs'],
    ['favicon.ico', 'oxiquill-docs'],
    ['!!!', 'oxiquill-docs'],
    ['C:\\Users\\Example\\Windows Docs\\', 'windows-docs'],
    ['/home/example/My Project/', 'my-project']
  ])('derives the npm package name from %s', (target, expected) => {
    expect(packageNameFromTarget(target)).toBe(expected);
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'oxiquill-init-'));
  temporaryRoots.push(directory);
  return directory;
}

async function relativeFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      return entry.isDirectory()
        ? (await relativeFiles(entryPath)).map((child) => path.join(entry.name, child))
        : [entry.name];
    })
  );
  return nested
    .flat()
    .map((filePath) => filePath.split(path.sep).join('/'))
    .sort();
}
