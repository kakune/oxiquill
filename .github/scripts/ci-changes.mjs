import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function classifyChanges(files, { headRef = '', chartDependenciesChanged = false } = {}) {
  const release = headRef.startsWith('release/');
  const changed = files.filter((file) => !file.endsWith('.md'));
  const full = release || changed.length > 0;
  return {
    site: full,
    runtime: full,
    consumerLinux: full,
    consumerPlatforms:
      release ||
      changed.some((file) =>
        /^(?:packages\/oxiquill\/|tests\/package\/|\.github\/|package\.json$|pnpm-lock\.yaml$)/u.test(file)
      ),
    charts:
      release ||
      chartDependenciesChanged ||
      changed.some((file) =>
        /(?:^|\/)(?:chart-[^/]+(?:\/|$)|ChartOutput\.tsx$|echarts-runtime\.ts$|styles\/)/u.test(file)
      )
  };
}

export function chartDependencySignature(manifest, lockfile) {
  const dependencies = JSON.parse(manifest).dependencies ?? {};
  // Compare complete pinned package blocks, including integrity and renderer dependencies.
  const blocks = lockfile.match(/^ {2}(?:echarts|zrender)@[^\n]+(?:\n(?: {4}[^\n]*|$))*/gmu) ?? [];
  return JSON.stringify([dependencies.echarts, blocks]);
}

export function assertCiResults(results) {
  const unsuccessful = Object.entries(results).filter(([, job]) => !['success', 'skipped'].includes(job.result));
  if (unsuccessful.length)
    throw new Error(
      `CI jobs did not succeed: ${unsuccessful.map(([name, job]) => `${name} (${job.result})`).join(', ')}`
    );
}

async function main() {
  if (process.argv[2] === '--check-results') {
    assertCiResults(JSON.parse(process.env.CI_RESULTS));
    return;
  }
  const { CI_BASE_SHA: base, CI_HEAD_SHA: head, GITHUB_HEAD_REF: headRef } = process.env;
  if (![base, head].every((sha) => /^[0-9a-f]{40}$/u.test(sha ?? '')))
    throw new Error('Expected base and head commit SHAs.');
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const ancestor = git(['merge-base', base, head]).trim();
  const files = git(['diff', '--no-renames', '--name-only', '-z', ancestor, head]).split('\0').filter(Boolean);
  const signature = (revision) =>
    chartDependencySignature(
      git(['show', `${revision}:packages/oxiquill/package.json`]),
      git(['show', `${revision}:pnpm-lock.yaml`])
    );
  const outputs = classifyChanges(files, {
    headRef,
    chartDependenciesChanged: signature(ancestor) !== signature(head)
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
  console.log(JSON.stringify(outputs));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
