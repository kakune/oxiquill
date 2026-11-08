import path from 'node:path';
import { createRequire } from 'node:module';
import { vi } from 'vitest';

const { parse, stringify } = createRequire(path.resolve('packages/oxiquill/package.json'))('smol-toml');

// Stands in for Cargo plus post-link work: writes raw bindgen output for every
// stale group and lets the pipeline finalize it. `fail(group)` returns a failure.
export function createFakeRustBuilder({
  fileSystem,
  wasm = (group) => Buffer.from(group.buildFingerprint),
  fail
} = {}) {
  return vi.fn(async ({ groups, stageDir, finalize }) => {
    const results = [];
    for (const group of groups) {
      const failure = fail?.(group);
      if (failure) {
        results.push({
          group,
          ok: false,
          kind: failure.kind ?? 'compile',
          messages: failure.messages ?? [],
          error: failure.error ?? Object.assign(new Error('cargo exited with 101'), { exitCode: 101 })
        });
        continue;
      }
      const directory = path.join(stageDir, group.id);
      await fileSystem.mkdir(directory, { recursive: true });
      await fileSystem.writeFile(path.join(directory, 'doc_rust_cells.js'), 'const wasm = "doc_rust_cells_bg.wasm";');
      await fileSystem.writeFile(path.join(directory, 'doc_rust_cells_bg.wasm'), wasm(group));
      results.push({ group, ok: true, value: await finalize(group, directory) });
    }
    return { results, dependencyMessages: [] };
  });
}

// Stands in for Cargo's unlocked resolve: keeps the seeded registry packages and
// adds one entry per workspace member.
export function createFakeLockResolver(fileSystem) {
  return vi.fn(async ({ paths }) => {
    const directory = paths.rustCellsDir;
    const read = async (file) => parse(String(await fileSystem.readFile(path.join(directory, file), 'utf8')));
    const manifest = await read('Cargo.toml');
    const seed = await read('Cargo.lock');
    const members = await Promise.all(
      manifest.workspace.members.map(async (member) => {
        const crate = await read(path.join(member, 'Cargo.toml'));
        return {
          name: crate.package.name,
          version: crate.package.version,
          dependencies: Object.keys(crate.dependencies ?? {}).sort()
        };
      })
    );
    const packages = [...(seed.package ?? []).filter((entry) => entry.source), ...members].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    await fileSystem.writeFile(path.join(directory, 'Cargo.lock'), stringify({ version: 4, package: packages }));
  });
}
