import path from 'node:path';
import { normalizePath } from './path-utils.mjs';

export function helperCratesFromManifests(manifests, { rustCrateDir }) {
  const helperCrates = manifests
    .map((manifest) => ({
      manifestDir: path.dirname(manifest.manifestPath),
      name: packageNameFromCargoToml(manifest.content, manifest.manifestPath)
    }))
    .map(({ manifestDir, name }) => [
      name,
      {
        name,
        relativePath: normalizePath(path.relative(rustCrateDir, manifestDir))
      }
    ])
    .sort(([left], [right]) => left.localeCompare(right));

  const duplicateName = findDuplicate(helperCrates.map(([name]) => name));
  if (duplicateName) {
    throw new Error(`Duplicate helper crate package name "${duplicateName}" under crates/.`);
  }

  return new Map(helperCrates);
}

export function packageNameFromCargoToml(content, manifestPath) {
  const packageTable = content.match(/(?:^|\n)\[package\]\s*(?:\n|$)([\s\S]*?)(?=\n\[|$)/u);
  const nameLine = packageTable?.[1].match(/(?:^|\n)\s*name\s*=\s*"([^"]+)"\s*(?:\n|$)/u);
  const name = nameLine?.[1]?.trim();
  if (!name) {
    throw new Error(`Helper crate manifest ${manifestPath} is missing [package] name.`);
  }

  return name;
}

function findDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }

  return undefined;
}
