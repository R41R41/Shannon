import type { RequestEnvelope } from '@shannon/common';
import { ExecutionLanes, executionLaneKey } from '../../../modules/execution/index.js';

/** Node cancellation adapter for the SDK-independent execution scheduler. */
export class RequestExecutionCoordinator {
  private static instance: RequestExecutionCoordinator;
  private readonly lanes = new ExecutionLanes(() => new AbortController());

  static getInstance(): RequestExecutionCoordinator {
    return this.instance ??= new RequestExecutionCoordinator();
  }

  getAbortController(laneKey: string): AbortController | undefined {
    return this.lanes.getCurrentCancellation(laneKey);
  }

  async run<T>(
    envelope: RequestEnvelope,
    task: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    callerSignal?.throwIfAborted();
    const key = executionLaneKey(envelope);
    // Applying code changes stays serial, even with an emergency tag.
    const preempt = envelope.tags.includes('emergency') && !envelope.tags.includes('self_mod_apply');
    return this.lanes.run(key, async controller => {
      const signal = callerSignal
        ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
      // A request cancelled while queued must not start graph execution.
      signal.throwIfAborted();
      const result = await task(signal);
      signal.throwIfAborted();
      return result;
    }, preempt);
  }
}
