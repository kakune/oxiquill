// Effects are supplied by the caller; the planner and generators do not own a UI.
export function createRuntimeEvents({ report = () => {}, now = () => performance.now() } = {}) {
  const phases = [];
  const active = new Map();
  // Completed phases keep their interval for the summary; reported events are unchanged.
  const emit = (event, started) => {
    if (event.type === 'phase' && event.state !== 'start')
      phases.push(
        started === undefined
          ? event
          : Object.defineProperty({ ...event }, 'interval', { value: [started, started + event.elapsedMs] })
      );
    report(event);
  };
  return {
    report: (event) => emit(event),
    phases,
    failActive(reason = 'cancelled') {
      for (const [token, { phase, context, started }] of active) {
        active.delete(token);
        emit(
          { type: 'phase', phase, ...context, state: 'failure', reason, elapsedMs: Math.round(now() - started) },
          started
        );
      }
    },
    skipped(phase, context = {}) {
      emit({ type: 'phase', phase, ...context, state: 'skipped', elapsedMs: 0 });
    },
    async phase(phase, context, action) {
      const started = now();
      const token = Symbol(phase);
      active.set(token, { phase, context, started });
      emit({ type: 'phase', phase, ...context, state: 'start', elapsedMs: 0 });
      try {
        const result = await action();
        if (active.delete(token))
          emit({ type: 'phase', phase, ...context, state: 'success', elapsedMs: Math.round(now() - started) }, started);
        return result;
      } catch (error) {
        if (active.delete(token))
          emit({ type: 'phase', phase, ...context, state: 'failure', elapsedMs: Math.round(now() - started) }, started);
        throw error;
      }
    }
  };
}

// Phases of one name can nest (a generation phase wrapping lock resolution) or
// run concurrently (one per module in the post-link pool). The summary reports
// the wall-clock time covered by their intervals rather than their sum.
function wallClockMs(entries) {
  const intervals = entries.flatMap((entry) => (entry.interval ? [entry.interval] : [])).sort(([a], [b]) => a - b);
  let total = entries.filter((entry) => !entry.interval).reduce((sum, entry) => sum + entry.elapsedMs, 0);
  let current;
  for (const [start, end] of intervals) {
    if (current && start <= current[1]) current[1] = Math.max(current[1], end);
    else {
      if (current) total += current[1] - current[0];
      current = [start, end];
    }
  }
  if (current) total += current[1] - current[0];
  return Math.round(total);
}

export function summarizePhases(phases) {
  return Object.entries(Object.groupBy(phases, (event) => event.phase)).map(([phase, entries]) => ({
    phase,
    elapsedMs: wallClockMs(entries),
    state: entries.some((entry) => entry.state === 'failure')
      ? 'failure'
      : entries.every((entry) => entry.state === 'skipped')
        ? 'skipped'
        : 'success',
    cache: {
      hits: entries.filter((entry) => entry.cache === 'hit').length,
      misses: entries.filter((entry) => entry.cache === 'miss').length
    }
  }));
}
