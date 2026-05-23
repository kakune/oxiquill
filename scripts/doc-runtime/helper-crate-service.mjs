import path from 'node:path';
import { helperCratesFromManifests } from './helper-crates.mjs';
import { defaultFileSystem } from './file-system.mjs';

export async function listHelperCrates({
  fileSystem = defaultFileSystem,
  paths,
  readManifests = readHelperManifests,
  root
}) {
  return helperCratesFromManifests(await readManifests({ fileSystem, root }), {
    rustCrateDir: paths.rustCrateDir
  });
}

export async function readHelperManifests({ fileSystem = defaultFileSystem, root }) {
  const cratesDir = path.join(root, 'crates');
  let entries;
  try {
    entries = await fileSystem.readdir(cratesDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = path.join(cratesDir, entry.name, 'Cargo.toml');
        try {
          return {
            content: await fileSystem.readFile(manifestPath, 'utf8'),
            manifestPath
          };
        } catch (error) {
          if (error && error.code === 'ENOENT') return undefined;
          throw error;
        }
      })
  );

  return manifests.filter(Boolean).sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}
