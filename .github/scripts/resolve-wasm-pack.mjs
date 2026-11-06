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

export function resolveWasmPackDownload(releases) {
  const version = latestCompatibleWasmPack(releases);
  const release = releases.find(
    (entry) => !entry.draft && !entry.prerelease && entry.tag_name?.replace(/^v/u, '') === version
  );
  const asset = `wasm-pack-v${version}-x86_64-unknown-linux-musl.tar.gz`;
  const digest = release.assets?.find((entry) => entry.name === asset)?.digest;
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? '')) {
    throw new Error(`wasm-pack ${version} is missing a SHA-256 digest for ${asset}.`);
  }
  return Object.freeze({ version, tag: release.tag_name, asset, digest });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const download = resolveWasmPackDownload(JSON.parse(readFileSync(0, 'utf8')).flat());
  console.log(`Selected wasm-pack ${download.version} (${download.digest})`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(download)
      .map(([name, value]) => `${name}=${value}\n`)
      .join('')
  );
}
