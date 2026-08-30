import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyReleaseVersions } from './verify-release-version.mjs';

export const BLOCKER_LABEL = 'release-blocker';
export const RELEASE_MILESTONE = 'npm release readiness';

const stableReleaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function assertReleaseIdentity({ packageVersion, releasePrerelease, rootVersion, tag }) {
  const match = stableReleaseTag.exec(tag);
  if (!match) {
    throw new Error(`Release tag ${tag} must match vMAJOR.MINOR.PATCH.`);
  }

  if (releasePrerelease) {
    throw new Error('Prerelease GitHub Releases cannot publish the stable package.');
  }

  const tagVersion = match.slice(1).join('.');
  if (rootVersion !== tagVersion) {
    throw new Error(`Release tag ${tag} does not match root package version ${rootVersion}.`);
  }
  if (packageVersion !== tagVersion) {
    throw new Error(`Release tag ${tag} does not match oxiquill package version ${packageVersion}.`);
  }
}

export function assertTagOnMain({ headCommit, isAncestor, tag, tagCommit }) {
  if (headCommit !== tagCommit) {
    throw new Error(`Checked out commit ${headCommit} does not match ${tag} commit ${tagCommit}.`);
  }
  if (!isAncestor) {
    throw new Error(`Release tag ${tag} is not contained in origin/main.`);
  }
}

export function assertNoOpenReleaseBlockers(blockers) {
  if (blockers.length === 0) return;

  const details = blockers.map((issue) => `#${issue.number} ${issue.title}`).join('\n');
  throw new Error(`Open ${BLOCKER_LABEL} issues remain in ${RELEASE_MILESTONE}:\n${details}`);
}

export function assertNoOpenDependabotAlerts(alerts) {
  if (alerts.length === 0) return;

  const details = alerts.map((alert) => `#${alert.number} ${alert.dependency}: ${alert.summary}`).join('\n');
  throw new Error(`Open Dependabot alerts remain:\n${details}`);
}

export async function fetchOpenDependabotAlerts({ fetchImplementation = fetch, repository, token }) {
  assertRepositoryIdentifier(repository);
  const alerts = await fetchAllPages(
    `https://api.github.com/repos/${repository}/dependabot/alerts?state=open&per_page=100`,
    { fetchImplementation, token }
  );
  return alerts.map(({ dependency, html_url: url, number, security_advisory: advisory }) => ({
    dependency: dependency?.package?.name ?? '(unknown dependency)',
    number,
    summary: advisory?.summary ?? advisory?.ghsa_id ?? '(missing advisory summary)',
    url
  }));
}

export async function fetchOpenReleaseBlockers({ fetchImplementation = fetch, repository, token }) {
  assertRepositoryIdentifier(repository);

  const apiRoot = `https://api.github.com/repos/${repository}`;
  const milestones = await fetchAllPages(`${apiRoot}/milestones?state=all&per_page=100`, {
    fetchImplementation,
    token
  });
  const milestone = milestones.find(({ title }) => title === RELEASE_MILESTONE);
  if (!milestone) {
    throw new Error(`GitHub milestone not found: ${RELEASE_MILESTONE}`);
  }

  const label = encodeURIComponent(BLOCKER_LABEL);
  const issues = await fetchAllPages(
    `${apiRoot}/issues?milestone=${milestone.number}&state=open&labels=${label}&per_page=100`,
    { fetchImplementation, token }
  );
  return issues
    .filter((issue) => !issue.pull_request)
    .map(({ html_url: url, number, title }) => ({ number, title, url }));
}

export async function verifyRelease({ environment = process.env, repositoryRoot = process.cwd() } = {}) {
  const tag = requireEnvironment(environment, 'RELEASE_TAG');
  const releasePrerelease = parseBooleanEnvironment(environment, 'RELEASE_PRERELEASE');
  const repository = requireEnvironment(environment, 'GITHUB_REPOSITORY');
  const { version } = await verifyReleaseVersions({ repositoryRoot });

  assertReleaseIdentity({
    packageVersion: version,
    releasePrerelease,
    rootVersion: version,
    tag
  });

  const headCommit = gitOutput(['rev-parse', 'HEAD'], repositoryRoot);
  const tagCommit = gitOutput(['rev-parse', `${tag}^{commit}`], repositoryRoot);
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', tagCommit, 'origin/main'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (ancestry.error) throw ancestry.error;
  if (ancestry.status !== 0 && ancestry.status !== 1) {
    throw new Error(ancestry.stderr || 'Unable to verify release ancestry.');
  }
  assertTagOnMain({ headCommit, isAncestor: ancestry.status === 0, tag, tagCommit });

  const [alerts, blockers] = await Promise.all([
    fetchOpenDependabotAlerts({ repository, token: environment.GITHUB_TOKEN }),
    fetchOpenReleaseBlockers({ repository, token: environment.GITHUB_TOKEN })
  ]);
  assertNoOpenDependabotAlerts(alerts);
  assertNoOpenReleaseBlockers(blockers);

  if (environment.GITHUB_OUTPUT) {
    await appendFile(environment.GITHUB_OUTPUT, `release_tag=${tag}\nrelease_version=${version}\n`);
  }

  return { tag, version };
}

function assertRepositoryIdentifier(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository identifier: ${repository}`);
  }
}

async function fetchAllPages(url, { fetchImplementation, token }) {
  const results = [];
  let page = 1;

  while (true) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetchImplementation(`${url}${separator}page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed with ${response.status}: ${await response.text()}`);
    }

    const values = await response.json();
    if (!Array.isArray(values)) {
      throw new Error('GitHub API returned a non-array response.');
    }
    results.push(...values);
    if (values.length < 100) return results;
    page += 1;
  }
}

function gitOutput(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function parseBooleanEnvironment(environment, name) {
  const value = requireEnvironment(environment, name);
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false.`);
  }
  return value === 'true';
}

function requireEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    const { tag, version } = await verifyRelease();
    console.log(`Verified ${tag} for oxiquill ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
