/** @typedef {import('./types.js').RustRuntimeRegistry} RustRuntimeRegistry */
/** @typedef {import('./types.js').RustRuntimeModule} RustRuntimeModule */

/** Validate metadata without performing I/O; shared by producers and consumers.
 * @param {unknown} registry
 * @param {readonly {id: string, language: string, kind?: string}[]} cells
 * @returns {asserts registry is RustRuntimeRegistry}
 */
export function validateRustRegistry(registry, cells) {
  if (!isRecord(registry) || registry.version !== 1 || !Array.isArray(registry.modules)) {
    throw new Error('Rust runtime registry must use version 1 and contain modules.');
  }
  const rustCells = new Set(
    cells.filter((cell) => cell.language === 'rust' && cell.kind !== 'definitions').map((cell) => cell.id)
  );
  const assignments = new Map();
  const ids = new Set();
  for (const module of registry.modules) {
    const context = `Rust module ${JSON.stringify(module?.id)} (cells: ${JSON.stringify(module?.cells)})`;
    if (
      !isRecord(module) ||
      typeof module.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(module.id) ||
      ids.has(module.id)
    ) {
      throw new Error(`${context} has an invalid or duplicate id.`);
    }
    ids.add(module.id);
    if (
      typeof module.fingerprint !== 'string' ||
      !module.fingerprint ||
      !validAssetUrl(module.glue?.url) ||
      !validAssetUrl(module.wasm?.url) ||
      !/^sha384-[A-Za-z0-9+/]{64}$/u.test(module.wasm?.integrity ?? '') ||
      !Number.isSafeInteger(module.wasm?.bytes) ||
      module.wasm.bytes <= 0 ||
      !Array.isArray(module.cells)
    )
      throw new Error(`${context} has invalid asset metadata.`);
    for (const cell of module.cells) {
      if (!rustCells.has(cell)) throw new Error(`${context} assigns unknown or non-Rust cell ${JSON.stringify(cell)}.`);
      if (assignments.has(cell)) {
        throw new Error(`${context} duplicates cell ${cell}, already assigned to module ${assignments.get(cell)}.`);
      }
      assignments.set(cell, module.id);
    }
  }
  const missing = [...rustCells].filter((cell) => !assignments.has(cell));
  if (missing.length)
    throw new Error(`Rust registry modules [${[...ids].join(', ')}] are missing cells: ${missing.join(', ')}.`);
}

/** @param {RustRuntimeRegistry} registry @param {string} cellId @returns {RustRuntimeModule} */
export function rustModuleForCell(registry, cellId) {
  const module = registry.modules.find((candidate) => candidate.cells.includes(cellId));
  if (!module) throw new Error(`Rust cell ${cellId} has no registered module. Regenerate the Wasm runtime.`);
  return module;
}

/** @param {RustRuntimeRegistry} registry @param {string} base @returns {RustRuntimeRegistry} */
export function resolveRustRegistryUrls(registry, base) {
  const prefix = `/${base.split('/').filter(Boolean).join('/')}`.replace(/\/$/u, '');
  const resolve = (url) => `${prefix}/${url.replace(/^\//u, '')}`;
  return {
    version: 1,
    modules: registry.modules.map((module) => ({
      ...module,
      glue: { ...module.glue, url: resolve(module.glue.url) },
      wasm: { ...module.wasm, url: resolve(module.wasm.url) }
    }))
  };
}

function validAssetUrl(url) {
  try {
    return (
      typeof url === 'string' &&
      url.length > 0 &&
      !/[?#\\]/u.test(url) &&
      !url.startsWith('//') &&
      !url.includes(':') &&
      !url
        .split('/')
        .some(
          (segment) => ['.', '..'].includes(decodeURIComponent(segment)) || /[/\\]/u.test(decodeURIComponent(segment))
        )
    );
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
