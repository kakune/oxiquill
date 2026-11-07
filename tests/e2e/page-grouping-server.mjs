import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { runProcess } from '../../packages/oxiquill/dist/generator/doc-runtime/process-runner.mjs';
import { preparePageGroupingFixture } from '../runtime/page-grouping-fixture.mjs';

const cwd = await preparePageGroupingFixture();
process.env.OXIQUILL_FIXTURE_GROUPING = 'page';
const buildOnly = process.argv.includes('--build-only');
if (buildOnly || process.env.OXIQUILL_FIXTURE_PREBUILT !== '1') await runCli(['build'], { cwd });
if (!buildOnly)
  await runCli(['preview', '--host', '127.0.0.1', '--port', '4325'], {
    cwd,
    // Match the main browser fixture: Playwright owns the server lifecycle.
    runCommand: (command, args, options) => runProcess(command, [...args, '--ignore-lock'], options)
  });
