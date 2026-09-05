import { afterEach, expect, it, vi } from 'vitest';
import { markRuntimeEvent, measureRuntimePhase } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-timing';

afterEach(() => vi.unstubAllGlobals());
it('records local timings on success and failure and replaces earlier observations', async () => {
  const performance = {
    mark: vi.fn(),
    measure: vi.fn(),
    clearMarks: vi.fn(),
    clearMeasures: vi.fn(),
    now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20).mockReturnValue(30)
  };
  vi.stubGlobal('performance', performance);
  markRuntimeEvent('hydrated', 'cell');
  expect(performance.clearMarks).toHaveBeenCalledWith('oxiquill:hydrated:cell');
  expect(await measureRuntimePhase('execution', 'cell', () => 42)).toBe(42);
  expect(performance.measure).toHaveBeenCalledWith('oxiquill:execution:cell', {
    start: 10,
    end: 20,
    detail: { phase: 'execution', cellId: 'cell' }
  });
  await expect(
    measureRuntimePhase('execution', 'cell', () => {
      throw new Error('failed');
    })
  ).rejects.toThrow('failed');
  expect(performance.clearMeasures).toHaveBeenCalledTimes(2);
});
it('executes normally when User Timing is unavailable', async () => {
  vi.stubGlobal('performance', undefined);
  markRuntimeEvent('hydrated', 'cell');
  expect(await measureRuntimePhase('execution', 'cell', () => 'ok')).toBe('ok');
});
