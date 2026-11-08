import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import { defaultFileSystem } from './file-system.mjs';
import { hashBytes, hashText, stableFingerprint } from './hashing.mjs';
import { toolDownloadPlan } from './tool-downloads.mjs';
import { createRuntimeEvents } from './runtime-events.mjs';

export const WASM_OPT_CACHE_SCHEMA = 1;
export const WASM_OPT_ARGS = Object.freeze(['-O']);
const identities = new Map();
const entryPattern = /^[a-f0-9]{64}\.[a-f0-9]{64}\.wasm$/u;

// BINARYEN_CORES only selects optimizer parallelism; Binaryen output is identical
// for every thread count, so it never invalidates cached or published modules.
export function binaryenEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([name, value]) => name.startsWith('BINARYEN_') && name !== 'BINARYEN_CORES' && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function wasmOptCacheKey({
  input,
  identity,
  args = WASM_OPT_ARGS,
  environment = {},
  schema = WASM_OPT_CACHE_SCHEMA
}) {
  return hashText(
    stableFingerprint({
      schema,
      input: { sha256: hashBytes(input), size: input.length },
      identity,
      args,
      environment: binaryenEnvironment(environment)
    })
  );
}

export async function resolveWasmOpt({
  environment = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  fileSystem = defaultFileSystem,
  runCommand,
  provision = false,
  paths,
  memoize = false
}) {
  const lookup = async () => {
    const pathApi = platform === 'win32' ? path.win32 : path;
    const envValue = (name) =>
      Object.entries(environment).find(([key]) =>
        platform === 'win32' ? key.toUpperCase() === name : key === name
      )?.[1];
    const extensions = platform === 'win32' ? (envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
    const candidates = (
      envValue('PATH') === undefined ? [] : envValue('PATH').split(platform === 'win32' ? ';' : ':')
    ).flatMap((directory) =>
      extensions.map((extension) => pathApi.resolve(cwd, directory.replace(/^"|"$/gu, ''), `wasm-opt${extension}`))
    );
    for (const command of candidates) {
      try {
        if (!(await fileSystem.stat(command)).isFile()) continue;
        await fileSystem.access(command, platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) continue;
        throw error;
      }
      const [version, executable] = await Promise.all([
        runCommand(command, ['--version'], { env: environment, cwd, captureOutput: true }),
        fileSystem.readFile(command)
      ]);
      return Object.freeze({
        command,
        identity: Object.freeze({ version: String(version), sha256: hashBytes(executable) })
      });
    }
    return provision
      ? toolDownloadPlan({ tool: 'wasm-opt', version: '117', paths, platform })
      : Object.freeze({ identity: 'unavailable' });
  };
  if (!memoize) return lookup();
  const key = stableFingerprint([
    platform,
    cwd,
    Object.entries(environment)
      .filter(([name]) => ['PATH', 'PATHEXT'].includes(name.toUpperCase()))
      .sort()
  ]);
  if (!identities.has(key)) identities.set(key, lookup());
  return identities.get(key);
}

export const WASM_OPT_CACHE_MINIMUM_ENTRIES = 16;

export function cacheEntriesToRemove(entries, now, keep = WASM_OPT_CACHE_MINIMUM_ENTRIES) {
  const completed = entries
    .filter(({ name }) => entryPattern.test(name))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return [
    ...completed.slice(Math.max(WASM_OPT_CACHE_MINIMUM_ENTRIES, keep)),
    ...entries.filter(({ name, mtimeMs }) => name.startsWith('.tmp-') && now - mtimeMs > 60 * 60 * 1000)
  ];
}

// Only cache I/O is best effort. Optimizer and staged-output failures must propagate.
export async function optimizeRustWasmFiles({
  directory,
  cacheDir,
  cwd,
  optimizer,
  environment,
  runCommand,
  events = createRuntimeEvents(),
  context = {},
  fileSystem = defaultFileSystem,
  prune = true
}) {
  let cacheEnabled = true;
  const cacheIO = async (action) => {
    if (!cacheEnabled) return undefined;
    try {
      return await action();
    } catch {
      cacheEnabled = false;
      return undefined;
    }
  };
  const files = (await fileSystem.readdir(directory)).filter((name) => name.endsWith('.wasm')).sort();
  for (const name of files) {
    const inputPath = path.join(directory, name);
    const input = await fileSystem.readFile(inputPath);
    const key = wasmOptCacheKey({ input, identity: optimizer.identity, environment });
    const hit = await cacheIO(async () => {
      await fileSystem.mkdir(cacheDir, { recursive: true });
      const entries = (await fileSystem.readdir(cacheDir))
        .filter((entry) => entry.startsWith(`${key}.`) && entryPattern.test(entry))
        .sort();
      for (const entry of entries) {
        const entryPath = path.join(cacheDir, entry);
        let bytes;
        try {
          bytes = await fileSystem.readFile(entryPath);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        if (hashBytes(bytes) !== entry.split('.')[1]) {
          await fileSystem.rm(entryPath, { force: true });
          continue;
        }
        const now = new Date();
        // A failed recency update does not invalidate already verified bytes.
        await cacheIO(() => fileSystem.utimes(entryPath, now, now));
        return bytes;
      }
      return undefined;
    });
    if (hit !== undefined) {
      await fileSystem.writeFile(inputPath, hit);
      events.skipped('optimize', { ...context, cache: 'hit' });
      continue;
    }
    const temporaryName = `.tmp-${randomUUID()}`;
    const cacheTemporaryPath = path.join(cacheDir, temporaryName);
    const reserved = await cacheIO(async () => {
      const handle = await fileSystem.open(cacheTemporaryPath, 'wx');
      await handle.close();
      return true;
    });
    const temporaryPath = reserved ? cacheTemporaryPath : path.join(directory, temporaryName);
    try {
      try {
        await events.phase('optimize', { ...context, cache: 'miss' }, () =>
          runCommand(optimizer.command, [inputPath, '-o', temporaryPath, ...WASM_OPT_ARGS], {
            env: environment,
            cwd,
            ...context,
            phase: 'optimize'
          })
        );
      } catch (error) {
        throw new Error(`Rust Wasm optimization failed with ${optimizer.command}: ${error.message}`, { cause: error });
      }
      const bytes = await fileSystem.readFile(temporaryPath);
      await fileSystem.writeFile(inputPath, bytes);
      await cacheIO(async () => {
        const destination = path.join(cacheDir, `${key}.${hashBytes(bytes)}.wasm`);
        try {
          await fileSystem.link(temporaryPath, destination);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          if (hashBytes(await fileSystem.readFile(destination)) !== hashBytes(bytes)) {
            await fileSystem.rm(destination, { force: true });
            // Another writer may win the race after removing a corrupt entry.
            try {
              await fileSystem.link(temporaryPath, destination);
            } catch (retryError) {
              if (retryError?.code !== 'EEXIST') throw retryError;
            }
          }
        }
        if (prune) await pruneWasmOptCache({ cacheDir, fileSystem });
      });
    } finally {
      await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

export async function pruneWasmOptCache({
  cacheDir,
  fileSystem = defaultFileSystem,
  now = Date.now(),
  keep = WASM_OPT_CACHE_MINIMUM_ENTRIES
}) {
  const entries = (
    await Promise.all(
      (await fileSystem.readdir(cacheDir)).map(async (name) => {
        try {
          const info = await fileSystem.stat(path.join(cacheDir, name));
          return info.isFile() ? { name, mtimeMs: info.mtimeMs } : undefined;
        } catch (error) {
          if (error?.code === 'ENOENT') return undefined;
          throw error;
        }
      })
    )
  ).filter(Boolean);
  await Promise.all(
    cacheEntriesToRemove(entries, now, keep).map(({ name }) =>
      fileSystem.rm(path.join(cacheDir, name), { force: true })
    )
  );
}
