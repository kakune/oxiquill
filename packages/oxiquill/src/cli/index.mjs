#!/usr/bin/env node
export { isCliEntrypoint, runCli } from './commands.mjs';

import { isCliEntrypoint, runCli } from './commands.mjs';
import { debugRequested, formatCliError } from './arguments.mjs';

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);

  try {
    await runCli(args);
  } catch (error) {
    console.error(formatCliError(error, { debug: debugRequested(args) }));
    process.exitCode = 1;
  }
}
