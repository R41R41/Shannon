import type { BodyPlanNode, BodyPlanView, BodyValue } from './bodyControlContract.js';
/** A plan as the bridge keeps it (the revision may be missing from an earlier draft of the head). */
type BodyPlanTree = Omit<BodyPlanView, 'revision'> & { revision?: number };
import type { CommonFcaObserver } from './controlLoop.js';
import type { MinecraftControlCommand as Command, MinecraftControlReceipt as Receipt } from './minecraftControlContract.js';
import { createUiModPusher } from '../uiModPush.js';
import { stepLabel, type StepLike } from '../../utils/actLabel.js';

/**
 * What the common FCA body shows ShannonUIMod (the task tab, the status card, the developer log).
 *
 * The task lives in the API: the body only receives commands, each carrying the task's goal and how far it has got
 * (`BodyTaskContext`). This watches those commands and their receipts and posts the same views the old task runtime
 * posted: `/task` (the task and its steps), `/task_list` (the queue, here at most the one task), `/task_logs`. It
 * only reads what the body already receives and sends best effort; the mod being absent or slow never reaches the body.
 *
 * With a plan (design mb-llm-centric 2.7: `BodyTaskContext.plan`) the task tab shows the plan tree nested
 * (`hierarchicalSubTasks` with `children`, as the mod v2 draws it), the node worked on now as `currentSubTaskId`, and the running
 * act's steps as that node's children ("the next moves"). Without one, the commands as a flat list, as before.
 */

/** A task with no command for this long is no longer shown as the current one (its steps stay on screen). */
const IDLE_MS = 120_000;
const MAX_STEPS = 12;
const MAX_TEXT = 160;
const LOG_FLUSH_MS = 500;
const MAX_PENDING_LOGS = 200;
/** What the mod is given of a plan: 64 nodes, 4 deep (the planner's own limits). */
const MAX_PLAN_NODES = 64;
const MAX_PLAN_DEPTH = 4;
/** The longest a node's where / doneWhen / note, and each of its forbid / caution lines, shown in the mod; how many lines. */
const MAX_NODE_TEXT = 120;
const MAX_RULE_TEXT = 80;
const MAX_RULES = 4;

type StepStatus = 'in_progress' | 'completed' | 'error';
type TreeStatus = StepStatus | 'pending';
interface Step { id: string; goal: string; status: StepStatus; result?: string; failureReason?: string }
interface ActStep { label: string; status: TreeStatus; detail: string }
interface Task {
  id: string; goal: string; condition: string; startedAt: number; touchedAt: number;
  status: 'in_progress' | 'completed' | 'aborted' | 'failed'; progress: string;
  steps: Step[]; running: Map<string, Step>; counter: number; current: boolean;
  plan?: BodyPlanTree;
  /** The latest act's steps (shown under the plan's current node), and the command it belongs to. */
  act?: { commandId: string; startedAt: number; steps: ActStep[] };
}
interface LogEntry { timestamp: string; phase: 'tool_call' | 'tool_result' | 'reflection'; level: 'info' | 'success' | 'warning' | 'error'; source: string; content: string }
export interface TreeNode {
  id: string; goal: string; status: TreeStatus; result: string; failureReason: string; depth: number; children: TreeNode[];
  /** A plan node's own words for the mod's tooltips (not on an act's steps), each only when the node has it. */
  where?: string; doneWhen?: string; note?: string; forbid?: string[]; caution?: string[];
}

export interface UiModBridgeOptions {
  /** The UI mod's origin (it differs per world, so it is read on every push). */
  baseUrl: () => string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** The body, for the act's step events (`minebotActStep`); absent, an act shows its steps as asked, without their progress. */
  source?: { on(event: string, listener: (...args: any[]) => void): unknown; removeListener?(event: string, listener: (...args: any[]) => void): unknown };
}

const clip = (text: unknown, max = MAX_TEXT): string => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const compact = (value: BodyValue | undefined): string => {
  if (value === undefined || value === null) return '';
  try { return clip(typeof value === 'string' ? value : JSON.stringify(value), 60); } catch { return ''; }
};

/** An act's hands from its arguments (hands, the contract's name; steps, an earlier draft's), or null. */
function actHands(args: unknown): Array<StepLike & { note?: string }> | null {
  const value = args as { hands?: unknown; steps?: unknown } | undefined;
  const list = Array.isArray(value?.hands) ? value!.hands : Array.isArray(value?.steps) ? value!.steps : null;
  return list as Array<StepLike & { note?: string }> | null;
}

/** The skill and its arguments in a few words, as a step of the task. */
export function describeCommand(command: Pick<Command, 'kind' | 'skill' | 'arguments' | 'operation'>): string {
  if (command.kind === 'skill') {
    const handsOf = actHands(command.arguments);
    if (command.skill === 'act' && handsOf) {
      const steps = handsOf;
      return clip(`act ${steps.length}手: ${steps.slice(0, 3).map(step => stepLabel(step)).join(' / ')}${steps.length > 3 ? ' …' : ''}`);
    }
    const args = Object.keys(command.arguments ?? {}).length ? ` ${compact(command.arguments as BodyValue)}` : '';
    return `${command.skill ?? 'skill'}${args}`;
  }
  if (command.kind === 'reflex') return `反射: ${clip(command.operation?.candidate.label ?? 'reflex', 60)}`;
  return command.kind;
}

/** The planner's state as the mod shows it: done completed, the current node in progress, continue and wait pending, blocked error. */
function planStatus(node: BodyPlanNode, current: string | null): TreeStatus {
  if (node.id === current && node.state !== 'done') return node.state === 'blocked' ? 'error' : 'in_progress';
  return node.state === 'done' ? 'completed' : node.state === 'blocked' ? 'error' : 'pending';
}

/** A plan node's text field, or nothing: a string with something in it. */
const nodeText = (value: unknown): string | undefined => (typeof value === 'string' ? clip(value, MAX_NODE_TEXT) || undefined : undefined);
/** A plan node's forbid / caution lines: the strings of the list with something in them, at most four. */
const nodeRules = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const lines = value.filter((line): line is string => typeof line === 'string').map(line => clip(line, MAX_RULE_TEXT)).filter(Boolean).slice(0, MAX_RULES);
  return lines.length ? lines : undefined;
};
/** The words of a plan node the mod's tooltips show, only those it has. */
function nodeWords(node: Pick<BodyPlanNode, 'where' | 'doneWhen' | 'note' | 'forbid' | 'caution'>)
  : Pick<TreeNode, 'where' | 'doneWhen' | 'note' | 'forbid' | 'caution'> {
  const where = nodeText(node.where), doneWhen = nodeText(node.doneWhen), note = nodeText(node.note), forbid = nodeRules(node.forbid), caution = nodeRules(node.caution);
  return { ...(where ? { where } : {}), ...(doneWhen ? { doneWhen } : {}), ...(note ? { note } : {}), ...(forbid ? { forbid } : {}), ...(caution ? { caution } : {}) };
}

/** A plan from the wire, kept only as far as it is well formed (ids, titles, parents that exist, no loop, the limits). */
export function sanitizePlan(raw: unknown): BodyPlanTree | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as BodyPlanTree).nodes)) return undefined;
  const states = new Set(['done', 'continue', 'wait', 'blocked']);
  const nodes: BodyPlanNode[] = [];
  const ids = new Set<string>();
  for (const value of (raw as BodyPlanTree).nodes) {
    if (nodes.length >= MAX_PLAN_NODES) break;
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || ids.has(value.id)) continue;
    ids.add(value.id);
    nodes.push({ id: clip(value.id, 64), parentId: typeof value.parentId === 'string' && value.parentId ? value.parentId : null,
      title: clip(value.title, 120) || value.id, state: states.has(value.state) ? value.state : 'continue',
      ...(typeof value.reason === 'string' && value.reason ? { reason: clip(value.reason, 120) } : {}), ...nodeWords(value) });
  }
  for (const node of nodes) if (node.parentId && !ids.has(node.parentId)) node.parentId = null;
  const current = typeof (raw as BodyPlanTree).current === 'string' && ids.has((raw as BodyPlanTree).current!) ? (raw as BodyPlanTree).current : null;
  const revision = Number((raw as BodyPlanTree).revision);
  return { ...(Number.isFinite(revision) ? { revision } : {}), current, nodes };
}

/**
 * The plan as the mod's nested tree: roots in order, each node's children under it (4 deep at most; a node deeper or in a loop is
 * left out), the act's steps as children of the current node. Pure, for the bridge and its tests.
 */
export function planTree(plan: BodyPlanTree, act?: { steps: ActStep[] }): TreeNode[] {
  const byParent = new Map<string | null, BodyPlanNode[]>();
  for (const node of plan.nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node); byParent.set(node.parentId, list);
  }
  const seen = new Set<string>();
  const build = (node: BodyPlanNode, depth: number): TreeNode => {
    seen.add(node.id);
    const children = depth + 1 < MAX_PLAN_DEPTH ? (byParent.get(node.id) ?? []).filter(child => !seen.has(child.id)).map(child => build(child, depth + 1)) : [];
    if (node.id === plan.current && act?.steps.length) {
      children.push(...act.steps.map((step, index) => ({ id: `${node.id}/act-${index + 1}`, goal: clip(`手${index + 1}: ${step.label}`, 100), status: step.status,
        result: step.status === 'completed' ? clip(step.detail, 120) : '', failureReason: step.status === 'error' ? clip(step.detail, 120) : '', depth: depth + 1, children: [] })));
    }
    return { id: node.id, goal: node.title, status: planStatus(node, plan.current), result: node.state === 'done' ? '済み' : '',
      failureReason: node.state === 'blocked' ? node.reason ?? '止まっている' : '', depth, children, ...nodeWords(node) };
  };
  return (byParent.get(null) ?? []).map(root => build(root, 0));
}

export class CommonFcaUiModBridge implements CommonFcaObserver {
  private task: Task | null = null;
  /** The reflex holding the body now (its command's id and label), or null. */
  private reflex: { id: string; label: string } | null = null;
  private logs: LogEntry[] = [];
  private logTimer?: ReturnType<typeof setTimeout>;
  private logChain: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly push: (route: string, value: unknown) => Promise<void>;
  private readonly now: () => number;
  private readonly onActStep = (event: { startedAt?: number; index?: number; status?: string; detail?: string }) => this.actStep(event);

  constructor(private readonly options: UiModBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.push = createUiModPusher(options.baseUrl, options.timeoutMs ?? 2000, options.fetcher, (route, status, value) => this.pushed(route, status, value));
  }

  /** Clears whatever the mod still shows from an earlier run and starts watching for an idle task. */
  start(): void {
    if (this.closed || this.idleTimer) return;
    this.idleTimer = setInterval(() => this.sweep(), 5000);
    this.idleTimer.unref();
    try { this.options.source?.on('minebotActStep', this.onActStep); } catch { /* the steps' progress is optional */ }
    void this.pushState();
  }

  stop(): void {
    this.closed = true;
    clearInterval(this.idleTimer); clearTimeout(this.logTimer);
    try { this.options.source?.removeListener?.('minebotActStep', this.onActStep); } catch { /* gone */ }
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
    if (command.kind === 'skill' && command.skill === 'act') {
      const steps = actHands(command.arguments) ?? [];
      task.act = { commandId: command.id, startedAt: this.now(), steps: steps.slice(0, 12).map(item => ({ label: clip(item.note ?? stepLabel(item), 60), status: 'pending' as TreeStatus, detail: '' })) };
    }
    if (command.kind === 'reflex') this.reflex = { id: command.id, label: clip(command.operation?.candidate.label ?? 'reflex', 60) };
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
    if (this.reflex?.id === command.id) this.reflex = null;
    const step = task?.running.get(command.id);
    if (task && step) {
      task.running.delete(command.id);
      step.status = ok ? 'completed' : 'error';
      step.result = clip(receipt.result);
      if (!ok) step.failureReason = clip(receipt.failureType ?? receipt.outcome);
      task.touchedAt = this.now();
    }
    // The act's steps that were still shown running end with the command: done when it was, else where it stopped.
    if (task?.act && task.act.commandId === command.id) {
      for (const item of task.act.steps) if (item.status === 'in_progress') item.status = ok ? 'completed' : 'error';
    }
    this.addLog('tool_result', ok ? 'success' : receipt.outcome === 'cancelled' ? 'warning' : 'error',
      `${describeCommand(command)} → ${receipt.outcome}${receipt.result ? `: ${clip(receipt.result)}` : ''}`);
    this.publish();
  }

  /** An act's step began, made progress, or ended (`minebotActStep` from the body). */
  actStep(event: { startedAt?: number; index?: number; status?: string; detail?: string }): void {
    const act = this.task?.act;
    if (this.closed || !act || typeof event?.index !== 'number' || !act.steps[event.index]) return;
    const step = act.steps[event.index];
    if (event.status === 'in_progress' || event.status === 'completed' || event.status === 'error') step.status = event.status;
    step.detail = clip(event.detail, 120);
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
      this.reflex = null;
      this.task = task;
    }
    task.goal = clip(context.goal) || task.goal;
    task.condition = clip(context.completionCondition) || task.condition;
    task.progress = clip(context.taskState?.progress) || task.progress;
    // The newest plan by its revision (a command carrying an older one, delivered late, does not take it back).
    const plan = sanitizePlan(context.plan);
    if (plan && !(typeof plan.revision === 'number' && typeof task.plan?.revision === 'number' && plan.revision < task.plan.revision)) task.plan = plan;
    task.status = 'in_progress'; task.current = true; task.touchedAt = this.now();
    return task;
  }

  private finish(task: Task, status: Task['status']): void {
    for (const step of task.running.values()) step.status = 'error';
    task.running.clear();
    this.reflex = null;
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
    if (task.plan && task.plan.nodes.length) {
      return {
        goal: task.goal, strategy: task.condition, status: task.status, currentThinking: task.progress,
        currentSubTaskId: task.plan.current,
        ...(typeof task.plan.revision === 'number' ? { planRevision: task.plan.revision } : {}),
        hierarchicalSubTasks: planTree(task.plan, task.act),
        activeReflex: this.reflex?.label ?? null,
      };
    }
    const running = [...task.running.values()].at(-1);
    return {
      goal: task.goal, strategy: task.condition, status: task.status, currentThinking: task.progress,
      currentSubTaskId: running?.id ?? null,
      hierarchicalSubTasks: task.steps.map(step => ({ id: step.id, goal: step.goal, status: step.status, result: step.result ?? '',
        failureReason: step.failureReason ?? '', depth: 0, children: [] })),
      activeReflex: this.reflex?.label ?? null,
    };
  }

  private publish(): void {
    if (this.closed) return;
    void this.pushState();
  }

  /**
   * dragon26: what was sent to the mod and whether it arrived, in one line (the mod's display was said to lag the plan and nothing recorded what
   * the body had sent). `/task` only (the tree and list change many times a second): a line when the plan revision, its current node or the
   * mod's answer changed, and at most one failure line every 10 seconds. No text of the plan, only its revision and current node's id.
   */
  private lastPush = { key: '', failedAt: 0 };
  private pushed(route: string, status: number | null, value: unknown): void {
    if (route !== '/task' || !this.options.log) return;
    const tree = value as { planRevision?: unknown; currentSubTaskId?: unknown; status?: unknown } | null;
    const ok = typeof status === 'number' && status >= 200 && status < 300;
    const revision = typeof tree?.planRevision === 'number' ? tree.planRevision : '-';
    const current = typeof tree?.currentSubTaskId === 'string' ? clip(tree.currentSubTaskId, 40) : '-';
    const key = `${ok}|${status}|${revision}|${current}`;
    const now = this.now();
    if (key === this.lastPush.key || (!ok && now - this.lastPush.failedAt < 10_000)) return;
    this.lastPush = { key, failedAt: ok ? this.lastPush.failedAt : now };
    try { this.options.log(`UI_MOD push /task ok=${ok ? 1 : 0} status=${status ?? 'none'} revision=${revision} current=${current} task=${clip(this.task?.id ?? '-', 12)}`); } catch { /* a log never fails a push */ }
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
