import { EventEmitter } from 'node:events';

// Attach immediately after spawn so output and failures survive late waiter registration.
export function observeProcess(child, label) {
  const changes = new EventEmitter();
  let output = '';
  let failure;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let exitStatus = child.signalCode ?? child.exitCode;

  const record = (chunk) => {
    output += String(chunk);
    changes.emit('change');
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.on('error', (error) => {
    failure = error;
    changes.emit('change');
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitStatus = signal ?? code;
    changes.emit('change');
  });

  const diagnostic = (message) => new Error(`${label}: ${message}\n${output.slice(-12_000)}`, { cause: failure });
  const assertRunning = () => {
    if (failure) throw diagnostic(`failed to start: ${failure.message}`);
    if (exited) throw diagnostic(`exited with ${exitStatus}`);
  };

  function waitUntil(check, expected, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        changes.off('change', inspect);
      };
      const inspect = () => {
        try {
          if (!check()) return;
          cleanup();
          resolve();
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          reject(diagnostic(`timed out waiting for ${expected}`));
        }, timeoutMs);
      }
      changes.on('change', inspect);
      inspect();
    });
  }

  return {
    assertRunning,
    waitForOutput(expected, timeoutMs) {
      const matches =
        expected instanceof RegExp
          ? () => new RegExp(expected.source, expected.flags).test(output)
          : () => output.includes(expected);
      return waitUntil(
        () => {
          assertRunning();
          return matches();
        },
        String(expected),
        timeoutMs
      );
    },
    waitForExit() {
      return waitUntil(() => {
        if (failure || (exited && exitStatus !== 0)) assertRunning();
        return exited;
      }, 'successful exit');
    }
  };
}
