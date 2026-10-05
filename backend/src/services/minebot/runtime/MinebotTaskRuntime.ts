import { minecraftContextKey, minecraftConversationKeys } from '../../../modules/memory/minecraftIdentity.js';
import { scanLoadedBlocks } from '../utils/loadedBlockScan.js';
import { minecraftMemoryContext, validateMinecraftEnvelope, assertMinecraftContinuation, assertMinecraftConnected } from './memoryContext.js';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { MinecraftInventoryEntry, RequestEnvelope } from '@shannon/common';
import { createEnvelope } from '../../common/adapters/envelopeFactory.js';
import { createLogger } from '../../../utils/logger.js';
import type {
  TaskListState,
  TaskQueueEntry,
  TaskStateInput,
  MinecraftTaskCheckpoint,
  MinecraftToolFinishedEvent,
} from '../../llm/graph/types.js';
import { GRAPH_CONFIG } from '../../llm/graph/types.js';
import type { TaskTreeState } from '@shannon/common';
import type { CustomBot } from '../types.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { mapBotInventoryItems } from '../utils/inventorySnapshot.js';
import { hasActiveSafetyLease } from '../execution/ActionExecution.js';

const log = createLogger('Minebot:TaskRuntime');

type UnifiedExecutor = (
  envelope: RequestEnvelope,
  messages?: BaseMessage[],
  options?: {
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onToolFinished?: (event: MinecraftToolFinishedEvent) => void;
    onCheckpoint?: (checkpoint: MinecraftTaskCheckpoint) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    onRequestSkillInterrupt?: () => void;
    getLiveInventory?: () => MinecraftInventoryEntry[];
    getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
    abortSignal?: AbortSignal;
  },
) => Promise<any>;

export class MinebotTaskRuntime {
  private bot: CustomBot;
  private taskQueue: TaskQueueEntry[] = [];
  private emergencyTask: TaskQueueEntry | null = null;
  private isEmergencyMode = false;
  private preemptedRuns = new Set<number>();
  private runGeneration = 0;
  private activeRunGeneration = 0;
  private taskRunGenerations = new Map<string, number>();
  private activeTaskInput: TaskStateInput | null = null;
  private isExecuting = false;
  private abortController: AbortController | null = null;
  private onTaskListUpdate: ((tasks: TaskListState) => void) | null = null;
  private executor: UnifiedExecutor | null = null;
  /** Tasks put ahead of the queue by putTaskFirst, still in it; later ones line up behind them. */
  private firstTaskIds = new Set<string>();
  /** Queue tasks paused by putTaskFirst; their cancelled run must not count as their end. */
  private yieldedTaskIds = new Set<string>();

  public currentState: {
    taskId: string;
    memoryContextKey?: string | null;
    createdAt: number;
    forceStop: boolean;
    retryBudget: number;
    recoveryStatus: 'idle' | 'retrying' | 'awaiting_user' | 'failed_terminal';
    humanFeedback?: string;
    humanFeedbackPending?: boolean;
    taskTree?: TaskTreeState;
    graphResult?: any;
    /** MAX_ITERATIONS 到達時の Anthropic 会話履歴（再開に使用） */
    savedMessages?: unknown[];
    /** LLM管理型タスクツリーのノード（再開に使用） */
    savedTaskNodes?: unknown[];
    /** Run-scoped WorldFrame / ActionReceipt / Jev critic state. */
    savedCognitiveWorkspace?: unknown;
  } | null = null;

  constructor(bot: CustomBot) {
    this.bot = bot;
  }

  public setExecutor(executor: UnifiedExecutor): void {
    this.executor = executor;
  }

  public isReady(): boolean {
    return this.executor !== null;
  }

  public async invoke(partialState: TaskStateInput) {
    assertMinecraftConnected(this.bot);
    if (this.isExecuting) {
      if (partialState.envelope) assertMinecraftContinuation(this.currentState?.memoryContextKey, partialState.envelope, this.bot);
      else if (this.currentState?.memoryContextKey !== minecraftContextKey(minecraftMemoryContext(this.bot))) throw new Error('MINECRAFT_MEMORY_CONTEXT_CHANGED');
      // タスク実行中にユーザーからメッセージが来たら、フィードバックとして注入
      if (partialState.userMessage) {
        log.info(`💬 タスク実行中にフィードバック受付: "${partialState.userMessage.substring(0, 50)}"`);
        this.updateHumanFeedback(partialState.userMessage);
      }
      return null;
    }

    if (!this.executor) {
      log.error('MinebotTaskRuntime executor is not configured');
      return null;
    }

    this.isExecuting = true;
    this.abortController = new AbortController();
    const runGeneration = ++this.runGeneration;
    this.activeRunGeneration = runGeneration;
    const ownsCurrentRun = () => this.activeRunGeneration === runGeneration;

    if (partialState.isEmergency) {
      this.bot.suppressMinebotGameChat = true;
      this.bot.minebotControlState = 'emergency_llm';
    } else {
      this.bot.suppressMinebotGameChat = false;
      this.bot.minebotControlState = 'main_task';
    }

    const taskId = partialState.taskId ?? crypto.randomUUID();
    const createdAt = Date.now();
    if (!partialState.isEmergency) this.activeTaskInput = { ...partialState, taskId };
    if (this.taskQueue.some(task => task.id === taskId && task.status === 'executing')) {
      this.taskRunGenerations.set(taskId, runGeneration);
    }
    let requestMemoryKey: string | null = null;
    let removeContextListeners = () => {};
    this.currentState = {
      taskId,
      createdAt,
      forceStop: false,
      retryBudget: 2,
      recoveryStatus: 'idle',
      taskTree: partialState.taskTree ?? {
        status: 'in_progress',
        goal: partialState.userMessage ?? '',
        strategy: '',
        hierarchicalSubTasks: [],
        currentSubTaskId: null,
        subTasks: null,
      },
    };
    this.notifyTaskListUpdate();

    try {
      const envelope = this.taskInputToEnvelope(partialState);
      requestMemoryKey = envelope.metadata?.memoryDisabled === true ? null : minecraftContextKey(envelope.minecraft);
      this.currentState.memoryContextKey = requestMemoryKey;
      // A dimension transition/disconnect invalidates the physical context of this execution.
      const controller = this.abortController;
      const onDisconnect = () => controller?.abort();
      const onRespawn = () => {
        if (minecraftContextKey(envelope.minecraft) !== minecraftContextKey(minecraftMemoryContext(this.bot))) controller?.abort();
      };
      this.bot.on('end', onDisconnect);
      this.bot.on('kicked', onDisconnect);
      this.bot.on('respawn', onRespawn);
      removeContextListeners = () => {
        this.bot.removeListener('end', onDisconnect);
        this.bot.removeListener('kicked', onDisconnect);
        this.bot.removeListener('respawn', onRespawn);
      };
      // ShannonExecutor がタスク実行中にユーザーフィードバックを取得できるようにする
      (envelope as any).metadata = {
        ...(envelope as any).metadata,
        getHumanFeedback: () => {
          if (ownsCurrentRun() && this.currentState?.humanFeedbackPending && this.currentState?.humanFeedback) {
            const fb = this.currentState.humanFeedback;
            this.currentState.humanFeedback = undefined;
            this.currentState.humanFeedbackPending = false;
            this.bot.interruptExecution = false;
            return fb;
          }
          return null;
        },
      };
      const messages = [...(partialState.messages ?? [])];
      if (partialState.userMessage && messages.length === 0) {
        messages.push(new HumanMessage(partialState.userMessage));
      }

      const graphResult = await this.executor(envelope, messages, {
        onToolStarting: (name, args) => {
          if (ownsCurrentRun() && !controller?.signal.aborted) partialState.onToolStarting?.(name, args);
        },
        onToolFinished: event => {
          if (ownsCurrentRun() && !controller?.signal.aborted) partialState.onToolFinished?.(event);
        },
        onCheckpoint: checkpoint => this.handleExecutionCheckpoint(taskId, runGeneration, checkpoint),
        onTaskTreeUpdate: (taskTree) => {
          if (ownsCurrentRun()) this.handleTaskTreeUpdate(taskId, taskTree);
        },
        onRequestSkillInterrupt: () => {
          if (!ownsCurrentRun() || controller?.signal.aborted) return;
          this.bot.interruptExecution = true;
          log.warn('⚡ MetaCognition からスキル中断要求 → bot.interruptExecution = true');
        },
        getLiveInventory: () => mapBotInventoryItems(this.bot.inventory?.items() ?? []),
        getActiveEffects: () => {
          const effects = (this.bot as any).activeEffects as Array<{ name: string; amplifier: number }> | undefined;
          return effects ?? [];
        },
        abortSignal: this.abortController?.signal,
      });
      if (controller?.signal.aborted && this.preemptedRuns.has(runGeneration)) {
        this.handleExecutionCheckpoint(taskId, runGeneration, {
          messages: graphResult?.savedMessages ?? [],
          taskNodes: graphResult?.savedTaskNodes ?? [],
          cognitiveWorkspace: graphResult?.savedCognitiveWorkspace,
        });
      }
      if (controller?.signal.aborted) throw new Error('MINECRAFT_TASK_CONTEXT_CANCELLED');
      if (!ownsCurrentRun()) return null;

      const taskTree =
        this.currentState?.forceStop
          ? {
              ...(graphResult?.taskTree ?? this.currentState?.taskTree ?? {}),
              status: 'error',
              error: 'Task force-stopped',
            }
          : (graphResult?.taskTree ?? this.currentState?.taskTree);

      this.currentState = {
        taskId,
        memoryContextKey: requestMemoryKey,
        createdAt,
        forceStop: this.currentState?.forceStop ?? false,
        retryBudget: this.currentState?.retryBudget ?? 2,
        recoveryStatus: this.deriveRecoveryStatus(graphResult),
        taskTree,
        graphResult,
        savedMessages: graphResult?.savedMessages,
        savedTaskNodes: graphResult?.savedTaskNodes,
        savedCognitiveWorkspace: graphResult?.savedCognitiveWorkspace,
      };
      this.notifyTaskListUpdate();

      return this.currentState;
    } catch (error) {
      // 緊急プリエンプションによる中断の場合はエラー扱いにしない（paused タスクを保全）
      if (this.preemptedRuns.has(runGeneration)) {
        log.info('♻️ タスクは緊急プリエンプションにより中断 — 緊急タスク完了後に再開予定');
        this.preemptedRuns.delete(runGeneration);
        if (!ownsCurrentRun()) return null;
        this.currentState = {
          taskId,
          memoryContextKey: requestMemoryKey,
          createdAt,
          forceStop: true,
          retryBudget: this.currentState?.retryBudget ?? 2,
          recoveryStatus: 'idle',
          savedMessages: this.currentState?.savedMessages,
          savedTaskNodes: this.currentState?.savedTaskNodes,
          savedCognitiveWorkspace: this.currentState?.savedCognitiveWorkspace,
          taskTree: this.currentState?.taskTree ?? {
            status: 'in_progress',
            goal: partialState.userMessage ?? 'Task',
            strategy: '',
            subTasks: null,
          },
        };
        this.notifyTaskListUpdate();
        return this.currentState;
      }

      if (!ownsCurrentRun()) return null;

      log.error('Task execution error', error);
      this.currentState = {
        taskId,
        memoryContextKey: requestMemoryKey,
        createdAt,
        forceStop: this.currentState?.forceStop ?? false,
        retryBudget: this.currentState?.retryBudget ?? 2,
        recoveryStatus: 'failed_terminal',
        taskTree: {
          status: 'error',
          goal: partialState.userMessage ?? 'Task',
          strategy: '',
          subTasks: null,
          error: error instanceof Error ? error.message : 'unknown error',
        },
      };
      this.notifyTaskListUpdate();
      return this.currentState;
    } finally {
      removeContextListeners();
      this.preemptedRuns.delete(runGeneration);
      if (ownsCurrentRun()) {
        this.isExecuting = false;
        this.abortController = null;
        if (!partialState.isEmergency) this.activeTaskInput = null;
        this.bot.suppressMinebotGameChat = false;
        this.bot.minebotControlState = 'idle';

      // A preempted main task must leave emergency mode owned by the emergency
      // handler. Clearing it here would restart the paused task before the
      // emergency executor has taken control.
      // Emergency ownership is released only by resumePreviousTask after
      // native clearance. An unsuccessful model run must leave the main task paused.
        if (partialState.isEmergency && this.isEmergencyMode) {
          this.bot.minebotControlState = 'emergency_reflect';
        }

        const hasPendingTasks = this.taskQueue.some(
          (task) => task.status === 'pending' || task.status === 'paused',
        );
        if (hasPendingTasks && !this.isEmergencyMode) {
          setTimeout(() => {
            void this.executeNextTask();
          }, 500);
        }
        this.notifyTaskListUpdate();
      }
    }
  }

  public forceStop(options: { preserveSafetyLease?: boolean } = {}): void {
    if (this.currentState) {
      this.currentState.forceStop = true;
    }
    // An emergency may arrive after an independent critical ConstantSkill has
    // already taken the motor lease. Abort this task, not that live safety
    // action: blanket control clearing and the legacy interrupt bit would
    // otherwise cancel its jump/movement on the next 50 ms action poll.
    if (!(options.preserveSafetyLease && hasActiveSafetyLease(this.bot))) this.stopBotActions();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  public updateHumanFeedback(feedback: string): void {
    if (!this.currentState) {
      return;
    }
    this.currentState.humanFeedback = feedback;
    this.currentState.humanFeedbackPending = true;
    this.bot.interruptExecution = true;
  }

  public async resumeAwaitingUserTask(
    feedback: string,
    overrides: {
      envelope: RequestEnvelope;
      messages: BaseMessage[];
      environmentState?: string | null;
      selfState?: string | null;
      onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    },
  ): Promise<any | null> {
    const awaitingTask = this.taskQueue.find((task) => task.status === 'awaiting_user');

    if (awaitingTask) {
      const previous = awaitingTask.state.envelope;
      assertMinecraftContinuation(previous?.metadata?.memoryDisabled === true ? null : minecraftContextKey(previous?.minecraft), overrides.envelope, this.bot);
      const goal = awaitingTask.taskTree?.goal || awaitingTask.state.userMessage || 'Task';
      awaitingTask.status = 'pending';
      awaitingTask.state = {
        ...awaitingTask.state,
        taskId: awaitingTask.id,
        envelope: {
          ...overrides.envelope,
          text: this.buildContinuationPrompt(goal, feedback),
        },
        userMessage: this.buildContinuationPrompt(goal, feedback),
        messages: overrides.messages,
        environmentState: overrides.environmentState ?? null,
        selfState: overrides.selfState ?? null,
        humanFeedback: feedback,
        taskTree: awaitingTask.taskTree ?? awaitingTask.state.taskTree ?? null,
        onToolStarting: overrides.onToolStarting,
      };
      this.notifyTaskListUpdate();

      if (!this.isExecuting && !this.isEmergencyMode) {
        await this.executeNextTask();
      }
      return this.currentState;
    }

    if (this.currentState?.recoveryStatus !== 'awaiting_user') {
      return null;
    }

    assertMinecraftContinuation(this.currentState.memoryContextKey, overrides.envelope, this.bot);
    const goal = this.currentState.taskTree?.goal || 'Task';
    const savedMessages = this.currentState.savedMessages;
    const savedTaskNodes = this.currentState.savedTaskNodes;
    const savedCognitiveWorkspace = this.currentState.savedCognitiveWorkspace;

    const envelopeForResume: RequestEnvelope = {
      ...overrides.envelope,
      text: this.buildContinuationPrompt(goal, feedback),
    };
    const resumeMetadata: Record<string, unknown> = {
      ...((envelopeForResume as any).metadata ?? {}),
    };
    if (savedMessages && savedMessages.length > 0) {
      resumeMetadata.previousMessages = savedMessages;
      log.info(`♻️ MAX_ITERATIONS 再開: ${savedMessages.length} messages を引き継ぎ`);
    }
    if (savedTaskNodes && savedTaskNodes.length > 0) {
      resumeMetadata.previousTaskNodes = savedTaskNodes;
      log.info(`🌳 MAX_ITERATIONS 再開: ${savedTaskNodes.length} タスクノードを引き継ぎ`);
    }
    if (savedCognitiveWorkspace) {
      resumeMetadata.previousCognitiveWorkspace = savedCognitiveWorkspace;
      log.info('🧭 MAX_ITERATIONS 再開: cognitive workspace を引き継ぎ');
    }
    (envelopeForResume as any).metadata = resumeMetadata;

    return this.invoke({
      taskId: this.currentState.taskId,
      envelope: envelopeForResume,
      userMessage: this.buildContinuationPrompt(goal, feedback),
      messages: overrides.messages,
      environmentState: overrides.environmentState ?? null,
      selfState: overrides.selfState ?? null,
      humanFeedback: feedback,
      taskTree: this.currentState.taskTree ?? null,
      onToolStarting: overrides.onToolStarting,
    });
  }

  /** Continue a bounded autonomous campaign turn without inventing user feedback. */
  public async resumeAwaitingCampaignTask(taskId: string, expectedGoal: string): Promise<boolean> {
    if (this.isExecuting || this.isEmergencyMode) return false;
    const task = this.taskQueue.find(entry => entry.id === taskId && entry.status === 'awaiting_user');
    if (!task || task.state.isEmergency || task.state.userMessage !== expectedGoal ||
      task.state.envelope?.text !== expectedGoal) return false;
    // Reuse the original user objective and audience. This throws if the bot
    // reconnected into another world rather than silently moving a campaign.
    this.taskInputToEnvelope(task.state);
    task.status = 'pending';
    this.notifyTaskListUpdate();
    void this.executeNextTask();
    return true;
  }

  public isRunning(): boolean {
    return this.isExecuting;
  }

  public isInEmergencyMode(): boolean {
    return this.isEmergencyMode;
  }

  public async interruptForEmergency(_message: string): Promise<void> {
    let executingTask = this.taskQueue.find((task) => task.status === 'executing');
    if (!executingTask && this.isExecuting && this.currentState && this.activeTaskInput) {
      // SkillAgent's direct chat path does not enter the queue. Preserve its
      // exact original objective and envelope so it can resume after danger.
      executingTask = {
        id: this.currentState.taskId, createdAt: this.currentState.createdAt,
        state: { ...this.activeTaskInput, taskId: this.currentState.taskId },
        taskTree: this.currentState.taskTree ?? null, status: 'executing',
      };
      this.taskQueue.unshift(executingTask);
      this.taskRunGenerations.set(executingTask.id, this.activeRunGeneration);
    }
    if (executingTask) {
      executingTask.status = 'paused';
      executingTask.taskTree = (this.currentState?.taskTree as any) ?? executingTask.taskTree;
      executingTask.state.taskTree = executingTask.taskTree;
      if (this.currentState?.savedMessages?.length || this.currentState?.savedTaskNodes?.length ||
        this.currentState?.savedCognitiveWorkspace) {
        executingTask.state.continuationCheckpoint = {
          messages: this.currentState.savedMessages ?? [],
          taskNodes: this.currentState.savedTaskNodes ?? [],
          cognitiveWorkspace: this.currentState.savedCognitiveWorkspace,
        };
      }
    }
    this.activeTaskInput = null;

    this.isEmergencyMode = true;
    if (this.isExecuting) {
      this.preemptedRuns.add(this.activeRunGeneration);
      this.forceStop({ preserveSafetyLease: true });

      // forceStop() は AbortController.abort() するが、FCA の実行ループが
      // 実際に終了して isExecuting = false になるまでラグがある。
      // 緊急タスクの invoke() が拒否されないよう、解除を待つ。
      // AbortSignal は非同期ループの各イテレーション境界でしか効かないため、
      // pathfinder 等の同期ブロック中はこの待ちでも終わらないことがある。その場合のみ最後の手段で強制クリアする。
      const deadline = Date.now() + CONFIG.EMERGENCY_INTERRUPT_WAIT_MS;
      while (this.isExecuting && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (this.isExecuting) {
        log.warn(
          `⚡ タスクが ${CONFIG.EMERGENCY_INTERRUPT_WAIT_MS}ms 以内に停止しなかったため旧runを隔離して緊急runへ所有権移譲`,
        );
        // The old executor may still settle later. Its generation is fenced
        // from currentState, abortController, control state and queue completion.
        this.isExecuting = false;
        this.abortController = null;
      }
    }
    this.notifyTaskListUpdate();
  }

  public setEmergencyTask(taskInput: TaskStateInput): void {
    const goal = taskInput.userMessage || 'Emergency';
    this.emergencyTask = {
      id: crypto.randomUUID(),
      taskTree: { goal, status: 'executing' } as any,
      state: taskInput,
      createdAt: Date.now(),
      status: 'executing',
    };
    this.notifyTaskListUpdate();
  }

  public async resumePreviousTask(): Promise<void> {
    this.emergencyTask = null;
    this.isEmergencyMode = false;
    this.notifyTaskListUpdate();

    if (!this.isExecuting) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.executeNextTask();
    }
  }

  public addTaskToQueue(
    taskInput: TaskStateInput,
  ): { success: boolean; reason?: string; taskId?: string } {
    if (this.taskQueue.length >= GRAPH_CONFIG.MAX_QUEUE_SIZE) {
      return {
        success: false,
        reason: 'タスクキューがいっぱいです。既存のタスクを削除してから新しいタスクを追加してください。',
      };
    }

    try {
      taskInput = { ...taskInput, envelope: this.taskInputToEnvelope(taskInput) };
    } catch {
      return { success: false, reason: 'Minecraft memory context is unavailable or changed' };
    }
    const taskId = crypto.randomUUID();
    const task: TaskQueueEntry = {
      id: taskId,
      taskTree:
        taskInput.taskTree ||
        ({ goal: taskInput.userMessage || 'New Task', status: 'pending' } as any),
      state: {
        ...taskInput,
        taskId,
      },
      createdAt: Date.now(),
      status: 'pending',
    };

    this.taskQueue.push(task);
    this.notifyTaskListUpdate();

    if (this.taskQueue.length === 1 && !this.isExecuting && !this.isEmergencyMode) {
      void this.executeNextTask();
    }

    return { success: true, taskId };
  }

  /**
   * Runs a task before the queue task in progress, as when a person speaks to the bot during a long task.
   * The running task is paused with its last checkpoint, as for an emergency, and resumes from there once
   * this one is over. An emergency in progress is not interrupted; the task waits for it.
   */
  public putTaskFirst(
    taskInput: TaskStateInput,
    envelopeExtras: { tags?: string[]; metadata?: Record<string, unknown> } = {},
  ): { success: boolean; reason?: string; taskId?: string } {
    if (this.taskQueue.length >= GRAPH_CONFIG.MAX_QUEUE_SIZE) {
      return { success: false, reason: 'タスクキューがいっぱいです。' };
    }
    let envelope: RequestEnvelope;
    try {
      envelope = this.taskInputToEnvelope(taskInput);
    } catch {
      return { success: false, reason: 'Minecraft memory context is unavailable or changed' };
    }
    envelope.tags = [...new Set([...envelope.tags, ...(envelopeExtras.tags ?? [])])];
    envelope.metadata = { ...envelope.metadata, ...envelopeExtras.metadata };
    const taskId = crypto.randomUUID();
    const task: TaskQueueEntry = {
      id: taskId,
      taskTree: taskInput.taskTree || ({ goal: taskInput.userMessage || 'New Task', status: 'pending' } as any),
      state: { ...taskInput, envelope, taskId },
      createdAt: Date.now(),
      status: 'pending',
    };
    for (const id of this.firstTaskIds) if (!this.taskQueue.some(entry => entry.id === id)) this.firstTaskIds.delete(id);
    let index = 0;
    while (index < this.taskQueue.length && this.firstTaskIds.has(this.taskQueue[index].id)) index++;
    this.taskQueue.splice(index, 0, task);
    this.firstTaskIds.add(taskId);

    const running = this.taskQueue.find(entry => entry.status === 'executing');
    if (running && !this.firstTaskIds.has(running.id) && this.isExecuting && !this.isEmergencyMode
      && this.taskRunGenerations.get(running.id) === this.activeRunGeneration) {
      running.status = 'paused';
      running.taskTree = (this.currentState?.taskTree as any) ?? running.taskTree;
      running.state.taskTree = running.taskTree;
      if (this.currentState?.savedMessages?.length || this.currentState?.savedTaskNodes?.length ||
        this.currentState?.savedCognitiveWorkspace) {
        running.state.continuationCheckpoint = {
          messages: this.currentState.savedMessages ?? [],
          taskNodes: this.currentState.savedTaskNodes ?? [],
          cognitiveWorkspace: this.currentState.savedCognitiveWorkspace,
        };
      }
      this.yieldedTaskIds.add(running.id);
      this.activeTaskInput = null;
      this.preemptedRuns.add(this.activeRunGeneration);
      // The next task starts once this run has wound down (invoke's own end picks it up).
      this.forceStop({ preserveSafetyLease: true });
    }
    this.notifyTaskListUpdate();
    if (!this.isExecuting && !this.isEmergencyMode) void this.executeNextTask();
    return { success: true, taskId };
  }

  public removeTask(taskId: string): { success: boolean; reason?: string } {
    if (this.emergencyTask?.id === taskId) {
      this.emergencyTask = null;
      this.isEmergencyMode = false;
      if (this.isExecuting) {
        this.forceStop();
      }
      this.notifyTaskListUpdate();
      void this.executeNextTask();
      return { success: true };
    }

    // currentState に直接保持されているタスク（taskQueue に入っていないケース）
    if (this.currentState?.taskId === taskId) {
      // forceStop() は currentState.forceStop フラグを参照するため、
      // currentState をクリアする前に呼ぶ必要がある
      if (this.isExecuting) {
        this.forceStop();
      }
      this.currentState = null;
      // taskQueue にも存在する場合は併せて削除
      const qIdx = this.taskQueue.findIndex((task) => task.id === taskId);
      if (qIdx !== -1) {
        this.taskQueue.splice(qIdx, 1);
      }
      this.taskRunGenerations.delete(taskId);
      this.notifyTaskListUpdate();
      if (!this.isEmergencyMode) {
        void this.executeNextTask();
      }
      return { success: true };
    }

    const taskIndex = this.taskQueue.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) {
      return { success: false, reason: 'タスクが見つかりません' };
    }

    const task = this.taskQueue[taskIndex];
    const wasExecuting = task.status === 'executing';
    this.taskQueue.splice(taskIndex, 1);
    this.taskRunGenerations.delete(taskId);

    if (wasExecuting && this.isExecuting) {
      this.forceStop();
    }

    this.notifyTaskListUpdate();

    if (!wasExecuting && !this.isExecuting && !this.isEmergencyMode) {
      const hasPendingTasks = this.taskQueue.some(
        (entry) => entry.status === 'pending' || entry.status === 'paused',
      );
      if (hasPendingTasks) {
        void this.executeNextTask();
      }
    }

    return { success: true };
  }

  public prioritizeTask(taskId: string): { success: boolean; reason?: string } {
    const taskIndex = this.taskQueue.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) {
      return { success: false, reason: 'タスクが見つかりません' };
    }

    if (taskIndex === 0 && this.taskQueue[0]?.status === 'executing') {
      return { success: false, reason: 'このタスクは既に実行中です' };
    }

    const task = this.taskQueue[taskIndex];
    const executingTask = this.taskQueue.find((entry) => entry.status === 'executing');
    if (executingTask) {
      executingTask.status = 'paused';
      executingTask.taskTree = (this.currentState?.taskTree as any) ?? executingTask.taskTree;
      if (this.isExecuting) {
        this.forceStop();
      }
    }

    this.taskQueue.splice(taskIndex, 1);
    this.taskQueue.unshift(task);
    this.notifyTaskListUpdate();

    if (!this.isEmergencyMode && !this.isExecuting) {
      void this.executeNextTask();
    }

    return { success: true };
  }

  public failCurrentTaskDueToDeath(deathReason: string): void {
    if (this.currentState?.taskTree) {
      this.currentState.taskTree.status = 'error';
      this.currentState.taskTree.error = `死亡によりタスク失敗: ${deathReason}`;
    }

    this.forceStop();
    this.isEmergencyMode = false;
    this.emergencyTask = null;

    const executingIndex = this.taskQueue.findIndex((task) => task.status === 'executing');
    if (executingIndex !== -1) {
      this.taskRunGenerations.delete(this.taskQueue[executingIndex].id);
      this.taskQueue.splice(executingIndex, 1);
    }

    this.notifyTaskListUpdate();
  }

  public getTaskListState(): TaskListState {
    const queuedTasks = this.taskQueue.map((task) => ({
      id: task.id,
      goal: task.taskTree?.goal || 'Unknown',
      status: task.status,
      createdAt: task.createdAt,
      recoveryStatus: this.mapTaskStatusToRecoveryStatus(task.status),
      recoveryAttempts: (task.taskTree as any)?.recoveryAttempts ?? undefined,
      retryBudget: (task.taskTree as any)?.retryBudget ?? undefined,
      lastFailureType: (task.taskTree as any)?.lastFailureType ?? null,
    }));

    const currentTaskExistsInQueue =
      !!this.currentState &&
      queuedTasks.some((task) => task.id === this.currentState?.taskId);

    const shouldShowDirectTask = !!this.currentState && !currentTaskExistsInQueue && (
      this.isExecuting ||
      this.currentState.recoveryStatus === 'awaiting_user' ||
      this.currentState.recoveryStatus === 'failed_terminal'
    );

    const activeDirectTask =
      shouldShowDirectTask && this.currentState
        ? [{
            id: this.currentState.taskId,
            goal: this.currentState.taskTree?.goal || 'Unknown',
            status: this.mapRecoveryStatusToTaskStatus(this.currentState.recoveryStatus),
            createdAt: this.currentState.createdAt,
            recoveryStatus: this.currentState.recoveryStatus,
            recoveryAttempts: this.currentState.taskTree?.recoveryAttempts ?? undefined,
            retryBudget: this.currentState.retryBudget,
            lastFailureType: this.currentState.taskTree?.lastFailureType ?? null,
          }]
        : [];

    return {
      tasks: [...activeDirectTask, ...queuedTasks],
      emergencyTask: this.emergencyTask
        ? {
            id: this.emergencyTask.id,
            goal: this.emergencyTask.taskTree?.goal || 'Emergency',
            createdAt: this.emergencyTask.createdAt,
          }
        : null,
      currentTaskId: (this.isExecuting || this.currentState?.recoveryStatus === 'awaiting_user')
        ? this.currentState?.taskId ??
          this.taskQueue.find((task) => task.status === 'executing')?.id ??
          null
        : null,
      currentTaskTree: this.currentState?.taskTree ?? null,
      currentRecoveryStatus: this.currentState?.recoveryStatus ?? null,
    };
  }

  public setTaskListUpdateCallback(callback: (tasks: TaskListState) => void): void {
    this.onTaskListUpdate = callback;
  }

  private async executeNextTask(): Promise<void> {
    if (this.isExecuting || this.isEmergencyMode) {
      return;
    }

    const nextTask = this.taskQueue.find(
      (task) => task.status === 'pending' || task.status === 'paused',
    );
    if (!nextTask) {
      return;
    }

    if (nextTask.status === 'paused') {
      log.info(`♻️ 中断されたタスクを再開: ${nextTask.taskTree?.goal ?? nextTask.id}`);
    }
    nextTask.status = 'executing';
    this.notifyTaskListUpdate();

    const expectedRunGeneration = this.runGeneration + 1;
    await this.invoke(nextTask.state);
    if (this.runGeneration !== expectedRunGeneration) return;
    this.handleTaskCompletion(nextTask.id);
  }

  private handleTaskCompletion(taskId: string): void {
    const taskIndex = this.taskQueue.findIndex((task) => task.id === taskId);
    if (taskIndex !== -1) {
      const task = this.taskQueue[taskIndex];
      const taskStatus = this.currentState?.taskTree?.status;
      const recoveryStatus = this.currentState?.recoveryStatus;
      const yielded = this.yieldedTaskIds.delete(taskId);
      if (task.status === 'paused' && (this.isEmergencyMode || yielded)) {
        // interruptForEmergency already preserved this task for resumePreviousTask.
        // A cancelled invoke must not make the queue owner delete it as completed.
        task.taskTree = (this.currentState?.taskTree as any) ?? task.taskTree;
      } else if (recoveryStatus === 'awaiting_user') {
        task.status = 'awaiting_user';
        task.taskTree = (this.currentState?.taskTree as any) ?? task.taskTree;
        if (this.currentState?.savedMessages?.length || this.currentState?.savedTaskNodes?.length ||
          this.currentState?.savedCognitiveWorkspace) {
          task.state.continuationCheckpoint = {
            messages: this.currentState.savedMessages ?? [],
            taskNodes: this.currentState.savedTaskNodes ?? [],
            cognitiveWorkspace: this.currentState.savedCognitiveWorkspace,
          };
        }
        this.taskRunGenerations.delete(taskId);
      } else if (taskStatus === 'error' || recoveryStatus === 'failed_terminal') {
        task.status = 'failed_terminal';
        task.taskTree = (this.currentState?.taskTree as any) ?? task.taskTree;
        this.taskRunGenerations.delete(taskId);
      } else {
        this.taskQueue.splice(taskIndex, 1);
        this.taskRunGenerations.delete(taskId);
      }
    }

    this.notifyTaskListUpdate();

    const taskStatus = this.currentState?.taskTree?.status;
    if (!this.isEmergencyMode && taskStatus !== 'error') {
      setTimeout(() => {
        void this.executeNextTask();
      }, 500);
    }
  }

  private notifyTaskListUpdate(): void {
    if (this.onTaskListUpdate) {
      this.onTaskListUpdate(this.getTaskListState());
    }
  }

  private handleTaskTreeUpdate(taskId: string, taskTree: TaskTreeState): void {
    if (!this.currentState || this.currentState.taskId !== taskId) {
      return;
    }

    this.currentState.taskTree = taskTree;

    const queuedTask = this.taskQueue.find((task) => task.id === taskId);
    if (queuedTask) {
      queuedTask.taskTree = taskTree;
      queuedTask.state.taskTree = taskTree;
    }

    this.notifyTaskListUpdate();
  }

  private handleExecutionCheckpoint(taskId: string, runGeneration: number,
    checkpoint: MinecraftTaskCheckpoint): void {
    if (!checkpoint.messages?.length && !checkpoint.taskNodes?.length && !checkpoint.cognitiveWorkspace) return;
    const queuedTask = this.taskQueue.find(task => task.id === taskId);
    if (queuedTask && this.taskRunGenerations.get(taskId) === runGeneration &&
      (queuedTask.status === 'executing' || queuedTask.status === 'paused')) {
      queuedTask.state.continuationCheckpoint = checkpoint;
    }
    if (this.activeRunGeneration === runGeneration && this.currentState?.taskId === taskId) {
      this.currentState.savedMessages = checkpoint.messages;
      this.currentState.savedTaskNodes = checkpoint.taskNodes;
      this.currentState.savedCognitiveWorkspace = checkpoint.cognitiveWorkspace;
    }
  }

  private buildContinuationPrompt(goal: string, feedback: string): string {
    return [
      `継続中のタスク: ${goal}`,
      `ユーザーの返答: ${feedback}`,
      'これは新しい雑談や新規依頼ではありません。上の継続中タスクに対する返答として解釈し、そのまま続行してください。',
    ].join('\n');
  }

  private deriveRecoveryStatus(
    graphResult: any,
  ): 'idle' | 'retrying' | 'awaiting_user' | 'failed_terminal' {
    const explicit = graphResult?.recoveryStatus;
    if (
      explicit === 'idle' ||
      explicit === 'retrying' ||
      explicit === 'awaiting_user' ||
      explicit === 'failed_terminal'
    ) {
      return explicit;
    }
    if (graphResult?.taskTree?.status === 'error') {
      return 'failed_terminal';
    }
    return 'idle';
  }

  private mapRecoveryStatusToTaskStatus(
    recoveryStatus: 'idle' | 'retrying' | 'awaiting_user' | 'failed_terminal',
  ): 'executing' | 'awaiting_user' | 'failed_terminal' {
    switch (recoveryStatus) {
      case 'awaiting_user':
        return 'awaiting_user';
      case 'failed_terminal':
        return 'failed_terminal';
      default:
        return 'executing';
    }
  }

  private mapTaskStatusToRecoveryStatus(
    status: 'pending' | 'executing' | 'paused' | 'awaiting_user' | 'failed_terminal',
  ): 'idle' | 'retrying' | 'awaiting_user' | 'failed_terminal' {
    switch (status) {
      case 'awaiting_user':
        return 'awaiting_user';
      case 'failed_terminal':
        return 'failed_terminal';
      default:
        return 'idle';
    }
  }

  private stopBotActions(): void {
    try {
      this.bot.interruptExecution = true;
      this.bot.clearControlStates();
      const pathfinder = (this.bot as any).pathfinder;
      pathfinder?.setGoal?.(null);
      pathfinder?.stop?.();
    } catch (error) {
      log.error('Failed to stop bot actions cleanly', error);
    }
  }

  private taskInputToEnvelope(input: TaskStateInput): RequestEnvelope {
    assertMinecraftConnected(this.bot);
    if (input.envelope) {
      const copiedEnvelope = validateMinecraftEnvelope(input.envelope, this.bot);
      // 既存の envelope がある場合でも、Minecraft チャネルなら
      // リアルタイムのインベントリと nearbyInfrastructure で補強する
      if (copiedEnvelope.channel === 'minecraft' && copiedEnvelope.minecraft) {
        const freshInventory = mapBotInventoryItems(this.bot.inventory?.items() ?? []);
        const nearbyInfrastructure = this.scanNearbyInfrastructure();

        // インベントリが空でない場合のみ上書き（フォールバック保護）
        if (freshInventory.length > 0 || !copiedEnvelope.minecraft.inventory?.length) {
          copiedEnvelope.minecraft.inventory = freshInventory.length > 0
            ? freshInventory
            : copiedEnvelope.minecraft.inventory;
        }
        copiedEnvelope.minecraft.nearbyInfrastructure = nearbyInfrastructure;
        copiedEnvelope.minecraft.nearbyResources = this.scanNearbyResources();
        const expRefresh = (this.bot as any).experience as
          | { level: number; points: number; progress: number }
          | undefined;
        copiedEnvelope.minecraft.health = this.bot.health ?? copiedEnvelope.minecraft.health;
        copiedEnvelope.minecraft.food = this.bot.food ?? copiedEnvelope.minecraft.food;
        copiedEnvelope.minecraft.experienceLevel = expRefresh?.level;
        copiedEnvelope.minecraft.totalExperience = expRefresh?.points;
        copiedEnvelope.minecraft.experienceBarProgress = expRefresh?.progress;
        // ディメンション情報を補完（未設定の場合）
        if (!copiedEnvelope.minecraft.dimension) {
          copiedEnvelope.minecraft.dimension = minecraftMemoryContext(this.bot)?.dimension;
        }
      }
      // bot 参照を常に metadata に注入 (ShannonExecutor → SubAgentRoutineExecutor で必要)
      const prevMeta = ((copiedEnvelope as any).metadata ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...prevMeta, bot: this.bot };
      if (input.continuationCheckpoint) {
        if (input.continuationCheckpoint.messages.length) merged.previousMessages = input.continuationCheckpoint.messages;
        if (input.continuationCheckpoint.taskNodes.length) merged.previousTaskNodes = input.continuationCheckpoint.taskNodes;
        if (input.continuationCheckpoint.cognitiveWorkspace) merged.previousCognitiveWorkspace = input.continuationCheckpoint.cognitiveWorkspace;
      }
      if (input.minebotToolPolicy) merged.minebotToolPolicy = input.minebotToolPolicy;
      else delete merged.minebotToolPolicy;
      if (input.reflexDecision) merged.reflexDecision = input.reflexDecision;
      if (input.goalContract) merged.goalContract = input.goalContract;
      (copiedEnvelope as any).metadata = merged;
      return copiedEnvelope;
    }

    const memoryContext = minecraftMemoryContext(this.bot);
    const memoryKeys = minecraftConversationKeys(memoryContext, 'minebot-system');
    const tags = ['minecraft'];
    if (input.isEmergency) {
      tags.push('emergency');
    }

    // bot の現在状態をスナップショットして envelope に含める
    const pos = this.bot.entity?.position;
    const inventory = mapBotInventoryItems(this.bot.inventory?.items() ?? []);
    const exp = (this.bot as any).experience as
      | { level: number; points: number; progress: number }
      | undefined;

    // 近くのインフラブロックをスキャン（crafting_table, furnace 等）
    const nearbyInfrastructure = this.scanNearbyInfrastructure();
    const nearbyResources = this.scanNearbyResources();

    return createEnvelope({
      channel: 'minecraft',
      sourceUserId: 'minebot-system',
      sourceDisplayName: 'Minebot System',
      conversationId: memoryKeys?.conversationId ?? 'minecraft:unbound',
      threadId: memoryKeys?.threadId ?? 'minecraft:unbound',
      text: input.userMessage ?? undefined,
      tags,
      minecraft: {
        serverId: memoryContext?.serverId,
        worldId: memoryContext?.worldId,
        position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : undefined,
        health: this.bot.health ?? undefined,
        food: this.bot.food ?? undefined,
        experienceLevel: exp?.level,
        totalExperience: exp?.points,
        experienceBarProgress: exp?.progress,
        inventory,
        nearbyInfrastructure,
        nearbyResources,
        dimension: memoryContext?.dimension,
      } as any,
      metadata: {
        environmentState: input.environmentState,
        selfState: input.selfState,
        taskOrigin: 'minebot-runtime',
        bot: this.bot,
        ...(input.minebotToolPolicy
          ? { minebotToolPolicy: input.minebotToolPolicy }
          : {}),
        ...(input.reflexDecision ? { reflexDecision: input.reflexDecision } : {}),
        ...(input.goalContract ? { goalContract: input.goalContract } : {}),
        ...(input.continuationCheckpoint?.messages.length
          ? { previousMessages: input.continuationCheckpoint.messages } : {}),
        ...(input.continuationCheckpoint?.taskNodes.length
          ? { previousTaskNodes: input.continuationCheckpoint.taskNodes } : {}),
        ...(input.continuationCheckpoint?.cognitiveWorkspace
          ? { previousCognitiveWorkspace: input.continuationCheckpoint.cognitiveWorkspace } : {}),
      },
    });
  }

  /**
   * 半径 8 ブロック以内のインフラブロック（crafting_table, furnace 等）をスキャン。
   * PromptBuilder および plan-craft ツールで使用する。
   */
  private scanNearbyInfrastructure(): Array<{ name: string; x: number; y: number; z: number; distance: number }> {
    const SCAN_BLOCKS = [
      'crafting_table', 'furnace', 'blast_furnace', 'smoker',
      'chest', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil',
      'brewing_stand', 'stonecutter',
    ];
    const results: Array<{ name: string; x: number; y: number; z: number; distance: number }> = [];

    try {
      if (!this.bot.entity?.position) return results;
      // One pass over the loaded chunks' palettes (about a millisecond). The library's search was run once per
      // block name and read every cell of every matching section: with the resource scan below it held the
      // whole process for about two seconds at the start of every task, emergencies included, and nothing
      // moved meanwhile: a drowning body's retrace was judged "no headway" before its first tick (L38, lab).
      const perName = new Map<string, number>();
      for (const hit of scanLoadedBlocks(this.bot as any, SCAN_BLOCKS, { maxDistance: 8 }).hits.sort((a, b) => a.distance - b.distance)) {
        const seen = perName.get(hit.name) ?? 0;
        if (seen >= 3) continue;
        perName.set(hit.name, seen + 1);
        results.push({ name: hit.name, x: hit.position.x, y: hit.position.y, z: hit.position.z, distance: Math.round(hit.distance * 10) / 10 });
      }
      results.sort((a, b) => SCAN_BLOCKS.indexOf(a.name) - SCAN_BLOCKS.indexOf(b.name) || a.distance - b.distance);
    } catch (err) {
      log.warn(`Failed to scan nearby infrastructure: ${err}`);
    }

    return results;
  }

  /**
   * 半径 32 ブロック以内の資源ブロック（木材等）をスキャン。
   * plan-craft ツールやレシピ依存解決で代替素材（oak_log の代わりに acacia_log 等）を選択するために使用。
   */
  private scanNearbyResources(): Array<{ name: string; count: number }> {
    const RESOURCE_BLOCKS = [
      'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
      'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
    ];
    const results: Array<{ name: string; count: number }> = [];

    try {
      if (!this.bot.entity?.position) return results;
      const counts = new Map<string, number>();
      for (const hit of scanLoadedBlocks(this.bot as any, RESOURCE_BLOCKS, { maxDistance: 32 }).hits) counts.set(hit.name, (counts.get(hit.name) ?? 0) + 1);
      for (const name of RESOURCE_BLOCKS) if (counts.has(name)) results.push({ name, count: Math.min(20, counts.get(name)!) });
    } catch (err) {
      log.warn(`Failed to scan nearby resources: ${err}`);
    }

    return results;
  }
}
