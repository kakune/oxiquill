// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it.skipIf(process.platform === 'win32')(
  'drains real child output before the final JSON cancellation summary',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-cli-cancel-'));
    roots.push(root);
    const runner = path.join(root, 'runner.mjs');
    const moduleUrl = (file) => new URL(`../../packages/oxiquill/src/${file}`, import.meta.url).href;
    await writeFile(
      runner,
      [
        `import { runCli } from ${JSON.stringify(moduleUrl('cli/commands.mjs'))};`,
        `import { runProcess } from ${JSON.stringify(moduleUrl('generator/doc-runtime/process-runner.mjs'))};`,
        `import { createOxiquillPaths } from ${JSON.stringify(moduleUrl('config/paths.mjs'))};`,
        `const paths = createOxiquillPaths({ workspaceRoot: ${JSON.stringify(root)} });`,
        'setTimeout(() => process.exit(2), 10000).unref();',
        'try {',
        "await runCli(['docgen', '--format=json'], {",
        'loadProjectConfig: async () => ({ paths, astroConfigArgs: [] }),',
        "generate: ({ events, trackChild }) => events.phase('compile', { language: 'rust' }, () =>",
        "runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { events, trackChild, format: 'json' }))",
        '});',
        '} catch (error) { process.exitCode = error.exitCode ?? 1; }'
      ].join('\n')
    );
    const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let cancelled = false;
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      if (!cancelled && Buffer.concat(chunks).toString('utf8').includes('"state":"start"')) {
        cancelled = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (chunk) => errors.push(chunk));
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(cancelled, Buffer.concat(errors).toString('utf8')).toBe(true);
    expect(status.code ?? (status.signal === 'SIGINT' ? 130 : 1)).toBe(130);
    const events = Buffer.concat(chunks)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: 'summary', exitStatus: 130 });
    expect(events.filter((event) => event.type === 'summary')).toHaveLength(1);
    expect(events.at(-1).phases.find((phase) => phase.phase === 'compile').state).toBe('failure');
    await expect(readFile(path.join(root, '.oxiquill/runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
  15000
);
