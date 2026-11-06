import { createHash } from 'node:crypto';

export function buildFingerprint({ compilerVersion, configs }) {
  return createHash('sha256')
    .update(JSON.stringify([1, compilerVersion, Object.entries(configs).sort(([a], [b]) => a.localeCompare(b))]))
    .digest('hex');
}

export function needsColdBuild({ manifest, fingerprint, outputFiles }) {
  return (
    manifest?.schemaVersion !== 1 ||
    manifest.fingerprint !== fingerprint ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    !manifest.files.every((file) => typeof file === 'string' && outputFiles.includes(file))
  );
}

export function createOutputPlan({ compiledFiles, assets, outputFiles }) {
  const files = [...new Set([...compiledFiles, ...assets.map(({ target }) => target)])].sort();
  const expected = new Set(files);
  return { files, remove: outputFiles.filter((file) => !expected.has(file)) };
}
