// Effects are supplied by the caller; the planner and generators do not own a UI.
export function createRuntimeEvents({ report = () => {}, now = () => performance.now() } = {}) {
  const phases = [];
  const active = new Map();
  const emit = (event) => {
    if (event.type === 'phase' && event.state !== 'start') phases.push(event);
    report(event);
  };
  return {
    report: emit,
    phases,
    failActive(reason = 'cancelled') {
      for (const [token, { phase, context, started }] of active) {
        active.delete(token);
        emit({ type: 'phase', phase, ...context, state: 'failure', reason, elapsedMs: Math.round(now() - started) });
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
          emit({ type: 'phase', phase, ...context, state: 'success', elapsedMs: Math.round(now() - started) });
        return result;
      } catch (error) {
        if (active.delete(token))
          emit({ type: 'phase', phase, ...context, state: 'failure', elapsedMs: Math.round(now() - started) });
        throw error;
      }
    }
  };
}

export function summarizePhases(phases) {
  return Object.entries(Object.groupBy(phases, (event) => event.phase)).map(([phase, entries]) => ({
    phase,
    elapsedMs: entries.reduce((total, entry) => total + entry.elapsedMs, 0),
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
