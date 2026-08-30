import { parseArgs } from 'node:util';

const globalOptionDefinitions = Object.freeze({
  debug: option('boolean', '--debug', 'Show stack and cause details when a command fails.'),
  help: option('boolean', '--help, -h', 'Show global or command-specific help.', { short: 'h' }),
  version: option('boolean', '--version', 'Print the installed Oxiquill version.')
});

const configOptionDefinition = option('string', '--config <path>', 'Use a specific Astro/Oxiquill configuration file.');

const astroDevOptions = Object.freeze({
  'allowed-hosts': optionalStringOption(
    '--allowed-hosts [hosts]',
    'Allow a comma-separated host list, or every host when no value is given.'
  ),
  background: option('boolean', '--background', 'Start Astro in the background.'),
  force: option('boolean', '--force', 'Clear the content cache before starting.'),
  host: optionalStringOption('--host [address]', 'Listen on every address or a selected address.'),
  'ignore-lock': option('boolean', '--ignore-lock', "Start without checking or writing Astro's lock file."),
  mode: option('string', '--mode <name>', 'Set the Astro development mode.'),
  open: optionalStringOption('--open [path]', 'Open the site, optionally at a selected path.'),
  port: option('string', '--port <number>', 'Set the development server port.')
});

const commandDefinitions = Object.freeze({
  init: command('init [directory]', 'Create the versioned static starter.', { positionalLimit: 1 }),
  dev: command('dev [options] [-- <astro-options>]', 'Generate runtimes and start the development server.', {
    astro: true,
    options: astroDevOptions,
    project: true
  }),
  'dev:runtime': command('dev:runtime [options]', 'Run only the runtime and source watcher.', {
    options: {
      'skip-initial': option('boolean', '--skip-initial', 'Skip the initial runtime synchronization.')
    },
    project: true
  }),
  'dev:astro': command('dev:astro [options] [-- <astro-options>]', 'Run only the Astro development server.', {
    astro: true,
    options: astroDevOptions,
    project: true
  }),
  preview: command('preview [options] [-- <astro-options>]', 'Preview the existing production build.', {
    astro: true,
    options: {
      'allowed-hosts': optionalStringOption(
        '--allowed-hosts [hosts]',
        'Allow a comma-separated host list, or every host when no value is given.'
      ),
      background: option('boolean', '--background', 'Start Astro in the background.'),
      host: optionalStringOption('--host [address]', 'Listen on every address or a selected address.'),
      open: optionalStringOption('--open [path]', 'Open the site, optionally at a selected path.'),
      port: option('string', '--port <number>', 'Set the preview server port.')
    },
    project: true
  }),
  build: command('build [options] [-- <astro-options>]', 'Generate runtimes, check, and build the site.', {
    astro: true,
    options: {
      devOutput: option('boolean', '--devOutput', 'Emit development-style output.'),
      force: option('boolean', '--force', 'Clear the content cache before building.'),
      mode: option('string', '--mode <name>', 'Set the Astro build mode.'),
      outDir: option('string', '--outDir <directory>', 'Set the Astro output directory.')
    },
    project: true
  }),
  check: command('check [options] [-- <check-options>]', 'Generate runtimes and run Astro diagnostics.', {
    astro: true,
    options: {
      minimumFailingSeverity: option(
        'string',
        '--minimumFailingSeverity <level>',
        'Set the minimum failing severity: error, warning, or hint.',
        { choices: ['error', 'warning', 'hint'] }
      ),
      minimumSeverity: option(
        'string',
        '--minimumSeverity <level>',
        'Set the minimum displayed severity: error, warning, or hint.',
        { choices: ['error', 'warning', 'hint'] }
      ),
      preserveWatchOutput: option(
        'boolean',
        '--preserveWatchOutput',
        'Keep previous diagnostics visible while watching.'
      ),
      tsconfig: option('string', '--tsconfig <path>', 'Use a selected tsconfig or jsconfig file.'),
      watch: option('boolean', '--watch, -w', 'Watch files and rerun diagnostics.', { short: 'w' })
    },
    project: true
  }),
  docgen: command('docgen [options]', 'Synchronize the interactive-cell manifest and optional runtimes.', {
    options: {
      wasm: option('string', '--wasm <mode>', 'Build language runtimes in dev or build mode.', {
        choices: ['dev', 'build']
      })
    },
    project: true
  }),
  clean: command('clean [options]', 'Remove resolved Oxiquill-owned generated output.', { project: true }),
  'test-rust': command('test-rust [options]', 'Test optional Rust helper crates.', { project: true }),
  'test-rust-coverage': command('test-rust-coverage [options]', 'Test Rust helper crates with coverage thresholds.', {
    project: true
  }),
  'lint-rust': command('lint-rust [options]', 'Lint optional Rust helper crates.', { project: true }),
  'doc-rust': command('doc-rust [options]', 'Build optional Rust helper-crate documentation.', { project: true }),
  'test-wasm': command('test-wasm [options]', 'Generate and test compiled Wasm runtimes.', { project: true })
});

const globalUsage = 'Usage: oxiquill <command> [options]';

export class CliUsageError extends Error {
  constructor(message, commandName, options = {}) {
    super(message, options);
    this.name = 'CliUsageError';
    this.usage = formatCliHelp(commandName);
  }
}

export function parseCliArguments(args = []) {
  const commandIndex = findCommandIndex(args);
  const commandName = commandIndex === -1 ? undefined : args[commandIndex];

  if (commandName !== undefined && commandName !== 'help' && !commandDefinitions[commandName]) {
    throw new CliUsageError(`Unknown oxiquill command ${JSON.stringify(commandName)}.`);
  }

  const definition = commandName === 'help' ? helpCommandDefinition() : commandDefinitions[commandName];
  const commandArgs =
    commandIndex === -1 ? [...args] : [...args.slice(0, commandIndex), ...args.slice(commandIndex + 1)];
  const terminatorIndex = commandArgs.indexOf('--');
  const beforeTerminator = terminatorIndex === -1 ? commandArgs : commandArgs.slice(0, terminatorIndex);
  const afterTerminator = terminatorIndex === -1 ? [] : commandArgs.slice(terminatorIndex + 1);

  if (terminatorIndex !== -1 && !definition?.astro) {
    throw new CliUsageError('The -- argument separator is only supported by Astro forwarding commands.', commandName);
  }

  const optionDefinitions = {
    ...globalOptionDefinitions,
    ...(definition?.project ? { config: configOptionDefinition } : {}),
    ...definition?.options
  };
  const normalizedArgs = normalizeOptionalStringOptions(beforeTerminator, optionDefinitions, commandName);
  const parsed = parseStrict(normalizedArgs, optionDefinitions, commandName);
  const forwardedParsed =
    terminatorIndex === -1
      ? undefined
      : parseStrict(
          normalizeOptionalStringOptions(afterTerminator, definition.options, commandName),
          definition.options,
          commandName
        );

  validateOptionChoices(parsed.values, optionDefinitions, commandName);
  if (forwardedParsed) {
    validateOptionChoices(forwardedParsed.values, definition.options, commandName);
    if (forwardedParsed.positionals.length > 0) {
      throw new CliUsageError(
        `${commandName} does not accept positional Astro arguments: ${forwardedParsed.positionals
          .map(JSON.stringify)
          .join(', ')}.`,
        commandName
      );
    }
  }
  validateConfigOccurrences(beforeTerminator, commandName);

  const values = { ...parsed.values, ...forwardedParsed?.values };

  if (values.version) return Object.freeze({ action: 'version' });

  if (commandName === 'help') {
    if (parsed.positionals.length > 1) {
      throw new CliUsageError('The help command accepts at most one command name.', 'help');
    }
    const topic = parsed.positionals[0];
    if (topic !== undefined && !commandDefinitions[topic]) {
      throw new CliUsageError(`Unknown oxiquill command ${JSON.stringify(topic)}.`);
    }
    return Object.freeze({ action: 'help', commandName: topic });
  }

  if (commandName === undefined) {
    if (parsed.positionals.length > 0) throw new CliUsageError('Unexpected positional arguments.');
    return Object.freeze({ action: 'help' });
  }

  if (values.help) return Object.freeze({ action: 'help', commandName });
  const positionalLimit = definition.positionalLimit ?? 0;
  if (parsed.positionals.length > positionalLimit) {
    const unexpected = parsed.positionals.slice(positionalLimit);
    throw new CliUsageError(
      `${commandName} received unexpected positional arguments: ${unexpected.map(JSON.stringify).join(', ')}.`,
      commandName
    );
  }

  const forwardedArgs = definition.astro ? [...stripGlobalOptions(beforeTerminator), ...afterTerminator] : [];

  return Object.freeze({
    action: 'run',
    commandArgs: Object.freeze(forwardedArgs),
    commandName,
    configFile: values.config,
    positionals: Object.freeze(parsed.positionals),
    values: Object.freeze(values)
  });
}

export function formatCliHelp(commandName) {
  if (commandName === 'help') {
    return [
      'Usage: oxiquill help [command]',
      '',
      'Show global help or help for one command.',
      '',
      formatOptionTable(globalOptionDefinitions)
    ].join('\n');
  }

  if (commandName !== undefined) {
    const definition = commandDefinitions[commandName];
    if (!definition) return formatCliHelp();
    const options = {
      ...globalOptionDefinitions,
      ...(definition.project ? { config: configOptionDefinition } : {}),
      ...definition.options
    };
    return [`Usage: oxiquill ${definition.usage}`, '', definition.description, '', formatOptionTable(options)].join(
      '\n'
    );
  }

  const commandRows = Object.entries(commandDefinitions).map(([name, definition]) => [name, definition.description]);
  return [
    globalUsage,
    '       oxiquill --help',
    '       oxiquill --version',
    '',
    'Commands:',
    formatRows(commandRows),
    '',
    formatOptionTable(globalOptionDefinitions),
    '',
    'Run `oxiquill help <command>` for command-specific options.'
  ].join('\n');
}

export function debugRequested(args) {
  const terminatorIndex = args.indexOf('--');
  const relevantArgs = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  return relevantArgs.includes('--debug');
}

export function formatCliError(error, { debug = false } = {}) {
  const message = debug ? detailedError(error) : conciseError(error);
  return error instanceof CliUsageError ? `${message}\n\n${error.usage}` : message;
}

function command(usage, description, { astro = false, options = {}, positionalLimit = 0, project = false } = {}) {
  return Object.freeze({ astro, description, options: Object.freeze(options), positionalLimit, project, usage });
}

function option(type, label, description, { choices, short } = {}) {
  return Object.freeze({ choices, description, label, short, type });
}

function optionalStringOption(label, description) {
  return Object.freeze({ description, label, optionalString: true, type: 'string' });
}

function helpCommandDefinition() {
  return command('help [command]', 'Show global or command-specific help.', { options: {}, project: false });
}

function findCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') throw new CliUsageError('A command is required before --.');
    if (argument === '--config') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--config=') || ['--debug', '--help', '-h', '--version'].includes(argument)) continue;
    if (argument.startsWith('-')) throw new CliUsageError(`Unknown option ${JSON.stringify(argument)}.`);
    return index;
  }
  return -1;
}

function parseStrict(args, definitions, commandName) {
  const options = Object.fromEntries(
    Object.entries(definitions).flatMap(([name, definition]) => {
      const entries = [[name, { type: definition.type, ...(definition.short ? { short: definition.short } : {}) }]];
      if (definition.optionalString) entries.push([optionalBooleanName(name), { type: 'boolean' }]);
      return entries;
    })
  );

  try {
    return parseArgs({ allowPositionals: true, args, options, strict: true });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), commandName, { cause: error });
  }
}

function normalizeOptionalStringOptions(args, definitions, commandName) {
  const optionalNames = new Set(
    Object.entries(definitions)
      .filter(([, definition]) => definition.optionalString)
      .map(([name]) => name)
  );
  const normalized = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = argument.startsWith('--') ? argument.slice(2).split('=', 1)[0] : undefined;
    if (!name || !optionalNames.has(name)) {
      normalized.push(argument);
      continue;
    }
    if (argument.includes('=')) {
      if (argument.endsWith('=')) {
        throw new CliUsageError(`${argument.slice(0, -1)} requires a non-empty value after =.`, commandName);
      }
      normalized.push(argument);
      continue;
    }

    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      normalized.push(argument, next);
      index += 1;
    } else {
      normalized.push(`--${optionalBooleanName(name)}`);
    }
  }

  return normalized;
}

function optionalBooleanName(name) {
  return `${name}-default`;
}

function validateOptionChoices(values, definitions, commandName) {
  for (const [name, definition] of Object.entries(definitions)) {
    const value = values[name];
    if (value === undefined || !definition.choices || definition.choices.includes(value)) continue;
    throw new CliUsageError(
      `${definition.label.split(' ', 1)[0]} must be one of: ${definition.choices.join(', ')}.`,
      commandName
    );
  }
}

function validateConfigOccurrences(args, commandName) {
  const count = args.filter((argument) => argument === '--config' || argument.startsWith('--config=')).length;
  if (count > 1) throw new CliUsageError('--config may only be specified once.', commandName);
}

function stripGlobalOptions(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['--debug', '--help', '-h', '--version'].includes(argument) || argument.startsWith('--config=')) continue;
    if (argument === '--config') {
      index += 1;
      continue;
    }
    result.push(argument);
  }
  return result;
}

function formatOptionTable(definitions) {
  return [
    'Options:',
    formatRows(Object.values(definitions).map(({ description, label }) => [label, description]))
  ].join('\n');
}

function formatRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`).join('\n');
}

function conciseError(error) {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function detailedError(error) {
  if (!(error instanceof Error)) return String(error);
  const details = [error.stack ?? `${error.name}: ${error.message}`];
  let cause = error.cause;
  while (cause !== undefined) {
    details.push(`Caused by: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return details.join('\n');
}
