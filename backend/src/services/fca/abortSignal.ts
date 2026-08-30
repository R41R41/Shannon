import type { FcaSignal } from '../../modules/fca/index.js';

/**
 * `FcaSignal` stays minimal so `modules/fca` depends on no platform type, but SDKs and
 * `fetch` require the real one. A substitute only carries the state at call time, so the
 * kernel's own checks between turns remain the cancellation path for anything else.
 */
export function toAbortSignal(signal: FcaSignal): AbortSignal {
  if (signal instanceof AbortSignal) return signal;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  return controller.signal;
}
