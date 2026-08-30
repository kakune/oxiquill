import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAllGitHubPages, githubHeaders, requestGitHubJson } from './github-api.mjs';
import { verifyReleaseArchive } from './release-archive.mjs';

export async function uploadReleaseAssets({
  directory,
  expectedCommit,
  expectedWorkflowCommit,
  expectedVersion,
  fetchImplementation = fetch,
  repository,
  tag,
  token
}) {
  assertInputs({ expectedCommit, expectedVersion, expectedWorkflowCommit, repository, tag, token });
  await verifyReleaseArchive(directory, expectedVersion, {
    expectedCommit,
    expectedWorkflowCommit,
    outputFile: null
  });

  const apiRoot = `https://api.github.com/repos/${repository}`;
  const release = await requestGitHubJson(
    fetchImplementation,
    `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`,
    token
  );
  if (release.tag_name !== tag || !Number.isInteger(release.id)) {
    throw new Error(`GitHub Release identity does not match ${tag}.`);
  }

  const assets = await fetchAllGitHubPages(`${apiRoot}/releases/${release.id}/assets?per_page=100`, {
    fetchImplementation,
    responseName: 'GitHub Release assets API',
    token
  });
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

function assertInputs({ expectedCommit, expectedVersion, expectedWorkflowCommit, repository, tag, token }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository identifier: ${repository}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) throw new Error('Expected release commit must be a full Git SHA.');
  if (!/^[0-9a-f]{40}$/u.test(expectedWorkflowCommit)) {
    throw new Error('Expected workflow commit must be a full Git SHA.');
  }
  if (tag !== `v${expectedVersion}`) throw new Error(`Release tag ${tag} does not match version ${expectedVersion}.`);
  if (!token) throw new Error('GITHUB_TOKEN must be set.');
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
      expectedWorkflowCommit: process.env.GITHUB_WORKFLOW_SHA,
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
