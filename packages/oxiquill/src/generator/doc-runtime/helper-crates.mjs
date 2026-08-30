import path from 'node:path';
import { parse } from 'smol-toml';
import { normalizePath } from './path-utils.mjs';

export function helperCratesFromManifests(manifests, { rustCellsDir }) {
  const helperCrates = manifests
    .map((manifest) => ({
      manifestDir: path.dirname(manifest.manifestPath),
      manifestPath: manifest.manifestPath,
      name: packageNameFromCargoToml(manifest.content, manifest.manifestPath)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const duplicate = findDuplicate(helperCrates);
  if (duplicate) {
    throw new Error(
      `Helper crate manifests ${duplicate.first.manifestPath} and ${duplicate.second.manifestPath} use duplicate package name "${duplicate.first.name}".`
    );
  }

  return new Map(
    helperCrates.map(({ manifestDir, name }) => [
      name,
      {
        name,
        relativePath: normalizePath(path.relative(rustCellsDir, manifestDir))
      }
    ])
  );
}

export function packageNameFromCargoToml(content, manifestPath) {
  let manifest;
  try {
    manifest = parse(content);
  } catch (error) {
    throw new Error(`Helper crate manifest ${manifestPath} contains malformed TOML: ${errorMessage(error)}`, {
      cause: error
    });
  }

  if (!isTable(manifest.package)) {
    throw new Error(`Helper crate manifest ${manifestPath} is missing a [package] table.`);
  }
  if (!Object.hasOwn(manifest.package, 'name')) {
    throw new Error(`Helper crate manifest ${manifestPath} is missing package.name.`);
  }

  const name = manifest.package.name;
  if (typeof name !== 'string') {
    throw new Error(`Helper crate manifest ${manifestPath} has a non-string package.name.`);
  }
  if (!isValidCargoPackageName(name)) {
    throw new Error(`Helper crate manifest ${manifestPath} has invalid package.name ${JSON.stringify(name)}.`);
  }

  return name;
}

function findDuplicate(values) {
  const seen = new Map();
  for (const value of values) {
    const first = seen.get(value.name);
    if (first) return { first, second: value };
    seen.set(value.name, value);
  }

  return undefined;
}

function isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidCargoPackageName(name) {
  return name.length > 0 && Array.from(name).every((character) => /^[\p{Alphabetic}\p{Number}_-]$/u.test(character));
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
