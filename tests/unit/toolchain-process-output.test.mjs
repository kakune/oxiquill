import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runCommandWithCapturedOutput } from '../../packages/oxiquill/src/generator/doc-runtime/toolchain-preflight.mjs';

function processDouble() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('toolchain process output', () => {
  it('waits for stdout to finish after process exit', async () => {
    const child = processDouble();
    const spawn = vi.fn(() => child);
    const output = runCommandWithCapturedOutput('rustc', ['--version'], spawn);
    const settled = vi.fn();
    void output.then(settled);

    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('rustc '));
    child.stdout.emit('data', Buffer.from('1.95.0\n'));
    child.emit('close', 0, null);

    await expect(output).resolves.toBe('rustc 1.95.0\n');
    expect(spawn).toHaveBeenCalledWith('rustc', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('retains stderr that arrives after a failed process exits', async () => {
    const child = processDouble();
    const output = runCommandWithCapturedOutput('rustc', ['--version'], () => child);
    const rejected = expect(output).rejects.toThrow('toolchain unavailable');
    child.emit('exit', 1, null);
    child.stderr.emit('data', Buffer.from('toolchain '));
    child.stderr.emit('data', Buffer.from('unavailable\n'));
    child.emit('close', 1, null);
    await rejected;
  });

  it.each([
    [1, null, '1'],
    [null, 'SIGTERM', 'SIGTERM']
  ])('reports an empty failure with code %s and signal %s', async (code, signal, detail) => {
    const child = processDouble();
    const output = runCommandWithCapturedOutput('cargo', ['--version'], () => child);
    child.emit('close', code, signal);
    await expect(output).rejects.toThrow(`cargo exited with ${detail}`);
  });

  it('rejects spawn errors', async () => {
    const child = processDouble();
    const output = runCommandWithCapturedOutput('missing-tool', [], () => child);
    child.emit('error', new Error('spawn ENOENT'));
    await expect(output).rejects.toThrow('spawn ENOENT');
  });

  it('captures output from a real child process', async () => {
    await expect(runCommandWithCapturedOutput(process.execPath, ['-e', 'process.stdout.write("ready")'])).resolves.toBe(
      'ready'
    );
  });
});
