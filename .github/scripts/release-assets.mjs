import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReleaseArchive } from './release-archive.mjs';

const apiVersion = '2022-11-28';

export async function uploadReleaseAssets({
  directory,
  expectedCommit,
  expectedVersion,
  fetchImplementation = fetch,
  repository,
  tag,
  token
}) {
  assertInputs({ expectedCommit, expectedVersion, repository, tag, token });
  await verifyReleaseArchive(directory, expectedVersion, { expectedCommit, outputFile: null });

  const apiRoot = `https://api.github.com/repos/${repository}`;
  const release = await requestJson(fetchImplementation, `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`, token);
  if (release.tag_name !== tag || !Number.isInteger(release.id)) {
    throw new Error(`GitHub Release identity does not match ${tag}.`);
  }

  const assets = await fetchAllPages(
    fetchImplementation,
    `${apiRoot}/releases/${release.id}/assets?per_page=100`,
    token
  );
  const filenames = (await readdir(directory)).sort();
  const results = [];

  for (const filename of filenames) {
    const matches = assets.filter((asset) => asset.name === filename);
    if (matches.length > 1) throw new Error(`GitHub Release contains duplicate asset name ${filename}.`);

    const filePath = path.join(directory, filename);
    const expectedBytes = await readFile(filePath);
    if (matches.length === 1) {
      const actualBytes = await requestBytes(fetchImplementation, matches[0].url, token);
      if (!actualBytes.equals(expectedBytes)) {
        throw new Error(`GitHub Release asset ${filename} conflicts with the verified artifact.`);
      }
      results.push({ filename, status: 'unchanged' });
      continue;
    }

    const uploadUrl = new URL(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets`);
    uploadUrl.searchParams.set('name', filename);
    const response = await fetchImplementation(uploadUrl, {
      body: expectedBytes,
      headers: githubHeaders(token, 'application/vnd.github+json', {
        'Content-Type': 'application/octet-stream'
      }),
      method: 'POST'
    });
    if (!response.ok) {
      throw new Error(`GitHub Release asset upload failed with ${response.status}: ${await response.text()}`);
    }
    results.push({ filename, status: 'uploaded' });
  }

  return results;
}

function assertInputs({ expectedCommit, expectedVersion, repository, tag, token }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository identifier: ${repository}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) throw new Error('Expected release commit must be a full Git SHA.');
  if (tag !== `v${expectedVersion}`) throw new Error(`Release tag ${tag} does not match version ${expectedVersion}.`);
  if (!token) throw new Error('GITHUB_TOKEN must be set.');
}

async function fetchAllPages(fetchImplementation, url, token) {
  const results = [];
  let page = 1;
  while (true) {
    const response = await requestJson(fetchImplementation, `${url}&page=${page}`, token);
    if (!Array.isArray(response)) throw new Error('GitHub Release assets API returned a non-array response.');
    results.push(...response);
    if (response.length < 100) return results;
    page += 1;
  }
}

async function requestJson(fetchImplementation, url, token) {
  const response = await fetchImplementation(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API request failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function requestBytes(fetchImplementation, url, token) {
  const response = await fetchImplementation(url, {
    headers: githubHeaders(token, 'application/octet-stream')
  });
  if (!response.ok) {
    throw new Error(`GitHub Release asset download failed with ${response.status}: ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function githubHeaders(token, accept = 'application/vnd.github+json', additional = {}) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'oxiquill-release-assets',
    'X-GitHub-Api-Version': apiVersion,
    ...additional
  };
}

function gitOutput(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    const [directory, expectedVersion, tag] = process.argv.slice(2);
    if (!directory || !expectedVersion || !tag) {
      throw new Error('Usage: release-assets.mjs <directory> <version> <tag>');
    }
    const results = await uploadReleaseAssets({
      directory,
      expectedCommit: gitOutput(['rev-parse', 'HEAD']),
      expectedVersion,
      repository: process.env.GITHUB_REPOSITORY,
      tag,
      token: process.env.GITHUB_TOKEN
    });
    results.forEach(({ filename, status }) => console.log(`${filename}: ${status}`));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
