export const GITHUB_API_VERSION = '2026-03-10';

const githubApiOrigin = 'https://api.github.com';

export function githubHeaders(token, accept = 'application/vnd.github+json', additional = {}) {
  return {
    Accept: accept,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'User-Agent': 'oxiquill-release-control',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...additional
  };
}

export async function requestGitHubJson(fetchImplementation, url, token) {
  const response = await fetchImplementation(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function fetchAllGitHubPages(
  url,
  { fetchImplementation = fetch, responseName = 'GitHub API', token } = {}
) {
  const results = [];
  const visited = new Set();
  let nextUrl = assertGitHubApiUrl(url);

  while (nextUrl) {
    if (visited.has(nextUrl)) throw new Error('GitHub API pagination contains a cycle.');
    visited.add(nextUrl);

    const response = await fetchImplementation(nextUrl, { headers: githubHeaders(token) });
    if (!response.ok) {
      throw new Error(`GitHub API request failed with ${response.status}: ${await response.text()}`);
    }

    const values = await response.json();
    if (!Array.isArray(values)) throw new Error(`${responseName} returned a non-array response.`);
    results.push(...values);
    nextUrl = nextPageUrl(response.headers?.get?.('link'));
  }

  return results;
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(/,\s*(?=<)/u)) {
    const target = /^\s*<([^>]+)>/u.exec(part)?.[1];
    const relationship = /;\s*rel="([^"]+)"/u.exec(part)?.[1];
    if (target && relationship?.split(/\s+/u).includes('next')) return assertGitHubApiUrl(target);
  }
  return null;
}

function assertGitHubApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('GitHub API pagination returned an invalid URL.', { cause: error });
  }
  if (url.origin !== githubApiOrigin || url.username || url.password) {
    throw new Error(`GitHub API pagination returned an untrusted URL: ${url.href}`);
  }
  return url.href;
}
