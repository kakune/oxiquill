import { createHash } from 'node:crypto';
import { InteractiveCellValidationError } from './cell-diagnostics.mjs';
import { rustReservedIdentifiers } from './rust-names.mjs';

const namePattern = /^[a-z][a-z0-9_]*$/u;
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const generatedNames = new Set(['inputs', 'dependencies', 'cell_id', 'inputs_json', 'dependencies_json']);

export function normalizeDataMetadata(metadata, inputs, language, context, locate, diagnostics) {
  const result = {};
  const fail = (fieldPath, message) => diagnostics.push({ ...context, ...locate(fieldPath), fieldPath, message });
  ['exports', 'dependsOn', 'cache'].forEach((field) => {
    if (Object.hasOwn(metadata, field) && language !== 'rust')
      fail(field, `data dependencies are not yet supported for ${language} cells`);
  });
  if (Object.hasOwn(metadata, 'exports')) {
    result.exports = [];
    if (!Array.isArray(metadata.exports) || metadata.exports.length === 0) {
      fail('exports', 'Expected a non-empty array of export names.');
    } else {
      metadata.exports.forEach((name, index) => {
        if (typeof name !== 'string' || !namePattern.test(name))
          fail(`exports[${index}]`, 'Expected an export name matching ^[a-z][a-z0-9_]*$.');
        else if (result.exports.includes(name)) fail(`exports[${index}]`, `Duplicate export name "${name}".`);
        else result.exports.push(name);
      });
    }
  }
  if (Object.hasOwn(metadata, 'dependsOn')) {
    result.dependsOn = {};
    if (!record(metadata.dependsOn)) fail('dependsOn', 'Expected a mapping of bindings to page-local cell references.');
    else
      Object.entries(metadata.dependsOn).forEach(([name, value]) => {
        const field = `dependsOn.${name}`;
        if (!namePattern.test(name) || rustReservedIdentifiers.has(name) || generatedNames.has(name))
          fail(field, `Invalid or reserved dependency binding "${name}".`);
        if (
          inputs.some((input) => (rustReservedIdentifiers.has(input.name) ? `cell_${input.name}` : input.name) === name)
        )
          fail(field, `Dependency binding "${name}" collides with an input.`);
        const dependency = typeof value === 'string' ? { cell: value } : value;
        if (!record(dependency) || typeof dependency.cell !== 'string' || !idPattern.test(dependency.cell)) {
          fail(field, 'Expected a page-local cell id or { cell, type }.');
          return;
        }
        Object.keys(dependency)
          .filter((key) => !['cell', 'type'].includes(key))
          .forEach((key) => fail(`${field}.${key}`, 'Unknown dependency field.'));
        if (Object.hasOwn(dependency, 'type') && (typeof dependency.type !== 'string' || !dependency.type.trim()))
          fail(`${field}.type`, 'Expected a non-empty Rust type.');
        result.dependsOn[name] = { ...dependency };
      });
  }
  if (Object.hasOwn(metadata, 'cache')) {
    result.cache = metadata.cache;
    if (metadata.cache !== 'inputs') fail('cache', 'Expected inputs.');
    if (!result.exports?.length) fail('cache', 'Caching requires declared exports.');
  }
  return result;
}

// Keep authoring references page-local until all blocks have been collected.
export function resolveDataDependencies(cells) {
  const byId = new Map(cells.map((cell) => [`${cell.pagePath}\0${cell.localId}`, cell]));
  const resolved = new Map();
  const visit = (cell, ancestors = []) => {
    if (resolved.has(cell.id)) return resolved.get(cell.id);
    const dependsOn = Object.fromEntries(
      Object.entries(cell.dependsOn ?? {}).map(([name, dependency]) => {
        const fieldPath = `dependsOn.${name}`;
        const fail = (message) => {
          throw new InteractiveCellValidationError([
            {
              pagePath: cell.pagePath,
              cellId: cell.localId,
              fenceStartLine: cell.fenceStartLine,
              ...cell.fieldPositions?.dependsOn,
              fieldPath,
              message
            }
          ]);
        };
        const target = byId.get(`${cell.pagePath}\0${dependency.cell}`);
        if (!target) fail(`Cell "${dependency.cell}" does not exist on this page; dependsOn must be page-local.`);
        if (target.language !== 'rust') fail(`data dependencies are not yet supported for ${target.language} cells`);
        if (!target.exports?.length) fail(`Producer "${dependency.cell}" declares no exports.`);
        const chain = [...ancestors, cell];
        const cycleStart = chain.findIndex((entry) => entry.id === target.id);
        if (cycleStart >= 0)
          fail(
            `Cyclic data dependency: ${[...chain.slice(cycleStart), target].map((entry) => entry.localId).join(' -> ')}.`
          );
        visit(target, chain);
        return [name, { ...dependency, cell: target.id }];
      })
    );
    const producerFingerprint = cell.exports?.length
      ? createHash('sha256')
          .update(
            JSON.stringify([
              cell.source.replace(/\r\n/gu, '\n'),
              (cell.definitions ?? []).map((block) => [block.id, block.source.replace(/\r\n/gu, '\n')])
            ])
          )
          .digest('hex')
      : undefined;
    const result = {
      ...cell,
      ...(cell.dependsOn ? { dependsOn } : {}),
      ...(producerFingerprint ? { producerFingerprint } : {})
    };
    resolved.set(cell.id, result);
    return result;
  };
  return cells.map((cell) => visit(cell));
}
