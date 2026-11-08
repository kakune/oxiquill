import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
import type { CellManifest, JsonObject, JsonValue } from './types.js';

export function validateCellExports(
  value: unknown,
  producer?: Pick<CellManifest, 'title' | 'exports'>
): JsonObject | undefined {
  const fail = (message: string): never => {
    throw new Error(`Producer ${producer?.title ?? 'cell'}: ${message}`);
  };
  if (value === undefined) {
    if (producer?.exports?.length) fail(`missing export ${producer.exports[0]}`);
    return undefined;
  }
  const seen = new Set<object>();
  function copy(candidate: unknown): JsonValue {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate))
      return fail('exports require finite JSON data');
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null)
      return fail('exports require plain JSON values');
    seen.add(candidate);
    const entries = Object.entries(Object.getOwnPropertyDescriptors(candidate)).filter(([name]) => name !== 'length');
    const values = entries.map(([name, descriptor]) => {
      if (!Object.hasOwn(descriptor, 'value')) return fail('exports require plain JSON values');
      return [name, copy(descriptor.value)] as const;
    });
    seen.delete(candidate);
    return Object.freeze(Array.isArray(candidate) ? values.map(([, entry]) => entry) : Object.fromEntries(values));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('exports require a JSON object');
  const result = copy(value) as JsonObject;
  if (producer) {
    for (const name of producer.exports ?? []) if (!Object.hasOwn(result, name)) fail(`missing export ${name}`);
    for (const name of Object.keys(result)) if (!producer.exports?.includes(name)) fail(`undeclared export ${name}`);
  }
  if (utf8ByteLength(JSON.stringify(result)) > outputArtifactLimits.exportBytesPerRun)
    fail(`export data exceeded ${outputArtifactLimits.exportBytesPerRun} bytes`);
  return result;
}
