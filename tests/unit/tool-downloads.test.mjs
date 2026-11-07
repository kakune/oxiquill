// @vitest-environment node
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureToolDownload,
  resolveWasmBindgen,
  toolDownloadPlan
} from '../../packages/oxiquill/src/generator/doc-runtime/tool-downloads.mjs';
import { hashBytes } from '../../packages/oxiquill/src/generator/doc-runtime/hashing.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(tool = 'wasm-bindgen') {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-tools-'));
  roots.push(root);
  const paths = { downloadCacheDir: root };
  const original = toolDownloadPlan({
    tool,
    version: tool === 'wasm-bindgen' ? '0.2.129' : '117',
    paths,
    platform: 'linux',
    arch: 'x64'
  });
  const archive = Buffer.from('official archive fixture');
  const plan = { ...original, sha256: hashBytes(archive) };
  const fetchImplementation = vi.fn(async () => ({ ok: true, arrayBuffer: async () => archive }));
  const runCommand = vi.fn(async (command, args) => {
    if (command === 'tar') {
      const stage = args[args.indexOf('-C') + 1];
      const executable = path.join(stage, plan.root, plan.executable);
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, 'executable fixture');
      return '';
    }
    expect(args).toEqual(['--version']);
    return `${tool} ${plan.version}`;
  });
  return { plan, paths, fetchImplementation, runCommand };
}

describe('verified runtime tools', () => {
  it.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64']
  ])('plans verified host releases for %s/%s', (platform, arch) => {
    for (const tool of ['wasm-bindgen', 'wasm-opt']) {
      const plan = toolDownloadPlan({
        tool,
        version: tool === 'wasm-bindgen' ? '0.2.129' : '117',
        paths: { downloadCacheDir: '/cache' },
        platform,
        arch
      });
      expect(plan.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(plan.url).toMatch(/^https:\/\/github.com\//u);
      expect(plan.command.endsWith('.exe')).toBe(platform === 'win32');
    }
  });

  it('rejects unsupported versions and hosts with expected version and cache context', () => {
    for (const override of [{ version: '0.2.1' }, { platform: 'freebsd' }, { arch: 'arm' }]) {
      expect(() =>
        toolDownloadPlan({
          tool: 'wasm-bindgen',
          version: '0.2.129',
          paths: { downloadCacheDir: '/cache' },
          platform: 'linux',
          arch: 'x64',
          ...override
        })
      ).toThrow(/No verified wasm-bindgen.*Cache:/u);
    }
  });

  it('uses exactly matching wasm-bindgen on PATH without downloading', async () => {
    const runCommand = vi.fn(async () => 'wasm-bindgen 0.2.129\n');
    expect(await resolveWasmBindgen({ version: '0.2.129', paths: { downloadCacheDir: '/cache' }, runCommand })).toEqual(
      { command: 'wasm-bindgen', identity: { version: '0.2.129' } }
    );
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it.each(['mismatching', 'missing'])('plans the verified fallback for a %s PATH binary', async (kind) => {
    const runCommand = vi.fn(async () => {
      if (kind === 'missing') throw new Error('ENOENT');
      return 'wasm-bindgen 0.2.100';
    });
    const plan = await resolveWasmBindgen({
      version: '0.2.129',
      paths: { downloadCacheDir: '/cache' },
      runCommand,
      platform: 'linux',
      arch: 'x64'
    });
    expect(plan.version).toBe('0.2.129');
    expect(plan.cacheDir).toContain('wasm-bindgen');
    expect(plan.sha256).toHaveLength(64);
  });

  it('does not swallow cancellation during a version probe', async () => {
    await expect(
      resolveWasmBindgen({
        version: '0.2.129',
        runCommand: async () => {
          throw new DOMException('cancelled', 'AbortError');
        }
      })
    ).rejects.toThrow('cancelled');
  });

  it.each(['wasm-bindgen', 'wasm-opt'])('verifies, extracts, versions and reuses %s', async (tool) => {
    const fixtureOptions = await fixture(tool);
    const { plan, runCommand, fetchImplementation } = fixtureOptions;
    expect(await ensureToolDownload(plan, fixtureOptions)).toBe(plan.command);
    expect(await readFile(plan.command, 'utf8')).toBe('executable fixture');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledTimes(2);
    await ensureToolDownload(plan, fixtureOptions);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledTimes(2);
    await writeFile(plan.command, 'corrupt');
    await ensureToolDownload(plan, fixtureOptions);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(await readFile(plan.command, 'utf8')).toBe('executable fixture');
  });

  it('rejects an invalid download checksum before extracting', async () => {
    const options = await fixture();
    options.fetchImplementation.mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from('tampered') });
    await expect(ensureToolDownload(options.plan, options)).rejects.toThrow(
      /expected version 0.2.129, cache .*SHA-256 verification failed/u
    );
    expect(options.runCommand).not.toHaveBeenCalled();
  });

  it.each(['HTTP', 'version', 'extract'])('preserves actionable %s failures', async (kind) => {
    const options = await fixture();
    if (kind === 'HTTP') options.fetchImplementation.mockResolvedValue({ ok: false, status: 503 });
    if (kind === 'version')
      options.runCommand
        .mockImplementationOnce(async (command, args) => {
          const target = path.join(args.at(-1), options.plan.root, options.plan.executable);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, 'binary');
        })
        .mockResolvedValueOnce('wasm-bindgen 0.2.1');
    if (kind === 'extract') options.runCommand.mockRejectedValue(new Error('tar is unavailable'));
    await expect(ensureToolDownload(options.plan, options)).rejects.toThrow(/expected version 0.2.129, cache/u);
  });

  it('repairs a corrupt archive and invalid integrity record', async () => {
    const options = await fixture();
    await mkdir(options.plan.cacheDir, { recursive: true });
    await writeFile(path.join(options.plan.cacheDir, 'archive.tar.gz'), 'corrupt');
    await writeFile(path.join(options.plan.cacheDir, 'integrity.json'), '{invalid');
    await ensureToolDownload(options.plan, options);
    expect(options.fetchImplementation).toHaveBeenCalledOnce();
    const record = JSON.parse(await readFile(path.join(options.plan.cacheDir, 'integrity.json'), 'utf8'));
    record.files[0].name = '../outside';
    await writeFile(path.join(options.plan.cacheDir, 'integrity.json'), JSON.stringify(record));
    await ensureToolDownload(options.plan, options);
    expect(options.runCommand).toHaveBeenCalledTimes(4);
  });
});
