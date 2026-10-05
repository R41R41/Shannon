import { actionSignal, assertActionActive } from './ActionExecution.js';

export interface ObservationSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** Subscribe before reading; check immediately; polling only recovers lost events. */
export async function waitForObservation(
  bot: object, predicate: () => boolean, timeoutMs: number,
  sources: Array<{ source: ObservationSource; event: string }> = [],
  signal = actionSignal(bot),
): Promise<boolean> {
  assertActionActive(bot);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (result: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (poll) clearInterval(poll);
      for (const { source, event } of sources) source.removeListener(event, check);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(false, new Error('Action interrupted'));
    const check = () => {
      try { if (predicate()) finish(true); } catch (error) { finish(false, error); }
    };
    for (const { source, event } of sources) source.on(event, check);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    check();
    if (settled) return;
    timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    poll = setInterval(check, 100);
  });
}

export async function actionDelay(bot: object, ms: number): Promise<void> {
  await waitForObservation(bot, () => false, ms);
}

/**
 * Wait for a native promise that cannot be cancelled itself (eating, opening
 * a window) without keeping the body after the action is cancelled. The late
 * settlement is swallowed. Eating held the lease for 2.5s after an escape had
 * cancelled it, and the bot stood still under a zombie (paid run L18).
 */
export async function abortable<T>(bot: object, native: Promise<T>, signal = actionSignal(bot)): Promise<T> {
  assertActionActive(bot);
  if (!signal) return native;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { native.catch(() => {}); reject(new Error('Action interrupted')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    native.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
