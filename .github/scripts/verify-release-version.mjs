import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export async function verifyReleaseVersions({ repositoryRoot = process.cwd() } = {}) {
  const sources = await readSources(repositoryRoot);
  const publishedPackage = parseJson(sources.package, 'packages/oxiquill/package.json');
  const version = publishedPackage.version;
  if (typeof version !== 'string' || !stableVersion.test(version)) {
    throw new Error(`Oxiquill package version must be stable MAJOR.MINOR.PATCH; received ${String(version)}.`);
  }

  assertJsonVersion(sources.rootPackage, 'package.json', version);
  assertJsonVersion(sources.docsPackage, 'examples/docs-site/package.json', version);
  const starter = assertJsonVersion(sources.starterPackage, 'templates/basic/package.json', version);
  assertEqual(starter.dependencies?.oxiquill, `^${version}`, 'templates/basic/package.json oxiquill dependency');

  assertAllVersions(sources.readme, /"oxiquill": "(\d+\.\d+\.\d+)"/gu, version, 'README.md', 2);
  assertAllVersions(sources.readme, /\boxiquill@(\d+\.\d+\.\d+)\b/gu, version, 'README.md install commands', 4);
  assertAllVersions(sources.packageReadme, /\boxiquill@(\d+\.\d+\.\d+)\b/gu, version, 'package README');
  assertAllVersions(
    sources.gettingStarted,
    /\boxiquill@(\d+\.\d+\.\d+)\b/gu,
    version,
    'English getting-started guide',
    2
  );
  assertAllVersions(
    sources.gettingStartedJa,
    /\boxiquill@(\d+\.\d+\.\d+)\b/gu,
    version,
    'Japanese getting-started guide',
    2
  );

  assertCargoManifestVersion(sources.docRustManifest, 'doc-rust', version);
  assertCargoManifestVersion(sources.docRustTextManifest, 'doc-rust-text', version);
  assertCargoLockVersions(sources.helperLock, ['doc-rust', 'doc-rust-text'], version, 'helper Cargo.lock');
  assertCargoLockVersions(
    sources.runtimeLock,
    ['doc-rust', 'doc-rust-cells', 'doc-rust-text'],
    version,
    'generated runtime Cargo.lock'
  );

  const escapedVersion = escapeRegExp(version);
  assertMatch(
    sources.changelog,
    new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'mu'),
    'CHANGELOG release entry'
  );
  assertMatch(
    sources.changelog,
    new RegExp(
      `^\\[Unreleased\\]: https://github\\.com/kakune/oxiquill/compare/v${escapedVersion}\\.\\.\\.HEAD$`,
      'mu'
    ),
    'CHANGELOG Unreleased comparison'
  );
  assertMatch(
    sources.changelog,
    new RegExp(`^\\[${escapedVersion}\\]: https://github\\.com/kakune/oxiquill/releases/tag/v${escapedVersion}$`, 'mu'),
    'CHANGELOG release link'
  );

  const [major, minor] = version.split('.');
  assertMatch(
    sources.security,
    new RegExp(`^\\| ${escapeRegExp(`${major}.${minor}.x`)}\\s+\\| Yes\\s+\\|$`, 'mu'),
    'SECURITY supported version'
  );

  return { fileCount: Object.keys(sources).length, version };
}

async function readSources(repositoryRoot) {
  const files = {
    changelog: 'CHANGELOG.md',
    docRustManifest: 'examples/docs-site/crates/doc-rust/Cargo.toml',
    docRustTextManifest: 'examples/docs-site/crates/doc-rust-text/Cargo.toml',
    docsPackage: 'examples/docs-site/package.json',
    gettingStarted: 'examples/docs-site/content/docs/guides/getting-started.mdx',
    gettingStartedJa: 'examples/docs-site/content/docs/ja/guides/getting-started.mdx',
    helperLock: 'examples/docs-site/crates/Cargo.lock',
    package: 'packages/oxiquill/package.json',
    packageReadme: 'packages/oxiquill/README.md',
    readme: 'README.md',
    rootPackage: 'package.json',
    runtimeLock: 'packages/oxiquill/src/generator/license-data/rust/runtime-Cargo.lock',
    security: 'SECURITY.md',
    starterPackage: 'templates/basic/package.json'
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, file]) => [name, await readFile(path.join(repositoryRoot, file), 'utf8')])
    )
  );
}

function assertJsonVersion(source, label, expectedVersion) {
  const value = parseJson(source, label);
  assertEqual(value.version, expectedVersion, `${label} version`);
  return value;
}

function assertCargoManifestVersion(source, packageName, expectedVersion) {
  const packageSection = source.split(/\n(?=\[)/u).find((section) => section.startsWith('[package]\n'));
  const actualVersion = packageSection ? /^version = "([^"]+)"$/mu.exec(packageSection)?.[1] : undefined;
  assertEqual(actualVersion, expectedVersion, `${packageName} Cargo.toml version`);
}

function assertCargoLockVersions(source, packageNames, expectedVersion, label) {
  const packages = source
    .split('[[package]]')
    .slice(1)
    .map((block) => ({
      name: /^name = "([^"]+)"$/mu.exec(block)?.[1],
      version: /^version = "([^"]+)"$/mu.exec(block)?.[1]
    }));
  packageNames.forEach((packageName) => {
    const packageEntry = packages.find(({ name }) => name === packageName);
    assertEqual(packageEntry?.version, expectedVersion, `${label} ${packageName} version`);
  });
}

function assertAllVersions(source, pattern, expectedVersion, label, expectedMinimum = 1) {
  const versions = Array.from(source.matchAll(pattern), (match) => match[1]);
  if (versions.length < expectedMinimum) {
    throw new Error(`${label} is missing an Oxiquill ${expectedVersion} reference.`);
  }
  const staleVersions = versions.filter((version) => version !== expectedVersion);
  if (staleVersions.length > 0) {
    throw new Error(
      `${label} contains stale Oxiquill version ${staleVersions.join(', ')}; expected ${expectedVersion}.`
    );
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} is ${String(actual)}; expected ${expected}.`);
}

function assertMatch(source, pattern, label) {
  if (!pattern.test(source)) throw new Error(`${label} does not match the current Oxiquill version.`);
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} contains invalid JSON.`, { cause: error });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    const { fileCount, version } = await verifyReleaseVersions();
    console.log(`Verified Oxiquill ${version} across ${fileCount} release-bound files.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
