import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { defaultFileSystem } from './file-system.mjs';

const bundledManifestUrl = new URL('../license-data/runtime-artifacts.json', import.meta.url);

export function pythonLicensePaths(pythonOptions = {}, paths) {
  return [
    ...new Set(Object.values(pythonOptions.additionalPackages ?? {}).flatMap((notice) => notice.licenseFiles))
  ].map((file) => licensePath(file, paths));
}

function licensePath(file, paths) {
  const root = pathFromUrl(paths.workspaceRoot);
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (path.isAbsolute(file) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Python license file must be relative to the workspace: ${file}.`);
  }
  return resolved;
}

/** Validates every configured release, and requires a notice for every copied dependency. */
export async function resolvePythonPackageNotices({
  packages,
  lockFile,
  pythonOptions = {},
  paths,
  fileSystem = defaultFileSystem,
  bundledManifest
}) {
  const additional = pythonOptions.additionalPackages ?? {};
  for (const [name, notice] of Object.entries(additional)) {
    const info = Object.hasOwn(lockFile.packages, name) ? lockFile.packages[name] : undefined;
    if (!info) throw new Error(`Configured Pyodide package "${name}" is missing from the lock file.`);
    if (info.version !== notice.version)
      throw new Error(
        `Pyodide package "${name}" notice version ${notice.version} does not match lock version ${info.version}.`
      );
  }
  const manifest = bundledManifest ?? JSON.parse(await readFile(bundledManifestUrl, 'utf8'));
  const notices = await Promise.all(
    packages.map(async (info) => {
      const builtin = manifest.artifacts.find((artifact) => artifact.files.includes(`pyodide/${info.file_name}`));
      if (builtin && builtin.version === info.version) return undefined;
      const notice = additional[info.name];
      if (!notice)
        throw new Error(
          `Pyodide dependency "${info.name}" ${info.version} is missing a license notice in python.additionalPackages.`
        );
      const texts = await Promise.all(
        notice.licenseFiles.map(async (file) => {
          let text;
          try {
            text = String(await fileSystem.readFile(licensePath(file, paths), 'utf8')).trim();
          } catch (error) {
            throw new Error(`Unable to read Python license notice for "${info.name}": ${file}.`, { cause: error });
          }
          if (!text) throw new Error(`Python license notice for "${info.name}" is empty: ${file}.`);
          return `[${file}]\n${text}`;
        })
      );
      return {
        name: info.name,
        version: info.version,
        license: notice.license,
        licenseText: texts.join('\n\n'),
        sources: ['copied Pyodide package']
      };
    })
  );
  return notices.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
