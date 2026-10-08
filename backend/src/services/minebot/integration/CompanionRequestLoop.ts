import type {
  CompanionBodyClient, CompanionGained, CompanionReportCode, CompanionReportOutcome, CompanionRequest,
} from './CompanionBodyClient.js';

/**
 * Requests from Shannon's one mind to this body (shannon-ios docs/minecraft-body-contract.md, phase 4).
 *
 * The owner says 「木材集めといて」 to Shannon anywhere (the phone, or his own game chat); the companion queues it and
 * this loop holds a long-poll claim open. A claimed request becomes a task of the body's own runtime (ahead of the
 * campaign, like a person's request in game chat); the loop reports when the body took it and started on it, and
 * the result when the task ends: done or failed with a closed reason, and the items gained meanwhile (closed counts,
 * never coordinates or the whole inventory). A cancel from the companion stops the task. The loop never decides what
 * to do with a request: the task runtime does.
 */
export type RequestTaskState = 'waiting' | 'running' | 'done' | 'failed' | 'gone';

export interface CompanionRequestTasks {
  /** Puts the request ahead of the body's own work. A refusal is reported as the request's failure. */
  start(request: CompanionRequest): { taskId: string } | { refused: CompanionReportCode };
  /** Where the task is now; `failed` may say why. */
  status(taskId: string): { state: RequestTaskState; code?: CompanionReportCode };
  /** Requests stop and confirms true only once the original executor has ended. */
  stop(taskId: string): boolean | Promise<boolean>;
  /** A short label of what the body is doing for the task now (a skill name), or undefined. */
  step?(taskId: string): string | undefined;
  /** The body's item counts now, for the items gained while a request ran. */
  inventory?(): Record<string, number>;
}

export type CompanionRequestClient = Pick<CompanionBodyClient, 'claim' | 'progress' | 'report'>;

interface Held {
  request: CompanionRequest;
  taskId: string | null;
  phase: 'accepted' | 'started' | 'working';
  step?: string;
  stepReportedAt: number;
  before: Record<string, number>;
  /** The result waiting to be delivered (a report that could not reach the companion is tried again). */
  final?: { outcome: CompanionReportOutcome; code?: CompanionReportCode; gained: CompanionGained[]; attempts: number };
  /** The owner asked it to stop. */
  cancelled: boolean;
  stopRequested?: { outcome: 'failed' | 'stopped'; code: CompanionReportCode };
  stopping?: Promise<void>;
}

export interface CompanionRequestLoopOptions {
  /** How often held tasks are looked at. */
  watchMs?: number;
  /** Wait after the companion could not be reached. */
  retryMs?: number;
  /** A changed step is reported at most this often. */
  stepEveryMs?: number;
  /** Shutdown waits this long for known completion; unfinished requests remain held. */
  stopWaitMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

const REPORT_ATTEMPTS = 5;

export class CompanionRequestLoop {
  private readonly held = new Map<string, Held>();
  private readonly watchMs: number;
  private readonly retryMs: number;
  private readonly stepEveryMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private running = false;
  private claims: Promise<void> | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private abort = new AbortController();
  private ticking = false;
  private stopped = false;
  private delivery: Promise<void> | null = null;
  private deliveryDirty = false;
  private readonly stopWaitMs: number;
  /** Every request this body took, for the run's report. */
  readonly taken: Array<{ id: string; surface: CompanionRequest['surface']; taskId: string | null; outcome?: string; code?: string }> = [];

  constructor(private readonly client: CompanionRequestClient, private readonly tasks: CompanionRequestTasks, options: CompanionRequestLoopOptions = {}) {
    this.watchMs = options.watchMs ?? 2000;
    this.retryMs = options.retryMs ?? 5000;
    this.stepEveryMs = options.stepEveryMs ?? 15_000;
    this.stopWaitMs = Math.max(0, Math.min(30_000, options.stopWaitMs ?? 5000));
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.abort = new AbortController();
    this.claims = this.claimLoop();
    this.watcher = setInterval(() => { void this.tick(); }, this.watchMs);
    this.watcher.unref?.();
  }

  /** End claiming and request stop. Only known completed executions receive a
   * terminal report; an unfinished or uncertain stop remains held for recovery.
   */
  async stop(code: CompanionReportCode = 'run_over'): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.abort.abort();
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    await this.claims?.catch(() => undefined);
    const stopping: Promise<void>[] = [];
    for (const held of this.held.values()) {
      if (held.final) continue;
      held.stopRequested ??= { outcome: held.cancelled ? 'stopped' : 'failed', code: held.cancelled ? 'cancelled' : code };
      this.requestStop(held);
      if (held.stopping) stopping.push(held.stopping);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(stopping), new Promise<void>(resolve => { timer = setTimeout(resolve, this.stopWaitMs); })]);
    } finally { if (timer) clearTimeout(timer); }
    for (let attempt = 0; attempt < 2 && this.held.size; attempt++) await this.deliver();
  }

  /** Whether a task of the runtime is one of these requests. */
  isRequestTask(taskId: string): boolean {
    return [...this.held.values()].some(held => held.taskId === taskId);
  }

  /** The request a task carries, if any. */
  requestOf(taskId: string): CompanionRequest | null {
    return [...this.held.values()].find(held => held.taskId === taskId)?.request ?? null;
  }

  /** One claim; exposed for tests. */
  async claimOnce(waitSeconds?: number): Promise<boolean> {
    const answer = await this.client.claim([...this.held.keys()], waitSeconds, this.abort.signal);
    if (!answer) return false;
    for (const id of answer.cancel) this.cancelled(id);
    if (answer.request && !this.held.has(answer.request.id)) await this.take(answer.request);
    return true;
  }

  /** Looks at every held task once and reports what changed; exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const held of this.held.values()) {
        if (held.final || !held.taskId) continue;
        if (held.stopRequested) { this.requestStop(held); continue; }
        const status = this.tasks.status(held.taskId);
        if (status.state === 'done') held.final = { outcome: 'done', gained: this.gained(held), attempts: 0 };
        else if (status.state === 'failed' || status.state === 'gone') {
          held.final = held.cancelled ? { outcome: 'stopped', code: 'cancelled', gained: this.gained(held), attempts: 0 }
            : { outcome: 'failed', code: status.code ?? (status.state === 'gone' ? 'unknown' : 'gave_up'), gained: this.gained(held), attempts: 0 };
        } else if (status.state === 'running') await this.running_(held);
      }
      await this.deliver();
    } finally {
      this.ticking = false;
    }
  }

  private async claimLoop(): Promise<void> {
    while (this.running) {
      const reached = await this.claimOnce().catch(() => false);
      if (!this.running) break;
      if (!reached) await this.sleep(this.retryMs);
    }
  }

  private async take(request: CompanionRequest): Promise<void> {
    const before = this.tasks.inventory?.() ?? {};
    let started: { taskId: string } | { refused: CompanionReportCode };
    try { started = this.tasks.start(request); } catch { started = { refused: 'error' }; }
    const held: Held = { request, taskId: 'taskId' in started ? started.taskId : null, phase: 'accepted', stepReportedAt: 0, before, cancelled: false };
    this.held.set(request.id, held);
    this.taken.push({ id: request.id, surface: request.surface, taskId: held.taskId });
    this.log(`COMPANION_REQUEST_TAKEN ${JSON.stringify({ id: request.id, surface: request.surface, taskId: held.taskId, refused: 'refused' in started ? started.refused : null })}`);
    if ('refused' in started) {
      held.final = { outcome: 'failed', code: started.refused, gained: [], attempts: 0 };
      await this.deliver();
      return;
    }
    const answer = await this.client.progress(request.id, 'accepted');
    if (answer?.cancel) this.cancelled(request.id);
  }

  /** The task is running: `started` once, then a changed step now and then. */
  private async running_(held: Held): Promise<void> {
    const step = held.taskId ? this.tasks.step?.(held.taskId)?.slice(0, 80) : undefined;
    const due = held.phase === 'accepted' || (step && step !== held.step && this.now() - held.stepReportedAt >= this.stepEveryMs);
    if (!due) return;
    const phase = held.phase === 'accepted' ? 'started' : 'working';
    const answer = await this.client.progress(held.request.id, phase, step);
    if (!answer) return;
    held.phase = phase;
    held.step = step;
    held.stepReportedAt = this.now();
    if (answer.cancel) this.cancelled(held.request.id);
  }

  /** The companion asked to stop it (or it is already closed there): the task stops, and the stop is reported. */
  private cancelled(id: string): void {
    const held = this.held.get(id);
    if (!held) return;
    if (held.final) {
      // Already reported or about to be: the companion closed it; nothing more to say.
      if (held.final.attempts > 0) this.held.delete(id);
      return;
    }
    held.cancelled = true;
    held.stopRequested = { outcome: 'stopped', code: 'cancelled' };
    this.requestStop(held);
    this.log(`COMPANION_REQUEST_CANCELLED ${JSON.stringify({ id })}`);
  }

  private requestStop(held: Held): void {
    if (held.final || held.stopping || !held.stopRequested) return;
    const requested = held.stopRequested;
    let completion: boolean | Promise<boolean>;
    try { completion = held.taskId ? this.tasks.stop(held.taskId) : true; }
    catch { return; /* Unknown control result; keep the request held. */ }
    held.stopping = Promise.resolve(completion).then(confirmed => {
      if (confirmed !== true) return;
      held.final = { ...requested, gained: this.gained(held), attempts: 0 };
    }).catch(() => { /* Unknown stop: retain holding, no terminal ACK. */ }).finally(() => {
      held.stopping = undefined;
      if (this.stopped && held.final) void this.deliver().catch(() => undefined);
    });
  }

  /** Serialize ACK delivery; a late original stop may settle during shutdown. */
  private deliver(): Promise<void> {
    if (this.delivery) { this.deliveryDirty = true; return this.delivery; }
    const attempted = new Set<Held>();
    this.delivery = Promise.resolve().then(async () => {
      try {
        do {
          this.deliveryDirty = false;
          await this.deliverHeld(attempted);
        } while (this.deliveryDirty && [...this.held.values()].some(held => held.final && !attempted.has(held)));
      } finally { this.delivery = null; }
    });
    return this.delivery;
  }

  /** Sends every known result; an acknowledged (or definitively refused) result leaves holding. */
  private async deliverHeld(attempted: Set<Held>): Promise<void> {
    for (const [id, held] of [...this.held]) {
      if (!held.final || attempted.has(held)) continue;
      // A rescan catches newly closed results without retrying a failed report
      // more than once in this delivery window.
      attempted.add(held);
      held.final.attempts += 1;
      const answer = await this.client.report(id, held.final.outcome, { ...(held.final.code ? { code: held.final.code } : {}), gained: held.final.gained });
      if (answer || held.final.attempts >= REPORT_ATTEMPTS) {
        this.held.delete(id);
        const taken = this.taken.find(item => item.id === id);
        if (taken) Object.assign(taken, { outcome: held.final.outcome, ...(held.final.code ? { code: held.final.code } : {}) });
        this.log(`COMPANION_REQUEST_REPORTED ${JSON.stringify({ id, outcome: held.final.outcome, code: held.final.code ?? null, gained: held.final.gained, state: answer?.state ?? null })}`);
      }
    }
  }

  /** Items whose count went up while the request was held (at most six, the largest gains). */
  private gained(held: Held): CompanionGained[] {
    const after = this.tasks.inventory?.();
    if (!after) return [];
    return Object.entries(after).map(([item, count]) => ({ item, count: count - (held.before[item] ?? 0) }))
      .filter(entry => entry.count > 0 && /^[a-z0-9_]{1,64}$/.test(entry.item))
      .sort((a, b) => b.count - a.count).slice(0, 6);
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
