#!/usr/bin/env node
export { isCliEntrypoint, runCli } from './commands.mjs';

import { isCliEntrypoint, runCli } from './commands.mjs';

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  const command = process.argv[2] ?? 'help';
  const args = process.argv.slice(3);

  try {
    await runCli(command, args);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
