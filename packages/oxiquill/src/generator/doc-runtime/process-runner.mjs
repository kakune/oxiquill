import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

export function createProcessRunner({
  spawnProcess = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  return (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      const { events, format = 'human', captureOutput, trackChild } = options;
      const inherited = format === 'human' && !events && !captureOutput;
      const detached = Boolean(trackChild) && process.platform !== 'win32';
      const context = {
        phase: options.phase ?? 'compile',
        ...(options.language ? { language: options.language } : {}),
        ...(options.module ? { module: options.module } : {})
      };
      const started = now();
      let lastOutput = started;
      let timer;
      let settled = false;
      let running = true;
      const captured = [];
      let diagnostic = '';
      const child = spawnProcess(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached,
        ...(options.signal ? { signal: options.signal } : {}),
        stdio: inherited ? 'inherit' : [format === 'json' ? 'ignore' : 'inherit', 'pipe', 'pipe']
      });
      trackChild?.(child, detached);
      const heartbeat = () => {
        if (settled || !running || options.signal?.aborted) return;
        const silence = now() - lastOutput;
        if (silence >= 30_000) {
          events?.report({ type: 'heartbeat', ...context, elapsedMs: Math.round(now() - started) });
          lastOutput = now();
        }
        timer = setTimer(heartbeat, Math.max(1, 30_000 - (now() - lastOutput)));
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        options.signal?.removeEventListener('abort', stopHeartbeat);
        if (error) reject(error);
        else resolve(Buffer.concat(captured).toString('utf8'));
      };
      const stopHeartbeat = () => {
        running = false;
        clearTimer(timer);
      };
      options.signal?.addEventListener('abort', stopHeartbeat, { once: true });
      const streams = ['stdout', 'stderr'].map((stream) => {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        const line = (value) =>
          events?.report({ type: 'output', source: options.source ?? path.basename(command), stream, line: value });
        child[stream]?.on('data', (chunk) => {
          if (settled) return;
          lastOutput = now();
          if (stream === 'stdout' && captureOutput) captured.push(Buffer.from(chunk));
          if (stream === 'stderr') diagnostic = `${diagnostic}${chunk}`.slice(-16_384);
          if (format === 'json') {
            pending += decoder.write(Buffer.from(chunk));
            const lines = pending.split(/\r?\n/u);
            pending = lines.pop();
            lines.forEach(line);
          } else if (!(stream === 'stdout' && captureOutput)) {
            (stream === 'stdout' ? stdout : stderr).write(chunk);
          }
        });
        return () => {
          if (settled || format !== 'json') return;
          pending += decoder.end();
          if (pending) line(pending);
        };
      });
      const finishStatus = (code, signal) => {
        if (settled) return;
        streams.forEach((flush) => flush());
        if (code === 0 || options.successfulSignals?.includes(signal)) finish();
        else {
          const error = new Error(
            `${command} exited with ${signal ?? code}${diagnostic.trim() ? `: ${diagnostic.trim()}` : ''}`
          );
          error.exitCode = typeof code === 'number' && code > 0 ? code : 1;
          if (captureOutput) error.stdout = Buffer.concat(captured).toString('utf8');
          finish(error);
        }
      };
      child.once('error', finish);
      child.once('exit', (code, signal) => {
        stopHeartbeat();
        // Background commands can leave descendants alive after their launcher exits.
        if (inherited) finishStatus(code, signal);
      });
      child.once('close', finishStatus);
      if (!inherited) timer = setTimer(heartbeat, 30_000);
    });
}

export const runProcess = createProcessRunner();
