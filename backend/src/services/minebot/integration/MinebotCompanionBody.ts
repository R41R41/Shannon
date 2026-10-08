import type { CompanionBodyClient, CompanionReportCode, CompanionRequest } from './CompanionBodyClient.js';
import { CompanionRequestLoop, type CompanionRequestLoopOptions } from './CompanionRequestLoop.js';
import { CompanionRuntimeTasks, inventoryCounts, type CompanionTaskRuntime } from './CompanionRuntimeTasks.js';
import {
  companionBodyNow, othersOnline, speakCompanionReply, takeCompanionTurn, watchCompanionBodyEvents,
  type CompanionBodyBot,
} from './companionBodyParts.js';

/**
 * The production Minebot as Shannon's Minecraft body (docs/minebot-companion-body.md, shannon-ios
 * docs/minecraft-body-contract.md). Built by SkillAgent only while the bot is connected to the dedicated companion
 * world; on any other server the bot is as before. Her mind answers what a player writes to her and queues what the
 * owner asks of her body; this body says the reply, takes requests through the claim loop as tasks of its own
 * runtime, reports how they ended, and reports her death. When her mind cannot answer, the managed caller reports unavailable without starting a local task.
 */
export interface MinebotCompanionBodyBot extends CompanionBodyBot {
  entity?: unknown;
  inventory?: { items(): Array<{ name: string; count: number }> };
  on(event: 'message', listener: (message: any) => void): unknown;
  on(event: 'death' | 'end' | 'spawn', listener: () => void): unknown;
  once(event: 'end' | 'spawn', listener: () => void): unknown;
  removeListener(event: 'message', listener: (message: any) => void): unknown;
  removeListener(event: 'death' | 'end' | 'spawn', listener: () => void): unknown;
}

export interface MinebotCompanionBodyRuntime extends CompanionTaskRuntime {
  getTaskListState(): { tasks: Array<{ id: string; goal?: string; status: string }>; currentTaskId?: string | null };
}

export interface MinebotCompanionBodyOptions {
  serverId: string;
  /** Where her reply goes in the UI mod's chat tab (the current server's UI mod). */
  uiModBaseUrl: () => string;
  /** Game chat line length (the bot's MINECRAFT_CHAT_MAX_CHARS) and the most lines one reply may take. */
  lineLimit?: number;
  maxLines?: number;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
  loop?: CompanionRequestLoopOptions;
}

type CompanionTaskMetadata = { requestId?: string; player: string; answered: true };

/** What her body is asked to do is not chat: her mind has answered (and tells the owner how a request went). */
const REQUEST_CONTEXT = [
  'これはシャノンの心（アプリのシャノン）がオーナーから受けた頼みごとで、心はもう返事をしている。',
  'マイクラの体として頼まれたことだけを行い、終わったら完了にする。ゲーム内チャットで返事や報告はしない（結果は心が伝える）。',
].join('\n');
const answeredContext = (player: string) => [
  `${player} に頼まれたことで、シャノンの心がゲーム内チャットでもう返事をしている。`,
  'マイクラの体として頼まれたことだけを行う。もう一度返事はせず、終わった時かできなかった時だけ日本語の短い一言をチャットで伝える。',
].join('\n');

export class MinebotCompanionBody {
  private readonly tasks: CompanionRuntimeTasks;
  private readonly loop: CompanionRequestLoop;
  private readonly log: (line: string) => void;
  /** Tasks her mind gave this body (requests and game-chat intents), for the queue limit and her present. */
  private readonly companionTaskIds = new Set<string>();
  private readonly lastTool = new Map<string, string>();
  private events: ReturnType<typeof watchCompanionBodyEvents> | null = null;
  private deaths = 0;
  private started = false;
  private stopped = false;
  private readonly onDeathEvent = () => { this.deaths++; };
  private readonly onEnd = () => { void this.stop('run_over'); };
  private readonly onSpawn = () => { this.startLoop(); };

  constructor(private readonly bot: MinebotCompanionBodyBot, private readonly runtime: MinebotCompanionBodyRuntime,
    private readonly client: Pick<CompanionBodyClient, 'turn' | 'died' | 'claim' | 'progress' | 'report'>,
    private readonly options: MinebotCompanionBodyOptions) {
    this.log = options.log ?? (() => {});
    this.tasks = new CompanionRuntimeTasks(runtime, {
      refuse: () => this.stopped ? 'run_over' : null,
      waiting: () => this.waitingCompanionTasks(),
      envelope: request => this.envelope({ requestId: request.id, player: 'owner', answered: true }),
      deaths: () => this.deaths,
      step: taskId => this.runtime.getTaskListState().currentTaskId === taskId ? this.lastTool.get(taskId) : undefined,
      onToolStarting: (taskId, tool) => this.lastTool.set(taskId, tool),
      inventory: () => inventoryCounts(this.bot.inventory?.items()),
      onTaken: (request, result) => this.taken(request, result),
    });
    this.loop = new CompanionRequestLoop(client, this.tasks, { ...options.loop, log: line => this.log(`MINEBOT_${line}`) });
  }

  /** Starts watching her body and, once she is in the world, claiming requests. Stops by itself when the bot disconnects. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.events = watchCompanionBodyEvents(this.bot, { name: () => this.bot.username, onDeath: cause => this.died(cause) });
    this.bot.on('death', this.onDeathEvent);
    this.bot.once('end', this.onEnd);
    if (this.bot.entity) this.startLoop();
    else this.bot.once('spawn', this.onSpawn);
    this.log(`MINEBOT_COMPANION_STARTED ${JSON.stringify({ serverId: this.options.serverId })}`);
  }

  /** Open requests are reported as failed (`run_over`), and the claim ends. */
  async stop(code: CompanionReportCode = 'run_over'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.events?.dispose();
    this.bot.removeListener('death', this.onDeathEvent);
    this.bot.removeListener('end', this.onEnd);
    this.bot.removeListener('spawn', this.onSpawn);
    await this.loop.stop(code);
    this.log('MINEBOT_COMPANION_STOPPED');
  }

  /**
   * A player wrote to her (the speaker's UUID is from the player chat packet, or the UI mod's own client). True when
   * her mind answered; false when it could not, so the managed caller reports unavailable.
   */
  async answer(speaker: { uuid: string; name: string }, message: string): Promise<boolean> {
    if (this.stopped) return false;
    const outcome = await takeCompanionTurn(this.client,
      { speakerUuid: speaker.uuid, speakerName: speaker.name, message, body: this.bodyNow() },
      reply => speakCompanionReply(this.bot, reply, { uiModBaseUrl: this.options.uiModBaseUrl(),
        lineLimit: this.options.lineLimit, maxLines: this.options.maxLines, fetcher: this.options.fetcher }));
    if (outcome.kind === 'unavailable') {
      this.log(`MINEBOT_COMPANION_UNAVAILABLE ${JSON.stringify({ player: speaker.name })}`);
      return false;
    }
    this.log(`MINEBOT_COMPANION_REPLY ${JSON.stringify({ player: speaker.name, action: outcome.action, requestId: outcome.requestId })}`);
    if (outcome.action === 'task') this.queueAnswered(speaker.name, outcome.goal);
    else if (outcome.action === 'stop') this.stopCurrent();
    // `request`: queued on her mind; the claim loop takes it (one path for progress, stop and result).
    return true;
  }

  /** The runtime's executor tells how a run ended; a request's result is reported from it. */
  noteRun(envelope: { metadata?: Record<string, unknown> } | null | undefined, result: { taskTree?: { status?: string } | null } | null | undefined): void {
    const meta = envelope?.metadata?.companionTask as CompanionTaskMetadata | undefined;
    if (meta?.requestId) this.tasks.noteRun(meta.requestId, result?.taskTree?.status === 'completed');
  }

  /** What her body is doing now. Every production task is something someone asked for: busy with a request, or idle. */
  bodyNow() {
    const state = this.runtime.getTaskListState();
    const current = state.currentTaskId ? state.tasks.find(task => task.id === state.currentTaskId) : undefined;
    const busy = !!current && current.status === 'executing';
    return companionBodyNow(this.bot, { task: busy ? current?.goal : undefined, busyWith: busy ? 'request' : 'idle',
      recentAdvancements: this.events?.recentAdvancements ?? [] });
  }

  /** Requests taken through the claim (for status and tests). */
  get takenRequests(): CompanionRequestLoop['taken'] {
    return this.loop.taken;
  }

  private startLoop(): void {
    if (this.stopped) return;
    this.loop.start();
  }

  private died(cause: string): void {
    void this.client.died(cause, othersOnline(this.bot))
      .then(stored => this.log(`MINEBOT_COMPANION_DIED ${JSON.stringify({ cause, stored })}`));
  }

  private envelope(meta: CompanionTaskMetadata): { tags: string[]; metadata: Record<string, unknown> } {
    // What the owner asked through her mind is not this world's memory: her mind keeps the conversation.
    return { tags: ['companion_task'], metadata: { companionTask: meta, memoryDisabled: true,
      shannonCoreProjection: meta.requestId ? REQUEST_CONTEXT : answeredContext(meta.player) } };
  }

  private waitingCompanionTasks(): number {
    const tasks = this.runtime.getTaskListState().tasks;
    for (const id of this.companionTaskIds) if (!tasks.some(task => task.id === id)) { this.companionTaskIds.delete(id); this.lastTool.delete(id); }
    return tasks.filter(task => this.companionTaskIds.has(task.id) && ['pending', 'paused', 'executing'].includes(task.status)).length;
  }

  private put(goal: string, meta: CompanionTaskMetadata): { success: boolean; reason?: string; taskId?: string } {
    // The runtime may start the task before putTaskFirst returns its id: a skill started meanwhile is kept for it.
    let taskId: string | undefined;
    let early: string | undefined;
    const queued = this.runtime.putTaskFirst({ userMessage: goal,
      onToolStarting: tool => { if (taskId) this.lastTool.set(taskId, tool); else early = tool; } }, this.envelope(meta));
    taskId = queued.taskId;
    if (taskId && early) this.lastTool.set(taskId, early);
    if (queued.success && taskId) this.companionTaskIds.add(taskId);
    return queued;
  }

  /** Her mind answered in chat and asked her body to do it (no request queue on her mind's side). */
  private queueAnswered(player: string, goal: string): void {
    if (this.waitingCompanionTasks() >= 3) {
      this.log(`MINEBOT_COMPANION_TASK_DROPPED ${JSON.stringify({ player, reason: 'busy' })}`);
      return;
    }
    const queued = this.put(goal, { player, answered: true });
    this.log(queued.success ? `MINEBOT_COMPANION_TASK ${JSON.stringify({ player, taskId: queued.taskId })}`
      : `MINEBOT_COMPANION_TASK_DROPPED ${JSON.stringify({ player, reason: queued.reason ?? 'queue_refused' })}`);
  }

  /** The owner said stop: the task running now stops (her mind also asks every open request to stop). */
  private stopCurrent(): void {
    const current = this.runtime.getTaskListState().currentTaskId;
    if (current) this.runtime.removeTask(current);
  }

  private taken(request: CompanionRequest, result: { taskId: string } | { refused: CompanionReportCode; reason: string }): void {
    if ('taskId' in result) this.companionTaskIds.add(result.taskId);
    this.log(`MINEBOT_COMPANION_REQUEST ${JSON.stringify({ id: request.id, surface: request.surface,
      ...('taskId' in result ? { taskId: result.taskId } : { refused: result.refused, reason: result.reason }) })}`);
  }
}
