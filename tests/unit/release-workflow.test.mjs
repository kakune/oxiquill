// @vitest-environment node

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoOpenDependabotAlerts,
  assertNoOpenReleaseBlockers,
  assertReleaseIdentity,
  assertTagOnMain,
  fetchOpenDependabotAlerts,
  fetchOpenReleaseBlockers
} from '../../.github/scripts/verify-release.mjs';
import {
  assertPackManifest,
  assertPublishEnvironment,
  assertReleaseManifest,
  CHECKSUM_FILE,
  MANIFEST_FILE,
  verifyReleaseArchive
} from '../../.github/scripts/release-archive.mjs';
import { uploadReleaseAssets } from '../../.github/scripts/release-assets.mjs';
import { verifyReleaseVersions } from '../../.github/scripts/verify-release-version.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseCommit = 'a'.repeat(40);
const workflowCommit = 'c'.repeat(40);
const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('release-bound version verification', () => {
  it('accepts every current v0.3.0 release reference', async () => {
    await expect(verifyReleaseVersions({ repositoryRoot })).resolves.toMatchObject({ version: '0.3.0' });
  });

  it.each([
    [
      'templates/basic/package.json',
      '"oxiquill": "^0.3.0"',
      '"oxiquill": "^0.2.0"',
      'templates/basic/package.json oxiquill dependency'
    ],
    ['README.md', '"oxiquill": "0.3.0"', '"oxiquill": "0.2.0"', 'README.md contains stale'],
    [
      'packages/oxiquill/README.md',
      'npm install oxiquill@0.3.0',
      'npm install oxiquill@0.2.0',
      'package README contains stale'
    ],
    [
      'examples/docs-site/content/docs/guides/getting-started.mdx',
      'pnpm add oxiquill@0.3.0',
      'pnpm add oxiquill@0.2.0',
      'English getting-started guide contains stale'
    ],
    [
      'examples/docs-site/content/docs/ja/guides/getting-started.mdx',
      'pnpm add oxiquill@0.3.0',
      'pnpm add oxiquill@0.2.0',
      'Japanese getting-started guide contains stale'
    ],
    [
      'examples/docs-site/crates/doc-rust/Cargo.toml',
      'version = "0.3.0"',
      'version = "0.2.0"',
      'doc-rust Cargo.toml version'
    ],
    [
      'examples/docs-site/crates/Cargo.lock',
      'name = "doc-rust"\nversion = "0.3.0"',
      'name = "doc-rust"\nversion = "0.2.0"',
      'helper Cargo.lock doc-rust version'
    ],
    [
      'packages/oxiquill/src/generator/license-data/rust/runtime-Cargo.lock',
      'name = "doc-rust-cells"\nversion = "0.3.0"',
      'name = "doc-rust-cells"\nversion = "0.2.0"',
      'generated runtime Cargo.lock doc-rust-cells version'
    ]
  ])('rejects stale release metadata in %s', async (relativePath, current, stale, message) => {
    const fixtureRoot = await createReleaseVersionFixture();
    const filePath = path.join(fixtureRoot, relativePath);
    const source = await readFile(filePath, 'utf8');
    const modified = source.replace(current, stale);
    expect(modified).not.toBe(source);
    await writeFile(filePath, modified);

    await expect(verifyReleaseVersions({ repositoryRoot: fixtureRoot })).rejects.toThrow(message);
  });
});

describe('release identity verification', () => {
  it('grants read-only Dependabot access and pins the control plane to the workflow commit', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/npm-publish.yml'), 'utf8');

    expect(workflow).toContain('vulnerability-alerts: read # Required to enforce the Dependabot alert gate.');
    expect(workflow).not.toContain('security-events:');
    expect(workflow.match(/ref: \$\{\{ github\.workflow_sha \}\}/gu)).toHaveLength(3);
    expect(workflow.match(/path: \.release-control/gu)).toHaveLength(3);
    expect(workflow).toContain('node .release-control/.github/scripts/verify-release.mjs');
    expect(workflow).toContain('Workflow commit $GITHUB_WORKFLOW_SHA is not contained in origin/main');
  });

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

  it('fails when an open Dependabot alert remains', () => {
    expect(() =>
      assertNoOpenDependabotAlerts([{ dependency: 'undici', number: 7, summary: 'TLS validation bypass' }])
    ).toThrow('#7 undici: TLS validation bypass');
    expect(() => assertNoOpenDependabotAlerts([])).not.toThrow();
  });

  it('loads open Dependabot alerts with actionable advisory details', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          dependency: { package: { name: 'undici' } },
          html_url: 'https://github.test/alerts/7',
          number: 7,
          security_advisory: { ghsa_id: 'GHSA-test', summary: 'TLS validation bypass' }
        }
      ])
    );

    await expect(
      fetchOpenDependabotAlerts({ fetchImplementation, repository: 'kakune/oxiquill', token: 'token' })
    ).resolves.toEqual([
      {
        dependency: 'undici',
        number: 7,
        summary: 'TLS validation bypass',
        url: 'https://github.test/alerts/7'
      }
    ]);
    expect(fetchImplementation.mock.calls[0][0]).toContain('/dependabot/alerts?state=open');
    expect(new URL(fetchImplementation.mock.calls[0][0]).searchParams.has('page')).toBe(false);
    expect(fetchImplementation.mock.calls[0][1].headers['X-GitHub-Api-Version']).toBe('2026-03-10');
  });

  it('follows cursor pagination from the GitHub Link header', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => dependabotAlert(index + 1));
    const nextUrl =
      'https://api.github.com/repos/kakune/oxiquill/dependabot/alerts?state=open&per_page=100&after=cursor';
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage, { link: `<${nextUrl}>; rel="next"` }))
      .mockResolvedValueOnce(jsonResponse([dependabotAlert(101)]));

    const alerts = await fetchOpenDependabotAlerts({
      fetchImplementation,
      repository: 'kakune/oxiquill',
      token: 'token'
    });

    expect(alerts).toHaveLength(101);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[1][0]).toBe(nextUrl);
  });

  it('rejects untrusted and cyclic pagination links', async () => {
    const untrustedFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse([], { link: '<https://example.test/alerts?after=cursor>; rel="next"' }));
    await expect(
      fetchOpenDependabotAlerts({ fetchImplementation: untrustedFetch, repository: 'kakune/oxiquill' })
    ).rejects.toThrow('untrusted URL');

    const initialUrl = 'https://api.github.com/repos/kakune/oxiquill/dependabot/alerts?state=open&per_page=100';
    const cyclicFetch = vi.fn().mockResolvedValue(jsonResponse([], { link: `<${initialUrl}>; rel="next"` }));
    await expect(
      fetchOpenDependabotAlerts({ fetchImplementation: cyclicFetch, repository: 'kakune/oxiquill' })
    ).rejects.toThrow('contains a cycle');
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

  it('fails closed when GitHub cannot verify Dependabot alerts', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'forbidden'
    });
    await expect(fetchOpenDependabotAlerts({ fetchImplementation, repository: 'kakune/oxiquill' })).rejects.toThrow(
      'GitHub API request failed with 403'
    );
  });
});

describe('release archive verification', () => {
  it('accepts the exact archive, complete manifest, checksum, and OIDC environment', async () => {
    const directory = await createArtifact();
    await expect(
      verifyReleaseArchive(directory, '1.2.3', {
        environment: oidcEnvironment(),
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: workflowCommit,
        outputFile: null,
        requireOidc: true
      })
    ).resolves.toMatchObject({ archivePath: path.join(directory, 'oxiquill-1.2.3.tgz') });
  });

  it('rejects a changed archive and unexpected artifact files', async () => {
    const changedArchive = await createArtifact();
    await writeFile(path.join(changedArchive, 'oxiquill-1.2.3.tgz'), 'changed');
    await expect(
      verifyReleaseArchive(changedArchive, '1.2.3', {
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: workflowCommit,
        outputFile: null
      })
    ).rejects.toThrow('SHA-256 mismatch');

    const extraFile = await createArtifact();
    await writeFile(path.join(extraFile, 'substitute.tgz'), 'substitute');
    await expect(
      verifyReleaseArchive(extraFile, '1.2.3', {
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: workflowCommit,
        outputFile: null
      })
    ).rejects.toThrow('unexpected files');
  });

  it('rejects a manifest from a different commit', async () => {
    const directory = await createArtifact();
    await expect(
      verifyReleaseArchive(directory, '1.2.3', {
        expectedCommit: 'b'.repeat(40),
        expectedWorkflowCommit: workflowCommit,
        outputFile: null
      })
    ).rejects.toThrow('does not match');

    await expect(
      verifyReleaseArchive(directory, '1.2.3', {
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: 'b'.repeat(40),
        outputFile: null
      })
    ).rejects.toThrow('workflow commit');
  });

  it('requires complete release manifest identity fields', () => {
    const pack = packManifest(Buffer.from('archive'));
    expect(() =>
      assertReleaseManifest(
        {
          archiveSha256: '0'.repeat(64),
          commit: releaseCommit,
          name: 'oxiquill',
          pack,
          schemaVersion: 3,
          workflowCommit
        },
        { commit: releaseCommit, name: 'oxiquill', version: '1.2.3', workflowCommit }
      )
    ).toThrow('identity mismatch');
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

describe('GitHub Release asset upload', () => {
  it('uploads each missing verified file without overwrite behavior', async () => {
    const directory = await createArtifact();
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42, tag_name: 'v1.2.3' }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(jsonResponse({ id: 100 }));

    await expect(
      uploadReleaseAssets({
        directory,
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: workflowCommit,
        expectedVersion: '1.2.3',
        fetchImplementation,
        repository: 'kakune/oxiquill',
        tag: 'v1.2.3',
        token: 'token'
      })
    ).resolves.toEqual([
      { filename: CHECKSUM_FILE, status: 'uploaded' },
      { filename: 'oxiquill-1.2.3.tgz', status: 'uploaded' },
      { filename: MANIFEST_FILE, status: 'uploaded' }
    ]);
    const uploads = fetchImplementation.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(uploads).toHaveLength(3);
    uploads.forEach(([, options]) => expect(options.headers).not.toHaveProperty('If-Match'));
  });

  it('accepts an idempotent rerun when every existing asset has identical bytes', async () => {
    const directory = await createArtifact();
    const filenames = (await readdir(directory)).sort();
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42, tag_name: 'v1.2.3' }))
      .mockResolvedValueOnce(
        jsonResponse(filenames.map((name, index) => ({ name, url: `https://api.github.test/assets/${index}` })))
      );
    for (const filename of filenames) {
      fetchImplementation.mockResolvedValueOnce(bytesResponse(await readFile(path.join(directory, filename))));
    }

    await expect(
      uploadReleaseAssets({
        directory,
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: workflowCommit,
        expectedVersion: '1.2.3',
        fetchImplementation,
        repository: 'kakune/oxiquill',
        tag: 'v1.2.3',
        token: 'token'
      })
    ).resolves.toEqual(filenames.map((filename) => ({ filename, status: 'unchanged' })));
    expect(fetchImplementation.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('fails instead of replacing an existing asset with different bytes', async () => {
    const directory = await createArtifact();
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42, tag_name: 'v1.2.3' }))
      .mockResolvedValueOnce(jsonResponse([{ name: CHECKSUM_FILE, url: 'https://api.github.test/assets/1' }]))
      .mockResolvedValueOnce(bytesResponse(Buffer.from('conflicting bytes')));

    await expect(
      uploadReleaseAssets({
        directory,
        expectedCommit: releaseCommit,
        expectedWorkflowCommit: workflowCommit,
        expectedVersion: '1.2.3',
        fetchImplementation,
        repository: 'kakune/oxiquill',
        tag: 'v1.2.3',
        token: 'token'
      })
    ).rejects.toThrow('conflicts with the verified artifact');
  });
});

describe('workflow supply-chain policy', () => {
  it('selects packed consumer scripts without shell-specific expansion', async () => {
    const source = await readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));

    expect(source).toContain("if: matrix.package-manager == 'npm'");
    expect(source).toContain('run: pnpm test:consumer:npm');
    expect(source).toContain("if: matrix.package-manager == 'pnpm'");
    expect(source).toContain('run: pnpm test:consumer:pnpm -- --browser');
    expect(source).toContain('run: pnpm test:packed-browser');
    expect(source).toContain('run: pnpm exec playwright install --with-deps chromium');
    expect(source).not.toContain('${PACKAGE_MANAGER}');
    expect(source).not.toContain('test:consumer:${{ matrix.package-manager }}');
    expect(packageJson.scripts['test:packed-browser']).toBe(
      'node tests/package/consumer-smoke.mjs --package-manager pnpm --browser'
    );
  });

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

  it('keeps release OIDC and direct publishing isolated to the protected publish job', async () => {
    const source = await readFile(path.join(repositoryRoot, '.github/workflows/npm-publish.yml'), 'utf8');
    const [verifySource, releaseAndPublishSource] = source.split('\n  release-assets:\n');
    const [releaseAssetsSource, publishSource] = releaseAndPublishSource.split('\n  publish:\n');

    expect(verifySource).not.toContain('id-token: write');
    expect(verifySource).not.toContain('contents: write');
    expect(releaseAssetsSource).toContain('contents: write');
    expect(releaseAssetsSource).not.toContain('id-token: write');
    expect(publishSource).toContain('id-token: write');
    expect(source.match(/id-token: write/gu)).toHaveLength(1);
    expect(source.match(/contents: write/gu)).toHaveLength(1);
    expect(publishSource).toContain('name: npm-publish');
    expect(publishSource).toContain("needs.verify.outputs.release_version != '0.3.0'");
    expect(publishSource).toContain('npm publish "$RELEASE_ARCHIVE" --access public');
    expect(publishSource).not.toContain('npm stage publish');
    expect(source).not.toMatch(/\bNPM_TOKEN\b|\bNODE_AUTH_TOKEN\b/u);
    expect(source.match(/npm publish "\$RELEASE_ARCHIVE"/gu)).toHaveLength(1);
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
    `${JSON.stringify(
      {
        archiveSha256,
        commit: releaseCommit,
        name: pack.name,
        pack,
        schemaVersion: 3,
        version: pack.version,
        workflowCommit
      },
      null,
      2
    )}\n`
  );
  await writeFile(path.join(directory, CHECKSUM_FILE), `${archiveSha256}  ${pack.filename}\n`);
  return directory;
}

async function createReleaseVersionFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-release-version-'));
  temporaryDirectories.push(directory);
  const files = [
    'CHANGELOG.md',
    'README.md',
    'SECURITY.md',
    'examples/docs-site/content/docs/guides/getting-started.mdx',
    'examples/docs-site/content/docs/ja/guides/getting-started.mdx',
    'examples/docs-site/crates/Cargo.lock',
    'examples/docs-site/crates/doc-rust-text/Cargo.toml',
    'examples/docs-site/crates/doc-rust/Cargo.toml',
    'examples/docs-site/package.json',
    'package.json',
    'packages/oxiquill/README.md',
    'packages/oxiquill/package.json',
    'packages/oxiquill/src/generator/license-data/rust/runtime-Cargo.lock',
    'templates/basic/package.json'
  ];
  await Promise.all(
    files.map(async (file) => {
      const destination = path.join(directory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(repositoryRoot, file), destination);
    })
  );
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

function jsonResponse(value, { link = null } = {}) {
  return {
    headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) },
    json: async () => value,
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value)
  };
}

function dependabotAlert(number) {
  return {
    dependency: { package: { name: `dependency-${number}` } },
    html_url: `https://github.test/alerts/${number}`,
    number,
    security_advisory: { summary: `Advisory ${number}` }
  };
}

function bytesResponse(value) {
  return {
    arrayBuffer: async () => value,
    ok: true,
    status: 200,
    text: async () => value.toString('utf8')
  };
}

function oidcEnvironment() {
  return {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://github.test/oidc'
  };
}
