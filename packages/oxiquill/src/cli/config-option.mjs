export function parseConfigOption(args) {
  let configFile;
  const commandArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      commandArgs.push(...args.slice(index));
      break;
    }
    if (argument === '--config') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--config must be followed by a path.');
      }
      if (configFile !== undefined) throw new Error('--config may only be specified once.');
      configFile = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--config=')) {
      const value = argument.slice('--config='.length);
      if (!value) throw new Error('--config must be followed by a path.');
      if (configFile !== undefined) throw new Error('--config may only be specified once.');
      configFile = value;
      continue;
    }

    commandArgs.push(argument);
  }

  return Object.freeze({ commandArgs: Object.freeze(commandArgs), configFile });
}
