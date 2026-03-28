import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { RequestEnvelope } from '@shannon/common';
import { createEnvelope } from '../../common/adapters/envelopeFactory.js';
import { createLogger } from '../../../utils/logger.js';
import type {
  TaskListState,
  TaskQueueEntry,
  TaskStateInput,
} from '../../llm/graph/types.js';
import { GRAPH_CONFIG } from '../../llm/graph/types.js';
import type { TaskTreeState } from '@shannon/common';
import type { CustomBot } from '../types.js';

const log = createLogger('Minebot:TaskRuntime');

type UnifiedExecutor = (
  envelope: RequestEnvelope,
  messages?: BaseMessage[],
  options?: {
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    onRequestSkillInterrupt?: () => void;
    getLiveInventory?: () => Array<{ name: string; count: number }>;
    getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
    abortSignal?: AbortSignal;
  },
) => Promise<any>;

export class MinebotTaskRuntime {
  private bot: CustomBot;
  private taskQueue: TaskQueueEntry[] = [];
  private emergencyTask: TaskQueueEntry | null = null;
  private isEmergencyMode = false;
  private abortedForEmergency = false;
  private isExecuting = false;
  private abortController: AbortController | null = null;
  private onTaskListUpdate: ((tasks: TaskListState) => void) | null = null;
  private executor: UnifiedExecutor | null = null;

  public currentState: {
    taskId: string;
    createdAt: number;
    forceStop: boolean;
    retryBudget: number;
    recoveryStatus: 'idle' | 'retrying' | 'awaiting_user' | 'failed_terminal';
    humanFeedback?: string;
    humanFeedbackPending?: boolean;
    taskTree?: TaskTreeState;
    graphResult?: any;
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
    if (this.isExecuting) {
      log.warn(`Task already executing, skipping: ${partialState.userMessage?.substring(0, 50)}`);
      return null;
    }

    if (!this.executor) {
      log.error('MinebotTaskRuntime executor is not configured');
      return null;
    }

    this.isExecuting = true;
    this.abortController = new AbortController();

    const taskId = partialState.taskId ?? crypto.randomUUID();
    const createdAt = Date.now();
    this.currentState = {
      taskId,
      createdAt,
      forceStop: false,
      retryBudget: 2,
      recoveryStatus: 'idle',
      taskTree: {
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
      const messages = [...(partialState.messages ?? [])];
      if (partialState.userMessage && messages.length === 0) {
        messages.push(new HumanMessage(partialState.userMessage));
      }

      const graphResult = await this.executor(envelope, messages, {
        onToolStarting: partialState.onToolStarting,
        onTaskTreeUpdate: (taskTree) => this.handleTaskTreeUpdate(taskId, taskTree),
        onRequestSkillInterrupt: () => {
          this.bot.interruptExecution = true;
          log.warn('⚡ MetaCognition からスキル中断要求 → bot.interruptExecution = true');
        },
        getLiveInventory: () => {
          return this.bot.inventory?.items().map((item) => ({
            name: item.name,
            count: item.count,
          })) ?? [];
        },
        getActiveEffects: () => {
          const effects = (this.bot as any).activeEffects as Array<{ name: string; amplifier: number }> | undefined;
          return effects ?? [];
        },
        abortSignal: this.abortController?.signal,
      });

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
        createdAt,
        forceStop: this.currentState?.forceStop ?? false,
        retryBudget: this.currentState?.retryBudget ?? 2,
        recoveryStatus: this.deriveRecoveryStatus(graphResult),
        taskTree,
        graphResult,
      };
      this.notifyTaskListUpdate();

      return this.currentState;
    } catch (error) {
      // 緊急プリエンプションによる中断の場合はエラー扱いにしない（paused タスクを保全）
      if (this.abortedForEmergency) {
        log.info('♻️ タスクは緊急プリエンプションにより中断 — 緊急タスク完了後に再開予定');
        this.abortedForEmergency = false;
        this.currentState = {
          taskId,
          createdAt,
          forceStop: true,
          retryBudget: this.currentState?.retryBudget ?? 2,
          recoveryStatus: 'idle',
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

      log.error('Task execution error', error);
      this.currentState = {
        taskId,
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
      this.isExecuting = false;
      this.abortController = null;

      if (partialState.isEmergency || this.isEmergencyMode) {
        this.isEmergencyMode = false;
        this.emergencyTask = null;
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

  public forceStop(): void {
    if (this.currentState) {
      this.currentState.forceStop = true;
    }
    this.stopBotActions();
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

    const goal = this.currentState.taskTree?.goal || 'Task';
    return this.invoke({
      taskId: this.currentState.taskId,
      envelope: {
        ...overrides.envelope,
        text: this.buildContinuationPrompt(goal, feedback),
      },
      userMessage: this.buildContinuationPrompt(goal, feedback),
      messages: overrides.messages,
      environmentState: overrides.environmentState ?? null,
      selfState: overrides.selfState ?? null,
      humanFeedback: feedback,
      taskTree: this.currentState.taskTree ?? null,
      onToolStarting: overrides.onToolStarting,
    });
  }

  public isRunning(): boolean {
    return this.isExecuting;
  }

  public isInEmergencyMode(): boolean {
    return this.isEmergencyMode;
  }

  public async interruptForEmergency(_message: string): Promise<void> {
    const executingTask = this.taskQueue.find((task) => task.status === 'executing');
    if (executingTask) {
      executingTask.status = 'paused';
      executingTask.taskTree = (this.currentState?.taskTree as any) ?? executingTask.taskTree;
    }

    this.isEmergencyMode = true;
    if (this.isExecuting) {
      this.abortedForEmergency = true;
      this.forceStop();

      // forceStop() は AbortController.abort() するが、FCA の実行ループが
      // 実際に終了して isExecuting = false になるまでラグがある。
      // 緊急タスクの invoke() が拒否されないよう、解除を待つ。
      const deadline = Date.now() + 2000;
      while (this.isExecuting && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (this.isExecuting) {
        log.warn('⚡ タスクが2秒以内に停止しなかったため isExecuting を強制クリア');
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

    await this.invoke(nextTask.state);
    this.handleTaskCompletion(nextTask.id);
  }

  private handleTaskCompletion(taskId: string): void {
    const taskIndex = this.taskQueue.findIndex((task) => task.id === taskId);
    if (taskIndex !== -1) {
      const task = this.taskQueue[taskIndex];
      const taskStatus = this.currentState?.taskTree?.status;
      const recoveryStatus = this.currentState?.recoveryStatus;
      if (recoveryStatus === 'awaiting_user') {
        task.status = 'awaiting_user';
        task.taskTree = (this.currentState?.taskTree as any) ?? task.taskTree;
      } else if (taskStatus === 'error' || recoveryStatus === 'failed_terminal') {
        task.status = 'failed_terminal';
        task.taskTree = (this.currentState?.taskTree as any) ?? task.taskTree;
      } else {
        this.taskQueue.splice(taskIndex, 1);
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
    }

    this.notifyTaskListUpdate();
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
    if (input.envelope) {
      // 既存の envelope がある場合でも、Minecraft チャネルなら
      // リアルタイムのインベントリと nearbyInfrastructure で補強する
      if (input.envelope.channel === 'minecraft' && input.envelope.minecraft) {
        const freshInventory = this.bot.inventory?.items().map((item) => ({
          name: item.name,
          count: item.count,
        })) ?? [];
        const nearbyInfrastructure = this.scanNearbyInfrastructure();

        // インベントリが空でない場合のみ上書き（フォールバック保護）
        if (freshInventory.length > 0 || !input.envelope.minecraft.inventory?.length) {
          input.envelope.minecraft.inventory = freshInventory.length > 0
            ? freshInventory
            : input.envelope.minecraft.inventory;
        }
        input.envelope.minecraft.nearbyInfrastructure = nearbyInfrastructure;
        input.envelope.minecraft.nearbyResources = this.scanNearbyResources();
        // ディメンション情報を補完（未設定の場合）
        if (!input.envelope.minecraft.dimension) {
          input.envelope.minecraft.dimension = (this.bot as any).game?.dimension?.toString() || 'overworld';
        }
      }
      return input.envelope;
    }

    const tags = ['minecraft'];
    if (input.isEmergency) {
      tags.push('emergency');
    }

    // bot の現在状態をスナップショットして envelope に含める
    const pos = this.bot.entity?.position;
    const inventory = this.bot.inventory?.items().map((item) => ({
      name: item.name,
      count: item.count,
    })) ?? [];

    // 近くのインフラブロックをスキャン（crafting_table, furnace 等）
    const nearbyInfrastructure = this.scanNearbyInfrastructure();
    const nearbyResources = this.scanNearbyResources();

    return createEnvelope({
      channel: 'minecraft',
      sourceUserId: 'minebot-system',
      sourceDisplayName: 'Minebot System',
      conversationId: `minecraft:${this.bot.connectedServerName || 'default'}`,
      threadId: `minecraft:${this.bot.connectedServerName || 'default'}`,
      text: input.userMessage ?? undefined,
      tags,
      minecraft: {
        worldId: this.bot.connectedServerName || 'default',
        position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : undefined,
        health: this.bot.health ?? undefined,
        food: this.bot.food ?? undefined,
        inventory,
        nearbyInfrastructure,
        nearbyResources,
        dimension: (this.bot as any).game?.dimension?.toString() || 'overworld',
      } as any,
      metadata: {
        environmentState: input.environmentState,
        selfState: input.selfState,
        taskOrigin: 'minebot-runtime',
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
      const pos = this.bot.entity?.position;
      if (!pos) return results;

      for (const blockName of SCAN_BLOCKS) {
        const blockId = (this.bot as any).registry?.blocksByName?.[blockName]?.id;
        if (blockId == null) continue;

        const found = this.bot.findBlocks({ matching: blockId, maxDistance: 8, count: 3 });
        for (const blockPos of found) {
          results.push({
            name: blockName,
            x: blockPos.x,
            y: blockPos.y,
            z: blockPos.z,
            distance: Math.round(pos.distanceTo(blockPos) * 10) / 10,
          });
        }
      }
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
      const registry = (this.bot as any).registry;
      if (!registry?.blocksByName) return results;

      for (const blockName of RESOURCE_BLOCKS) {
        const blockId = registry.blocksByName[blockName]?.id;
        if (blockId == null) continue;

        const found = this.bot.findBlocks({ matching: blockId, maxDistance: 32, count: 20 });
        if (found.length > 0) {
          results.push({ name: blockName, count: found.length });
        }
      }
    } catch (err) {
      log.warn(`Failed to scan nearby resources: ${err}`);
    }

    return results;
  }
}
