import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CHECKSUM_FILE = 'SHA256SUMS';
export const MANIFEST_FILE = 'release-manifest.json';

const packageRoot = fileURLToPath(new URL('../../packages/oxiquill', import.meta.url));

export async function createReleaseArchive(destination, { outputFile = process.env.GITHUB_OUTPUT } = {}) {
  await mkdir(destination, { recursive: true });
  const existing = await readdir(destination);
  if (existing.length > 0) {
    throw new Error(`Release artifact directory must be empty: ${destination}`);
  }

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const result = spawnSync('npm', ['pack', '--json', '--silent', '--pack-destination', destination], {
    cwd: packageRoot,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm pack failed.');
  }

  const records = JSON.parse(result.stdout);
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error('npm pack must produce exactly one archive record.');
  }

  const [pack] = records;
  assertPackManifest(pack, { name: packageJson.name, version: packageJson.version });
  const archivePath = path.join(destination, pack.filename);
  const archive = await readFile(archivePath);
  const archiveSha256 = digest('sha256', archive, 'hex');
  assertArchiveDigests(pack, archive);

  const manifest = {
    archiveSha256,
    commit: gitOutput(['rev-parse', 'HEAD'], packageRoot),
    name: pack.name,
    pack,
    schemaVersion: 2,
    version: pack.version
  };
  await writeFile(path.join(destination, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(destination, CHECKSUM_FILE), `${archiveSha256}  ${pack.filename}\n`);
  await assertArtifactFileSet(destination, pack.filename);

  if (outputFile) {
    await appendFile(
      outputFile,
      `archive_filename=${pack.filename}\nrelease_version=${pack.version}\nartifact_name=oxiquill-${pack.version}\n`
    );
  }

  return { archivePath, manifest };
}

export async function verifyReleaseArchive(
  destination,
  expectedVersion,
  { environment = process.env, expectedCommit, outputFile = process.env.GITHUB_OUTPUT, requireOidc = false } = {}
) {
  if (requireOidc) assertPublishEnvironment(environment);

  const manifest = JSON.parse(await readFile(path.join(destination, MANIFEST_FILE), 'utf8'));
  assertReleaseManifest(manifest, { commit: expectedCommit, name: 'oxiquill', version: expectedVersion });
  assertPackManifest(manifest.pack, { name: 'oxiquill', version: expectedVersion });
  await assertArtifactFileSet(destination, manifest.pack.filename);

  const checksum = await readFile(path.join(destination, CHECKSUM_FILE), 'utf8');
  const expectedChecksum = `${manifest.archiveSha256}  ${manifest.pack.filename}\n`;
  if (checksum !== expectedChecksum) {
    throw new Error('SHA256SUMS does not match the release manifest.');
  }

  const archivePath = path.join(destination, manifest.pack.filename);
  const archive = await readFile(archivePath);
  const actualSha256 = digest('sha256', archive, 'hex');
  if (actualSha256 !== manifest.archiveSha256) {
    throw new Error('Release archive SHA-256 mismatch.');
  }
  assertArchiveDigests(manifest.pack, archive);

  if (outputFile) await appendFile(outputFile, `archive_path=${archivePath}\n`);
  return { archivePath, manifest };
}

export function assertReleaseManifest(manifest, expected) {
  if (
    manifest?.schemaVersion !== 2 ||
    typeof manifest.archiveSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256) ||
    typeof manifest.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(manifest.commit)
  ) {
    throw new Error('Release manifest has an unsupported schema or invalid identity fields.');
  }
  if (!expected.commit || manifest.commit !== expected.commit) {
    throw new Error(`Release manifest commit ${manifest.commit} does not match ${String(expected.commit)}.`);
  }
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    throw new Error(`Release manifest identity mismatch: expected ${expected.name}@${expected.version}.`);
  }
  if (manifest.pack?.name !== manifest.name || manifest.pack?.version !== manifest.version) {
    throw new Error('Release manifest package identity does not match its npm pack metadata.');
  }
}

export function assertPublishEnvironment(environment) {
  for (const name of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    if (!environment[name]) throw new Error(`OIDC environment is incomplete: ${name} is missing.`);
  }
  for (const name of ['NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    if (environment[name]) throw new Error(`Long-lived npm credential is forbidden: ${name}.`);
  }
}

export function assertPackManifest(pack, expected) {
  if (!pack || typeof pack !== 'object') throw new Error('npm pack manifest is missing.');
  if (pack.name !== expected.name || pack.version !== expected.version) {
    throw new Error(`npm pack identity mismatch: expected ${expected.name}@${expected.version}.`);
  }
  const expectedFilename = `${expected.name}-${expected.version}.tgz`;
  if (pack.filename !== expectedFilename) {
    throw new Error(`Unexpected release archive filename: ${pack.filename}.`);
  }
  if (!Array.isArray(pack.files) || pack.files.length === 0 || pack.entryCount !== pack.files.length) {
    throw new Error('npm pack manifest must contain every archive entry.');
  }

  const paths = new Set();
  for (const file of pack.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      path.posix.isAbsolute(file.path) ||
      path.posix.normalize(file.path) !== file.path ||
      file.path.startsWith('../') ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      !Number.isInteger(file.mode)
    ) {
      throw new Error('npm pack manifest contains an invalid file entry.');
    }
    if (paths.has(file.path)) throw new Error(`npm pack manifest contains duplicate path ${file.path}.`);
    paths.add(file.path);
  }
}

function assertArchiveDigests(pack, archive) {
  const integrity = `sha512-${digest('sha512', archive, 'base64')}`;
  if (pack.integrity !== integrity) throw new Error('Release archive npm integrity mismatch.');
  if (pack.shasum !== digest('sha1', archive, 'hex')) {
    throw new Error('Release archive npm shasum mismatch.');
  }
}

async function assertArtifactFileSet(destination, archiveFilename) {
  const actual = (await readdir(destination)).sort();
  const expected = [CHECKSUM_FILE, MANIFEST_FILE, archiveFilename].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Release artifact contains unexpected files: ${actual.join(', ')}.`);
  }
}

function digest(algorithm, value, encoding) {
  return createHash(algorithm).update(value).digest(encoding);
}

function gitOutput(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const [command, destination, expectedVersion, ...flags] = process.argv.slice(2);
  if (command === 'create' && destination && !expectedVersion) {
    const { archivePath } = await createReleaseArchive(destination);
    console.log(`Created ${archivePath}.`);
    return;
  }
  if (command === 'verify' && destination && expectedVersion) {
    const requireOidc = flags.includes('--require-oidc');
    const expectedCommit = gitOutput(['rev-parse', 'HEAD'], packageRoot);
    const { archivePath } = await verifyReleaseArchive(destination, expectedVersion, { expectedCommit, requireOidc });
    console.log(`Verified ${archivePath}.`);
    return;
  }
  throw new Error('Usage: release-archive.mjs create <directory> | verify <directory> <version> [--require-oidc]');
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
