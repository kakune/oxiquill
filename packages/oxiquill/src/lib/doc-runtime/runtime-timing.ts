// Local User Timing entries are bounded to the latest observation per phase and cell.
// They can be inspected in developer tools; nothing is sent to a remote service.
export function markRuntimeEvent(phase: string, cellId: string): void {
  const performance = globalThis.performance;
  if (typeof performance?.mark !== 'function') return;
  const name = `oxiquill:${phase}:${cellId}`;
  performance.clearMarks(name);
  performance.mark(name, { detail: { cellId, phase } });
}

export async function measureRuntimePhase<T>(phase: string, cellId: string, action: () => T | Promise<T>): Promise<T> {
  const performance = globalThis.performance;
  const start = performance?.now() ?? 0;
  try {
    return await action();
  } finally {
    if (typeof performance?.measure === 'function') {
      const name = `oxiquill:${phase}:${cellId}`;
      performance.clearMeasures(name);
      performance.measure(name, { start, end: performance.now(), detail: { cellId, phase } });
    }
  }
}
