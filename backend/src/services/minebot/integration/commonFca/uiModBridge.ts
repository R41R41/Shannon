import type { BodyValue } from './bodyControlContract.js';
import type { CommonFcaObserver } from './controlLoop.js';
import type { MinecraftControlCommand as Command, MinecraftControlReceipt as Receipt } from './minecraftControlContract.js';
import { createUiModPusher } from '../uiModPush.js';

/**
 * What the common FCA body shows ShannonUIMod (the task tab, the status card, the developer log).
 *
 * The task lives in the API: the body only receives commands, each carrying the task's goal and how far it has got
 * (`BodyTaskContext`). This watches those commands and their receipts and posts the same views the old task runtime
 * posted: `/task` (the task and its steps), `/task_list` (the queue, here at most the one task), `/task_logs`. It
 * only reads what the body already receives and sends best effort; the mod being absent or slow never reaches the body.
 */

/** A task with no command for this long is no longer shown as the current one (its steps stay on screen). */
const IDLE_MS = 120_000;
const MAX_STEPS = 12;
const MAX_TEXT = 160;
const LOG_FLUSH_MS = 500;
const MAX_PENDING_LOGS = 200;

type StepStatus = 'in_progress' | 'completed' | 'error';
interface Step { id: string; goal: string; status: StepStatus; result?: string; failureReason?: string }
interface Task {
  id: string; goal: string; condition: string; startedAt: number; touchedAt: number;
  status: 'in_progress' | 'completed' | 'aborted' | 'failed'; progress: string;
  steps: Step[]; running: Map<string, Step>; counter: number; current: boolean;
}
interface LogEntry { timestamp: string; phase: 'tool_call' | 'tool_result' | 'reflection'; level: 'info' | 'success' | 'warning' | 'error'; source: string; content: string }

export interface UiModBridgeOptions {
  /** The UI mod's origin (it differs per world, so it is read on every push). */
  baseUrl: () => string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

const clip = (text: unknown, max = MAX_TEXT): string => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const compact = (value: BodyValue | undefined): string => {
  if (value === undefined || value === null) return '';
  try { return clip(typeof value === 'string' ? value : JSON.stringify(value), 60); } catch { return ''; }
};

/** The skill and its arguments in a few words, as a step of the task. */
export function describeCommand(command: Pick<Command, 'kind' | 'skill' | 'arguments' | 'operation'>): string {
  if (command.kind === 'skill') {
    const args = Object.keys(command.arguments ?? {}).length ? ` ${compact(command.arguments as BodyValue)}` : '';
    return `${command.skill ?? 'skill'}${args}`;
  }
  if (command.kind === 'reflex') return `反射: ${clip(command.operation?.candidate.label ?? 'reflex', 60)}`;
  return command.kind;
}

export class CommonFcaUiModBridge implements CommonFcaObserver {
  private task: Task | null = null;
  private logs: LogEntry[] = [];
  private logTimer?: ReturnType<typeof setTimeout>;
  private logChain: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly push: (route: string, value: unknown) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: UiModBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.push = createUiModPusher(options.baseUrl, options.timeoutMs ?? 2000, options.fetcher);
  }

  /** Clears whatever the mod still shows from an earlier run and starts watching for an idle task. */
  start(): void {
    if (this.closed || this.idleTimer) return;
    this.idleTimer = setInterval(() => this.sweep(), 5000);
    this.idleTimer.unref();
    void this.pushState();
  }

  stop(): void {
    this.closed = true;
    clearInterval(this.idleTimer); clearTimeout(this.logTimer);
    this.task = null; this.logs = [];
  }

  // ===== The control loop's view =====

  commandStarted(command: Command): void {
    if (this.closed) return;
    const context = command.context;
    if (command.kind === 'stop' || command.kind === 'release') {
      this.addLog('reflection', 'info', `${command.kind}${command.stop?.reason ? `: ${command.stop.reason}` : ''} (${clip(context.goal, 60)})`);
      return;
    }
    if (command.kind === 'capture') return;
    const task = this.taskFor(command);
    const step: Step = { id: `s${++task.counter}`, goal: describeCommand(command), status: 'in_progress' };
    task.running.set(command.id, step);
    task.steps.push(step);
    this.trim(task);
    this.addLog('tool_call', 'info', step.goal);
    this.publish();
  }

  commandEnded(command: Command, receipt: Receipt): void {
    if (this.closed) return;
    const task = this.task;
    if (command.kind === 'capture') return;
    const ok = receipt.outcome === 'completed';
    if (command.kind === 'stop' || command.kind === 'release') {
      if (task && task.id === command.context.taskId) this.finish(task, ok ? (command.stop?.reason === 'cancel' ? 'aborted' : 'completed') : 'failed');
      this.addLog('reflection', ok ? 'success' : 'warning', `${command.kind} → ${receipt.outcome}`);
      this.publish();
      return;
    }
    const step = task?.running.get(command.id);
    if (task && step) {
      task.running.delete(command.id);
      step.status = ok ? 'completed' : 'error';
      step.result = clip(receipt.result);
      if (!ok) step.failureReason = clip(receipt.failureType ?? receipt.outcome);
      task.touchedAt = this.now();
    }
    this.addLog('tool_result', ok ? 'success' : receipt.outcome === 'cancelled' ? 'warning' : 'error',
      `${describeCommand(command)} → ${receipt.outcome}${receipt.result ? `: ${clip(receipt.result)}` : ''}`);
    this.publish();
  }

  /** The task shown as current, if any. */
  currentTaskId(): string | null { return this.task?.current ? this.task.id : null; }

  /** Where the mod would read the queue from, for `GET /task_list`. */
  taskList(): { tasks: unknown[]; emergencyTask: null; currentTaskId: string | null; currentTaskTree?: unknown } {
    const task = this.task;
    return {
      tasks: task?.current ? [{ id: task.id, goal: task.goal, status: 'executing', createdAt: task.startedAt }] : [],
      emergencyTask: null,
      currentTaskId: task?.current ? task.id : null,
      ...(task ? { currentTaskTree: this.tree(task) } : {}),
    };
  }

  // ===== Task =====

  private taskFor(command: Command): Task {
    const context = command.context;
    let task = this.task;
    if (!task || task.id !== context.taskId) {
      task = { id: context.taskId, goal: clip(context.goal), condition: clip(context.completionCondition), startedAt: this.now(), touchedAt: this.now(),
        status: 'in_progress', progress: '', steps: [], running: new Map(), counter: 0, current: true };
      // After a reconnect the API tells how far the task is; show it rather than an empty list.
      for (const result of context.taskState?.recentResults ?? []) {
        task.steps.push({ id: `s${++task.counter}`, goal: clip(result.name, 60), status: result.ok ? 'completed' : 'error', result: clip(result.summary) });
      }
      this.task = task;
    }
    task.goal = clip(context.goal) || task.goal;
    task.condition = clip(context.completionCondition) || task.condition;
    task.progress = clip(context.taskState?.progress) || task.progress;
    task.status = 'in_progress'; task.current = true; task.touchedAt = this.now();
    return task;
  }

  private finish(task: Task, status: Task['status']): void {
    for (const step of task.running.values()) step.status = 'error';
    task.running.clear();
    task.status = status; task.current = false; task.touchedAt = this.now();
  }

  private trim(task: Task): void {
    while (task.steps.length > MAX_STEPS) {
      const index = task.steps.findIndex(step => step.status !== 'in_progress');
      if (index < 0) break;
      task.steps.splice(index, 1);
    }
  }

  private sweep(): void {
    const task = this.task;
    if (this.closed || !task?.current || task.running.size > 0 || this.now() - task.touchedAt < IDLE_MS) return;
    task.current = false;
    this.publish();
  }

  // ===== What the mod is sent =====

  private tree(task: Task) {
    const running = [...task.running.values()].at(-1);
    return {
      goal: task.goal, strategy: task.condition, status: task.status, currentThinking: task.progress,
      currentSubTaskId: running?.id ?? null,
      hierarchicalSubTasks: task.steps.map(step => ({ id: step.id, goal: step.goal, status: step.status, result: step.result ?? '',
        failureReason: step.failureReason ?? '', depth: 0, children: [] })),
    };
  }

  private publish(): void {
    if (this.closed) return;
    void this.pushState();
  }

  private async pushState(): Promise<void> {
    const task = this.task;
    await Promise.all([task ? this.push('/task', this.tree(task)) : Promise.resolve(), this.push('/task_list', this.taskList())]);
  }

  private addLog(phase: LogEntry['phase'], level: LogEntry['level'], content: string): void {
    this.logs.push({ timestamp: new Date(this.now()).toISOString(), phase, level, source: 'body', content });
    if (this.logs.length > MAX_PENDING_LOGS) this.logs.splice(0, this.logs.length - MAX_PENDING_LOGS);
    // Bursts go out together: the mod once dropped its connection under a flood of single-line posts.
    this.logTimer ??= setTimeout(() => this.flushLogs(), LOG_FLUSH_MS);
    this.logTimer.unref?.();
  }

  private flushLogs(): void {
    this.logTimer = undefined;
    if (this.closed || !this.logs.length) return;
    const batch = this.logs.splice(0);
    // One batch after another: the pusher keeps only the newest waiting body per route, which would drop log lines.
    this.logChain = this.logChain.then(() => this.push('/task_logs', { logs: batch }));
  }
}
