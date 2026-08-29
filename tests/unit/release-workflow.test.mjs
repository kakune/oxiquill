// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoOpenReleaseBlockers,
  assertReleaseIdentity,
  assertTagOnMain,
  fetchOpenReleaseBlockers
} from '../../.github/scripts/verify-release.mjs';
import {
  assertPackManifest,
  assertPublishEnvironment,
  CHECKSUM_FILE,
  MANIFEST_FILE,
  verifyReleaseArchive
} from '../../.github/scripts/release-archive.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('release identity verification', () => {
  it('accepts an exact stable tag and matching package versions', () => {
    expect(() =>
      assertReleaseIdentity({
        packageVersion: '1.2.3',
        releasePrerelease: false,
        rootVersion: '1.2.3',
        tag: 'v1.2.3'
      })
    ).not.toThrow();
  });

  it.each([
    [{ packageVersion: '1.2.3', releasePrerelease: false, rootVersion: '1.2.3', tag: '1.2.3' }, 'must match'],
    [{ packageVersion: '1.2.3', releasePrerelease: true, rootVersion: '1.2.3', tag: 'v1.2.3' }, 'Prerelease'],
    [
      { packageVersion: '1.2.3', releasePrerelease: false, rootVersion: '1.2.4', tag: 'v1.2.3' },
      'root package version'
    ],
    [
      { packageVersion: '1.2.4', releasePrerelease: false, rootVersion: '1.2.3', tag: 'v1.2.3' },
      'oxiquill package version'
    ]
  ])('rejects an invalid release identity', (input, message) => {
    expect(() => assertReleaseIdentity(input)).toThrow(message);
  });

  it('rejects a substituted checkout and a tag outside main', () => {
    expect(() =>
      assertTagOnMain({ headCommit: 'a'.repeat(40), isAncestor: true, tag: 'v1.2.3', tagCommit: 'b'.repeat(40) })
    ).toThrow('does not match');
    expect(() =>
      assertTagOnMain({ headCommit: 'a'.repeat(40), isAncestor: false, tag: 'v1.2.3', tagCommit: 'a'.repeat(40) })
    ).toThrow('not contained in origin/main');
  });

  it('fails when the release milestone contains an open blocker', () => {
    expect(() => assertNoOpenReleaseBlockers([{ number: 59, title: 'Harden releases' }])).toThrow(
      '#59 Harden releases'
    );
    expect(() => assertNoOpenReleaseBlockers([])).not.toThrow();
  });

  it('loads milestone blockers and excludes pull requests', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ number: 7, title: 'npm release readiness' }]))
      .mockResolvedValueOnce(
        jsonResponse([
          { html_url: 'https://github.test/issues/59', number: 59, title: 'Blocker' },
          { number: 60, pull_request: {}, title: 'Pull request' }
        ])
      );

    await expect(
      fetchOpenReleaseBlockers({ fetchImplementation, repository: 'kakune/oxiquill', token: 'token' })
    ).resolves.toEqual([{ number: 59, title: 'Blocker', url: 'https://github.test/issues/59' }]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
  });

  it('fails closed when GitHub cannot verify release blockers', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable'
    });
    await expect(fetchOpenReleaseBlockers({ fetchImplementation, repository: 'kakune/oxiquill' })).rejects.toThrow(
      'GitHub API request failed with 503'
    );
  });
});

describe('release archive verification', () => {
  it('accepts the exact archive, complete manifest, checksum, and OIDC environment', async () => {
    const directory = await createArtifact();
    await expect(
      verifyReleaseArchive(directory, '1.2.3', {
        environment: oidcEnvironment(),
        outputFile: null,
        requireOidc: true
      })
    ).resolves.toMatchObject({ archivePath: path.join(directory, 'oxiquill-1.2.3.tgz') });
  });

  it('rejects a changed archive and unexpected artifact files', async () => {
    const changedArchive = await createArtifact();
    await writeFile(path.join(changedArchive, 'oxiquill-1.2.3.tgz'), 'changed');
    await expect(verifyReleaseArchive(changedArchive, '1.2.3', { outputFile: null })).rejects.toThrow(
      'SHA-256 mismatch'
    );

    const extraFile = await createArtifact();
    await writeFile(path.join(extraFile, 'substitute.tgz'), 'substitute');
    await expect(verifyReleaseArchive(extraFile, '1.2.3', { outputFile: null })).rejects.toThrow('unexpected files');
  });

  it('rejects incomplete, duplicate, and unsafe npm manifests', () => {
    const pack = packManifest(Buffer.from('archive'));
    expect(() => assertPackManifest({ ...pack, entryCount: 0 }, { name: 'oxiquill', version: '1.2.3' })).toThrow(
      'every archive entry'
    );
    expect(() => assertPackManifest({ ...pack, files: [...pack.files, pack.files[0]], entryCount: 2 }, pack)).toThrow(
      'duplicate path'
    );
    expect(() =>
      assertPackManifest(
        { ...pack, files: [{ ...pack.files[0], path: '../package.json' }] },
        { name: 'oxiquill', version: '1.2.3' }
      )
    ).toThrow('invalid file entry');
  });

  it('requires OIDC and forbids long-lived npm credentials', () => {
    expect(() => assertPublishEnvironment({})).toThrow('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(() => assertPublishEnvironment({ ...oidcEnvironment(), NODE_AUTH_TOKEN: 'secret' })).toThrow(
      'NODE_AUTH_TOKEN'
    );
    expect(() => assertPublishEnvironment(oidcEnvironment())).not.toThrow();
  });
});

describe('workflow supply-chain policy', () => {
  it('pins every remote action to a full commit SHA with a version comment', async () => {
    const workflowDirectory = path.join(repositoryRoot, '.github/workflows');
    const workflowNames = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/u.test(name));

    for (const workflowName of workflowNames) {
      const source = await readFile(path.join(workflowDirectory, workflowName), 'utf8');
      const usesLines = source.split('\n').filter((line) => /^\s*uses:/u.test(line));
      expect(usesLines.length).toBeGreaterThan(0);
      for (const line of usesLines) {
        expect(line).toMatch(/^\s*uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\s+#\s+v\d/u);
      }
    }
  });

  it('keeps release OIDC and staged publishing isolated to the protected publish job', async () => {
    const source = await readFile(path.join(repositoryRoot, '.github/workflows/npm-publish.yml'), 'utf8');
    const [verifySource, publishSource] = source.split('\n  publish:\n');

    expect(verifySource).not.toContain('id-token: write');
    expect(publishSource).toContain('id-token: write');
    expect(source.match(/id-token: write/gu)).toHaveLength(1);
    expect(publishSource).toContain('name: npm-publish');
    expect(publishSource).toContain("needs.verify.outputs.release_version != '0.3.0'");
    expect(publishSource).toContain('npm stage publish');
    expect(source).not.toMatch(/\bNPM_TOKEN\b|\bNODE_AUTH_TOKEN\b/u);
    expect(source).not.toMatch(/run:\s+npm publish/u);
  });

  it('never pipes mutable remote installer content into an interpreter', async () => {
    const workflowDirectory = path.join(repositoryRoot, '.github/workflows');
    const sources = await Promise.all(
      (await readdir(workflowDirectory))
        .filter((name) => /\.ya?ml$/u.test(name))
        .map((name) => readFile(path.join(workflowDirectory, name), 'utf8'))
    );
    const installer = await readFile(path.join(repositoryRoot, '.github/scripts/install-ghc-wasm.sh'), 'utf8');

    expect(sources.join('\n')).not.toContain('/master/bootstrap.sh');
    expect(sources.join('\n')).not.toMatch(/curl[^\n]*\|/u);
    expect(installer).toContain('GHC_WASM_ARCHIVE_SHA256');
    expect(installer).toContain('ghc-wasm archive SHA-256 mismatch');
    expect(installer).toContain('--output "$archive"');
  });
});

async function createArtifact() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-release-'));
  temporaryDirectories.push(directory);
  const archive = Buffer.from('verified archive');
  const pack = packManifest(archive);
  const archiveSha256 = digest('sha256', archive, 'hex');

  await writeFile(path.join(directory, pack.filename), archive);
  await writeFile(
    path.join(directory, MANIFEST_FILE),
    `${JSON.stringify({ archiveSha256, pack, schemaVersion: 1 }, null, 2)}\n`
  );
  await writeFile(path.join(directory, CHECKSUM_FILE), `${archiveSha256}  ${pack.filename}\n`);
  return directory;
}

function packManifest(archive) {
  return {
    entryCount: 1,
    filename: 'oxiquill-1.2.3.tgz',
    files: [{ mode: 0o644, path: 'package.json', size: 2 }],
    integrity: `sha512-${digest('sha512', archive, 'base64')}`,
    name: 'oxiquill',
    shasum: digest('sha1', archive, 'hex'),
    version: '1.2.3'
  };
}

function digest(algorithm, value, encoding) {
  return createHash(algorithm).update(value).digest(encoding);
}

function jsonResponse(value) {
  return {
    json: async () => value,
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value)
  };
}

function oidcEnvironment() {
  return {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://github.test/oidc'
  };
}
