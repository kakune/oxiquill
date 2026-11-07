import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defaultFileSystem, writeIfChanged } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';
import { runProcess } from './process-runner.mjs';

const releaseUrl = new URL('../runtime-data/tool-downloads.json', import.meta.url);
const releases = JSON.parse(
  readFileSync(
    releaseUrl.protocol === 'file:'
      ? releaseUrl
      : path.resolve(process.cwd(), 'packages/oxiquill/src/generator/runtime-data/tool-downloads.json'),
    'utf8'
  )
);

export function toolDownloadPlan({ tool, version, paths, platform = process.platform, arch = process.arch }) {
  const release = releases[tool];
  const host =
    tool === 'wasm-bindgen'
      ? {
          'linux:x64': 'x86_64-unknown-linux-musl',
          'linux:arm64': 'aarch64-unknown-linux-musl',
          'darwin:x64': 'x86_64-apple-darwin',
          'darwin:arm64': 'aarch64-apple-darwin',
          'win32:x64': 'x86_64-pc-windows-msvc'
        }[`${platform}:${arch}`]
      : {
          'linux:x64': 'x86_64-linux',
          'linux:arm64': 'aarch64-linux',
          'darwin:x64': 'x86_64-macos',
          'darwin:arm64': 'arm64-macos',
          'win32:x64': 'x86_64-windows'
        }[`${platform}:${arch}`];
  const cacheDir = path.join(paths.downloadCacheDir, 'tools', tool, String(version), host ?? `${platform}-${arch}`);
  if (release?.version !== version || !release.hosts[host]) {
    throw new Error(
      `No verified ${tool} ${version} release for ${platform}/${arch}; install the expected version on PATH. Cache: ${cacheDir}.`
    );
  }
  const root = tool === 'wasm-bindgen' ? `wasm-bindgen-${version}-${host}` : `binaryen-version_${version}`;
  const archive = tool === 'wasm-bindgen' ? `${root}.tar.gz` : `binaryen-version_${version}-${host}.tar.gz`;
  const url =
    tool === 'wasm-bindgen'
      ? `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${archive}`
      : `https://github.com/WebAssembly/binaryen/releases/download/version_${version}/${archive}`;
  const executable =
    tool === 'wasm-opt'
      ? `bin/wasm-opt${platform === 'win32' ? '.exe' : ''}`
      : `wasm-bindgen${platform === 'win32' ? '.exe' : ''}`;
  return Object.freeze({
    tool,
    version,
    host,
    cacheDir,
    url,
    sha256: release.hosts[host],
    root,
    executable,
    command: path.join(cacheDir, 'unpacked', root, executable),
    identity: { version, sha256: release.hosts[host] }
  });
}

export async function ensureToolDownload(
  plan,
  {
    fileSystem = defaultFileSystem,
    fetchImplementation = globalThis.fetch,
    runCommand = runProcess,
    processOptions = {}
  } = {}
) {
  const archivePath = path.join(plan.cacheDir, 'archive.tar.gz');
  const recordPath = path.join(plan.cacheDir, 'integrity.json');
  const verified = async () => {
    try {
      const record = JSON.parse(await fileSystem.readFile(recordPath, 'utf8'));
      return (
        record?.archive === plan.sha256 &&
        Array.isArray(record.files) &&
        record.files.length > 0 &&
        record.files.some((entry) => entry.name === path.join(plan.root, plan.executable)) &&
        (
          await Promise.all(
            record.files.map(async (entry) => {
              const { name, sha256 } = entry ?? {};
              if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/u).includes('..'))
                return false;
              return hashBytes(await fileSystem.readFile(path.join(plan.cacheDir, 'unpacked', name))) === sha256;
            })
          )
        ).every(Boolean)
      );
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code) || error instanceof SyntaxError) return false;
      throw error;
    }
  };
  if (await verified()) return plan.command;
  await fileSystem.mkdir(plan.cacheDir, { recursive: true });
  const temporary = path.join(plan.cacheDir, `.tmp-${randomUUID()}`);
  try {
    let bytes;
    try {
      bytes = await fileSystem.readFile(archivePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!bytes || hashBytes(bytes) !== plan.sha256) {
      const response = await fetchImplementation(plan.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${plan.url}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (hashBytes(bytes) !== plan.sha256) throw new Error(`SHA-256 verification failed (expected ${plan.sha256})`);
      await fileSystem.writeFile(`${temporary}.tar.gz`, bytes);
      await fileSystem.rename(`${temporary}.tar.gz`, archivePath);
    }
    await fileSystem.mkdir(temporary, { recursive: true });
    // Only an archive with a pinned official checksum reaches the extractor.
    await runCommand('tar', ['-xzf', archivePath, '-C', temporary], { ...processOptions, source: 'tar' });
    const executable = path.join(temporary, plan.root, plan.executable);
    const output = await runCommand(executable, ['--version'], {
      ...processOptions,
      captureOutput: true,
      source: plan.tool
    });
    const version = String(output).match(/\b\d+(?:\.\d+)*\b/u)?.[0];
    if (version !== plan.version) throw new Error(`downloaded executable reports ${version ?? '(unknown)'}`);
    const { listFiles } = await import('./file-system.mjs');
    const files = await Promise.all(
      (await listFiles(temporary, { fileSystem })).map(async (file) => ({
        name: path.relative(temporary, file),
        sha256: hashBytes(await fileSystem.readFile(file))
      }))
    );
    await fileSystem.rm(path.join(plan.cacheDir, 'unpacked'), { recursive: true, force: true });
    await fileSystem.rename(temporary, path.join(plan.cacheDir, 'unpacked'));
    await writeIfChanged(recordPath, JSON.stringify({ archive: plan.sha256, files }), { fileSystem });
    return plan.command;
  } catch (cause) {
    throw new Error(
      `Unable to resolve ${plan.tool}; expected version ${plan.version}, cache ${plan.cacheDir}: ${cause.message}. Install ${plan.tool} ${plan.version} on PATH and retry.`,
      { cause }
    );
  } finally {
    await fileSystem.rm(temporary, { recursive: true, force: true });
    await fileSystem.rm(`${temporary}.tar.gz`, { force: true });
  }
}

export async function resolveWasmBindgen({
  version,
  paths,
  runCommand = runProcess,
  environment = process.env,
  platform,
  arch,
  processOptions = {}
}) {
  try {
    const output = await runCommand('wasm-bindgen', ['--version'], {
      ...processOptions,
      env: environment,
      captureOutput: true
    });
    if (String(output).trim() === `wasm-bindgen ${version}`) return { command: 'wasm-bindgen', identity: { version } };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }
  return toolDownloadPlan({ tool: 'wasm-bindgen', version, paths, platform, arch });
}
