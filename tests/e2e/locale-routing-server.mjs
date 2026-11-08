import { fileURLToPath } from 'node:url';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { runProcess } from '../../packages/oxiquill/dist/generator/doc-runtime/process-runner.mjs';
import { prepareLinkedFixture } from '../runtime/page-grouping-fixture.mjs';

// A cell-free site with a missing translation, a full-width page, doc redirects, and a base path.
const cwd = await prepareLinkedFixture(fileURLToPath(new URL('../fixtures/locale-routing/', import.meta.url)));
await runCli(['build'], { cwd });
await runCli(['preview', '--host', '127.0.0.1', '--port', '4326'], {
  cwd,
  runCommand: (command, args, options) => runProcess(command, [...args, '--ignore-lock'], options)
});
