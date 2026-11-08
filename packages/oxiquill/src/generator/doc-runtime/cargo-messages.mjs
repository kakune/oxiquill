import path from 'node:path';

// Non-JSON lines (proc-macro or build-script noise) are ignored.
export function parseCargoMessage(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && typeof value.reason === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function cdylibWasm(message) {
  const kinds = [...(message.target?.kind ?? []), ...(message.target?.crate_types ?? [])];
  return kinds.includes('cdylib') ? message.filenames?.find((file) => String(file).endsWith('.wasm')) : undefined;
}

// Messages belong to a generated module by crate name or by `modules/<id>/Cargo.toml`.
// Neither depends on the package-id format, which differs between Cargo versions,
// nor on how the host spells absolute paths.
export function messageGroup(message, { byCrate, byId }) {
  const crate = byCrate.get(message.target?.name);
  if (crate) return crate;
  const manifest = String(message.manifest_path ?? '').replaceAll('\\', '/');
  const directory = path.posix.dirname(manifest);
  return path.posix.basename(path.posix.dirname(directory)) === 'modules'
    ? byId.get(path.posix.basename(directory))
    : undefined;
}

export function isErrorMessage(message) {
  return message.reason === 'compiler-message' && /^error\b/u.test(message.message?.level ?? '');
}

export function isBuildScriptMessage(message) {
  return (message.target?.kind ?? []).includes('custom-build');
}
