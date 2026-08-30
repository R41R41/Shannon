/** In-process scheduling only. Cancellation is cooperative, not a sandbox. */
export interface CancellationHandle { abort(): void }
interface Run<C> { cancellation: C; execute(): Promise<void> }
interface Lane<C> { running: Set<Run<C>>; queued: Run<C>[]; current?: Run<C> }

/** Owns queue order and run lifetimes; no SDK, timer, logger, or environment access. */
export class ExecutionLanes<C extends CancellationHandle> {
  private readonly lanes = new Map<string, Lane<C>>();
  constructor(private readonly createCancellation: () => C) {}

  getCurrentCancellation(key: string): C | undefined {
    return this.lanes.get(key)?.current?.cancellation;
  }

  run<T>(key: string, task: (cancellation: C) => Promise<T>, preempt = false): Promise<T> {
    if (!key.trim()) return Promise.reject(new Error('Execution lane key is required'));
    return new Promise<T>((resolve, reject) => {
      const cancellation = this.createCancellation();
      const lane: Lane<C> = this.lanes.get(key) ?? { running: new Set<Run<C>>(), queued: [] };
      this.lanes.set(key, lane);
      const run: Run<C> = {
        cancellation,
        execute: async () => {
          try { resolve(await task(cancellation)); }
          catch (error) { reject(error); }
          finally {
            lane.running.delete(run);
            if (lane.current === run) lane.current = undefined;
            this.drain(key, lane);
          }
        },
      };
      if (preempt) {
        const previous = [...lane.running];
        // Install the new owner before abort listeners can run synchronously.
        lane.running.add(run);
        lane.current = run;
        for (const old of previous) old.cancellation.abort();
        void run.execute();
      } else {
        lane.queued.push(run);
        this.drain(key, lane);
      }
    });
  }

  private drain(key: string, lane: Lane<C>): void {
    // An aborted predecessor may still be unwinding or ignoring its signal.
    if (lane.running.size > 0) return;
    const next = lane.queued.shift();
    if (next) {
      lane.running.add(next);
      lane.current = next;
      void next.execute();
    } else if (this.lanes.get(key) === lane) {
      this.lanes.delete(key);
    }
  }
}

export interface ExecutionRequest {
  channel: string;
  threadId: string;
  tags: readonly string[];
  minecraft?: { worldId?: string; serverId?: string; serverName?: string };
}

export function executionLaneKey(request: ExecutionRequest): string {
  if (request.tags.includes('self_mod_apply')) return 'self-mod:apply';
  if (request.channel === 'minecraft') {
    if (request.minecraft?.serverId?.trim() && request.minecraft.worldId?.trim()) {
      return `minecraft-world:${JSON.stringify([request.minecraft.serverId, request.minecraft.worldId])}`;
    }
    const world = [request.minecraft?.worldId, request.minecraft?.serverId,
      request.minecraft?.serverName, request.threadId].find(value => value?.trim());
    if (!world) throw new Error('Minecraft execution requires a world or thread');
    return `minecraft-world:${world}`;
  }
  if (!request.channel.trim() || !request.threadId.trim()) {
    throw new Error('Execution requires a channel and thread');
  }
  return `thread:${JSON.stringify([request.channel, request.threadId])}`;
}
