import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  compareVersions,
  parseVersion
} from '../../packages/oxiquill/src/generator/doc-runtime/toolchain-versions.mjs';

const { rust } = JSON.parse(
  readFileSync(
    new URL('../../packages/oxiquill/src/generator/runtime-data/runtime-inputs.json', import.meta.url),
    'utf8'
  )
);

export function latestCompatibleWasmPack(releases) {
  const minimum = parseVersion(rust.wasmPackMinimumVersion);
  const maximum = parseVersion(rust.wasmPackMaximumVersionExclusive);
  const versions = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => parseVersion(release.tag_name?.replace(/^v/u, '')))
    .filter((version) => version && compareVersions(version, minimum) >= 0 && compareVersions(version, maximum) < 0)
    .sort(compareVersions);
  const latest = versions.at(-1);
  if (!latest) throw new Error('No stable wasm-pack release satisfies the supported runtime range.');
  return latest.join('.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const version = latestCompatibleWasmPack(JSON.parse(readFileSync(0, 'utf8')).flat());
  console.log(`Selected wasm-pack ${version}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
