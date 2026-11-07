#!/usr/bin/env node
export { isCliEntrypoint, runCli } from './commands.mjs';

import { isCliEntrypoint, runCli } from './commands.mjs';
import { debugRequested, formatCliError } from './arguments.mjs';

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);

  try {
    await runCli(args);
  } catch (error) {
    if (!error.reported) console.error(formatCliError(error, { debug: debugRequested(args) }));
    process.exitCode = error.exitCode ?? 1;
  }
}
