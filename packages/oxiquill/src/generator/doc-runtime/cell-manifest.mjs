// Legacy arrays remain readable until the next successful generation replaces
// them. Production guards require the new generation metadata.
export function parseGeneratedCellManifest(source) {
  const manifest = JSON.parse(source);
  return Array.isArray(manifest) ? { cells: manifest } : manifest;
}
