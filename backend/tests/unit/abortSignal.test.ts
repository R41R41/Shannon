import { describe, expect, it } from 'vitest';
import { toAbortSignal } from '../../src/services/fca/abortSignal.js';

describe('toAbortSignal', () => {
  it('passes a real AbortSignal through so cancellation keeps propagating', () => {
    const controller = new AbortController();
    const signal = toAbortSignal(controller.signal);
    expect(signal).toBe(controller.signal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('substitutes a signal for a minimal FcaSignal, carrying the state at call time', () => {
    const live = toAbortSignal({ aborted: false, throwIfAborted() {} });
    expect(live).toBeInstanceOf(AbortSignal);
    expect(live.aborted).toBe(false);

    const cancelled = toAbortSignal({ aborted: true, throwIfAborted() { throw new Error('aborted'); } });
    expect(cancelled.aborted).toBe(true);
  });
});
