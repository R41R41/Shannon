import type { RequestEnvelope } from '@shannon/common';
import type { RequestExecutionCoordinator } from './requestExecutionCoordinator.js';

/** Keep execution and dispatch in the same lane; do not publish a cancelled result. */
export function runCoordinatedGraph<T>(
  coordinator: RequestExecutionCoordinator,
  envelope: RequestEnvelope,
  invoke: (signal: AbortSignal) => Promise<T>,
  dispatch: (result: T) => Promise<void>,
  callerSignal?: AbortSignal,
): Promise<T> {
  return coordinator.run(envelope, async signal => {
    signal.throwIfAborted();
    const result = await invoke(signal);
    signal.throwIfAborted();
    await dispatch(result);
    return result;
  }, callerSignal);
}
