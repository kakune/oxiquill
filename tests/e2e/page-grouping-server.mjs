import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { preparePageGroupingFixture } from '../runtime/page-grouping-fixture.mjs';

const cwd = await preparePageGroupingFixture();
process.env.OXIQUILL_FIXTURE_GROUPING = 'page';
await runCli(['build'], { cwd });
await runCli(['preview', '--host', '127.0.0.1', '--port', '4325'], { cwd });
