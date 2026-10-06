import type { CompanionReportCode, CompanionRequest } from './CompanionBodyClient.js';
import type { CompanionRequestTasks, RequestTaskState } from './CompanionRequestLoop.js';

/** The parts of MinebotTaskRuntime a request needs. */
export interface CompanionTaskRuntime {
  putTaskFirst(taskInput: { userMessage?: string | null; onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void },
    envelopeExtras?: { tags?: string[]; metadata?: Record<string, unknown> }): { success: boolean; reason?: string; taskId?: string };
  removeTask(taskId: string): { success: boolean; reason?: string };
  getTaskListState(): { tasks: Array<{ id: string; status: string }>; currentTaskId?: string | null };
  isRunning?(): boolean;
}

export interface CompanionRuntimeTasksOptions {
  /** The task a request becomes: its tags and metadata (the runtime's envelope extras). */
  envelope: (request: CompanionRequest) => { tags: string[]; metadata: Record<string, unknown> };
  /** How many tasks people asked for are waiting or running now; at `maxWaiting` a request is refused (`queue_full`). */
  waiting: () => number;
  maxWaiting?: number;
  /** Deaths of the body so far: a request whose task ended after a death failed because she died. */
  deaths: () => number;
  /** The body's item counts. */
  inventory: () => Record<string, number>;
  /** A reason to take nothing now (the run is over), or null. */
  refuse?: (request: CompanionRequest) => CompanionReportCode | null;
  /** The skill the body started last for this task, if it is the one running. */
  step?: (taskId: string) => string | undefined;
  /** A skill started for a request's task (the task input's onToolStarting). */
  onToolStarting?: (taskId: string, toolName: string) => void;
  /** Every request offered, with what became of it (`reason`: the queue's refusal, or `busy`). */
  onTaken?: (request: CompanionRequest, result: { taskId: string } | { refused: CompanionReportCode; reason: string }) => void;
}

/**
 * Requests from her mind as tasks of the body's own MinebotTaskRuntime (CompanionRequestLoop's task side): put ahead
 * of the queue, watched until they end, stopped when the owner asks. Shared by the lab run and the production bot.
 * Who ran the task tells it how it ended (`noteRun`), because a finished task leaves the runtime's list.
 */
export class CompanionRuntimeTasks implements CompanionRequestTasks {
  private readonly byTask = new Map<string, { requestId: string; deathsAtStart: number }>();
  private readonly runs = new Map<string, { completed: boolean }>();

  constructor(private readonly runtime: CompanionTaskRuntime, private readonly options: CompanionRuntimeTasksOptions) {}

  start(request: CompanionRequest): { taskId: string } | { refused: CompanionReportCode } {
    const refusal = this.options.refuse?.(request) ?? null;
    if (refusal) {
      this.options.onTaken?.(request, { refused: refusal, reason: refusal });
      return { refused: refusal };
    }
    if (this.options.waiting() >= (this.options.maxWaiting ?? 3)) {
      this.options.onTaken?.(request, { refused: 'queue_full', reason: 'busy' });
      return { refused: 'queue_full' };
    }
    // The runtime may start the task before putTaskFirst returns its id: a skill started meanwhile is kept for it.
    let startedId: string | undefined;
    let early: string | undefined;
    const onToolStarting = this.options.onToolStarting;
    const queued = this.runtime.putTaskFirst({ userMessage: request.goal,
      ...(onToolStarting ? { onToolStarting: (tool: string) => { if (startedId) onToolStarting(startedId, tool); else early = tool; } } : {}) },
    this.options.envelope(request));
    startedId = queued.taskId;
    if (startedId && early) onToolStarting?.(startedId, early);
    if (!queued.success || !queued.taskId) {
      this.options.onTaken?.(request, { refused: 'queue_full', reason: queued.reason ?? 'queue_refused' });
      return { refused: 'queue_full' };
    }
    this.byTask.set(queued.taskId, { requestId: request.id, deathsAtStart: this.options.deaths() });
    this.options.onTaken?.(request, { taskId: queued.taskId });
    return { taskId: queued.taskId };
  }

  status(taskId: string): { state: RequestTaskState; code?: CompanionReportCode } {
    const held = this.byTask.get(taskId);
    const died = !!held && this.options.deaths() > held.deathsAtStart;
    const task = this.runtime.getTaskListState().tasks.find(entry => entry.id === taskId);
    if (task) {
      if (task.status === 'executing') return { state: 'running' };
      if (task.status === 'awaiting_user' || task.status === 'failed_terminal') {
        // It has ended for the owner: it must not linger and take his next line of chat as its continuation.
        if (!(this.runtime.isRunning?.() && this.runtime.getTaskListState().currentTaskId === taskId)) this.runtime.removeTask(taskId);
        return { state: 'failed', code: died ? 'died' : task.status === 'awaiting_user' ? 'gave_up' : 'error' };
      }
      return { state: 'waiting' };
    }
    const run = held ? this.runs.get(held.requestId) : undefined;
    if (run) return run.completed ? { state: 'done' } : { state: 'failed', code: died ? 'died' : 'gave_up' };
    return died ? { state: 'failed', code: 'died' } : { state: 'gone' };
  }

  stop(taskId: string): void {
    this.runtime.removeTask(taskId);
  }

  step(taskId: string): string | undefined {
    return this.options.step?.(taskId);
  }

  inventory(): Record<string, number> {
    return this.options.inventory();
  }

  /** The run of a request's task ended: completed (its task tree says so) or not. */
  noteRun(requestId: string, completed: boolean): void {
    this.runs.set(requestId, { completed });
  }

  /** Whether a task of the runtime carries a request. */
  isRequestTask(taskId: string): boolean {
    return this.byTask.has(taskId);
  }
}

/** Item counts of a mineflayer inventory. */
export function inventoryCounts(items: ReadonlyArray<{ name: string; count: number }> | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items ?? []) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}
