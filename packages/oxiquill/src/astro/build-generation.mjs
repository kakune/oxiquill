import { readFileSync } from 'node:fs';
import { parseGeneratedCellManifest } from '../generator/doc-runtime/cell-manifest.mjs';
import {
  assertGenerationSnapshot,
  diffCells,
  diffGenerationSnapshots,
  readGenerationSnapshot,
  sourceChangedError
} from '../generator/doc-runtime/generation-snapshot.mjs';

// One context per integration, shared by remark and the main/worker plugins.
// Integration-only builds initialize it after astro:build:start generation.
export function createBuildGeneration({ paths, pythonOptions, generationId }) {
  let expected;

  function start(id) {
    let manifest;
    let state;
    try {
      manifest = parseGeneratedCellManifest(readFileSync(paths.cellsJsonPath, 'utf8'));
      state = JSON.parse(readFileSync(paths.runtimeOwnershipPath, 'utf8'));
    } catch (cause) {
      throw sourceChangedError([{ kind: 'changed', path: paths.cellsJsonPath }], { cause });
    }
    if (
      !id ||
      manifest?.generationId !== id ||
      !Array.isArray(manifest.cells) ||
      state?.generationId !== id ||
      state.snapshot?.generationId !== id
    ) {
      throw sourceChangedError([{ kind: 'changed', path: paths.cellsJsonPath }]);
    }
    expected = { ...manifest, snapshot: state.snapshot };
    return expected;
  }

  function current() {
    if (!expected && generationId) start(generationId);
    return expected;
  }

  return {
    start,
    current,
    validatePage(pagePath, cells) {
      const manifest = current();
      if (!manifest) return undefined;
      const changes = diffCells(
        manifest.snapshot.cells.filter((cell) => cell.pagePath === pagePath),
        cells
      );
      if (changes.length) return rejectChangedPage(manifest, pagePath, cells, changes);
      return manifest.generationId;
    },
    async checkSources() {
      const manifest = current();
      if (manifest) await assertGenerationSnapshot(manifest.snapshot, { paths, pythonOptions });
    }
  };

  async function rejectChangedPage(manifest, pagePath, cells, changes) {
    let actual;
    try {
      actual = await readGenerationSnapshot({ paths, pythonOptions });
    } catch (cause) {
      throw sourceChangedError([...changes, { kind: 'changed', path: cause.message }], { cause });
    }
    // The transformed tree can differ from disk if it was read just before an
    // edit. Include its actual cells as well as every other changed disk input.
    throw sourceChangedError(
      diffGenerationSnapshots(manifest.snapshot, {
        ...actual,
        cells: [...actual.cells.filter((cell) => cell.pagePath !== pagePath), ...cells]
      })
    );
  }
}
