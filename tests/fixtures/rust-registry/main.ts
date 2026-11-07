import { fixture } from 'fixture:registry';
import { createInteractiveCellRunner } from '../../../packages/oxiquill/src/lib/doc-runtime/runtime-client';
import type { CellManifest, RustRuntimeRegistry } from '../../../packages/oxiquill/src/lib/doc-runtime/types';

declare module 'fixture:registry' {
  export const fixture: { cells: CellManifest[]; registry: RustRuntimeRegistry; replacement: RustRuntimeRegistry };
}

let registry = fixture.registry;
const output = document.querySelector<HTMLOutputElement>('#result');
if (!output) throw new Error('Missing result output');
let starts = 0;
const runner = createInteractiveCellRunner({
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
  createWorker: () => {
    document.body.dataset.workers = String(++starts);
    return new Worker(new URL('../../../packages/oxiquill/src/lib/doc-runtime/rust-worker.ts', import.meta.url), {
      type: 'module'
    });
  }
});
runner.updateRustRegistry(registry);
for (const [index, id] of ['first', 'second'].entries()) {
  document.getElementById(id)?.addEventListener('click', () => {
    const cell = fixture.cells[index];
    const module = registry.modules.find((candidate) => candidate.cells.includes(cell.id));
    output.textContent = 'running';
    void runner.runInteractiveCell(cell, {}, undefined, undefined, undefined, undefined, module).then(
      (result) => {
        output.textContent = JSON.stringify(result.outputs);
      },
      (error: Error) => {
        output.textContent = error.message;
      }
    );
  });
}
function update(next: RustRuntimeRegistry) {
  registry = next;
  runner.updateRustRegistry(next);
}
document.getElementById('replace')?.addEventListener('click', () => update(fixture.replacement));
document.getElementById('corrupt')?.addEventListener('click', () =>
  update({
    version: 1,
    modules: fixture.registry.modules.map((module, index) =>
      index === 0
        ? { ...module, fingerprint: 'corrupt', wasm: { ...module.wasm, integrity: `sha384-${'A'.repeat(64)}` } }
        : module
    )
  })
);
document.getElementById('restore')?.addEventListener('click', () => update(fixture.registry));
