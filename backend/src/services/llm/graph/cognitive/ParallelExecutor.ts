import { snapshotMemoryEnvelope } from '../../../memory/requestMemory.js';
import { StructuredTool } from '@langchain/core/tools';
import { TaskTreeState } from '@shannon/common';
import { BaseMessage } from '@langchain/core/messages';
import { logger } from '../../../../utils/logger.js';
import { EmotionNode, EmotionState } from '../nodes/EmotionNode.js';
import { FunctionCallingAgent, FunctionCallingAgentState } from '../nodes/FunctionCallingAgent.js';
import { CognitiveBlackboard } from './CognitiveBlackboard.js';
import { EmotionLoop } from './EmotionLoop.js';
import { MemoryAgent } from './MemoryAgent.js';
import { MetaCognitionLoop } from './MetaCognitionLoop.js';
import { ModelSelector } from './ModelSelector.js';
import { TaskEpisodeMemory } from './TaskEpisodeMemory.js';
import { SelfImprovementDaemon } from './selfImprove/index.js';
import type { ExecutionResult } from '../types.js';
import type RecallMemoryTool from '../../tools/memory/recallMemory.js';
import type SaveMemoryTool from '../../tools/memory/saveMemory.js';
import type PlanCraftTool from '../../tools/utility/planCraft.js';

/**
 * ParallelExecutor — 認知プロセスのオーケストレーター。
 *
 * 感情（EmotionLoop）、メタ認知（MetaCognitionLoop）、タスク実行（FCA）を
 * 並列に起動し、CognitiveBlackboard を通じて連携させる。
 *
 * Minecraft 単純タスクでは EmotionLoop + MetaCognitionLoop をスキップし、
 * 軽量な自動エスカレーションのみ行う（速度優先）。
 */

/** MetaCognition なしの自動エスカレーション閾値 */
const AUTO_ESCALATE_CONSECUTIVE_FAILURES = 5;

export interface ParallelExecutorDeps {
    fca: FunctionCallingAgent;
    emotionNode?: EmotionNode;
}

export interface ParallelExecutorResult {
    taskTree: TaskTreeState;
    recoveryStatus?: 'idle' | 'awaiting_user' | 'failed_terminal';
    recoveryAttempts?: number;
    lastFailureType?: string;
    isEmergency?: boolean;
    messages: BaseMessage[];
    forceStop: boolean;
    finalEmotion?: import('@shannon/common').EmotionType | null;
    modelStats?: { escalations: number; deescalations: number; currentModel: string };
    /** ユーザー向け応答文（task-complete 時の最後の assistant content）。finalAnswer の優先元 */
    lastAssistantContent?: string;
}

export class ParallelExecutor {
    private fca: FunctionCallingAgent;
    private emotionNode?: EmotionNode;

    constructor(deps: ParallelExecutorDeps) {
        this.fca = deps.fca;
        this.emotionNode = deps.emotionNode;
    }

    async run(
        state: FunctionCallingAgentState,
        signal?: AbortSignal,
    ): Promise<ParallelExecutorResult> {
        signal?.throwIfAborted();
        if (!state.requestEnvelope || state.requestEnvelope.requestId !== state.taskId) {
            throw new Error('Parallel execution requires its canonical request envelope');
        }
        const fca = this.fca.createSession();
        const goal = state.userMessage || 'Unknown task';
        const startTime = Date.now();
        const isMinecraft = state.context?.platform === 'minecraft' || state.context?.platform === 'minebot';

        // Phase 2: Claude Sonnet の拡張思考が感情・メタ認知を内包するため、
        // 認知ループを無条件スキップ。フォールバック: SHANNON_COGNITIVE_LOOPS=true で復活。
        const cognitiveLoopsEnabled = process.env.SHANNON_COGNITIVE_LOOPS === 'true';
        const skipEmotionLoop = cognitiveLoopsEnabled ? isMinecraft : true;
        const skipMetaCognition = cognitiveLoopsEnabled
            ? (state.isEmergency || (isMinecraft && state.needsPlanning === false))
            : true;

        // ModelSelector を初期化
        const modelSelector = new ModelSelector(state.selectedModel || FunctionCallingAgent.MODEL_NAME);

        // CognitiveBlackboard を初期化
        const blackboard = new CognitiveBlackboard(
            goal,
            state.emotionState.current,
            state.messages,
        );

        // Minecraft の場合、初期インベントリを blackboard にセット + 食料安全チェック
        if (isMinecraft) {
            const mcMeta = state.context?.metadata?.minecraft as Record<string, unknown> | undefined;
            if (Array.isArray(mcMeta?.inventory)) {
                const inventory = mcMeta!.inventory as Array<{ name: string; count: number }>;
                const freeSlots = 36 - inventory.filter(e => e.count > 0).length;
                blackboard.updateSelf({ inventory, freeSlots });

                // バイタル情報を blackboard に保存
                const health = mcMeta?.health as number | undefined;
                const food = mcMeta?.food as number | undefined;
                if (health !== undefined && food !== undefined) {
                    blackboard.updateSelf({ health, food });
                }

                // 食料安全チェック: インベントリに食べ物がなければ vital alert
                const vitalAlerts = ParallelExecutor.checkVitalAlerts(
                    inventory, health, food,
                );
                if (vitalAlerts.length > 0) {
                    blackboard.updateSelf({ vitalAlerts });
                    logger.warn(`[ParallelExecutor] ⚠️ Vital alerts: ${vitalAlerts.join('; ')}`);
                }
            }
        }

        // MemoryAgent を初期化 (4番目の並列プロセス)
        // Snapshot identity fields; later caller mutations must not retarget this memory agent.
        const memoryEnvelope = snapshotMemoryEnvelope(state.requestEnvelope);
        const memoryAgent = new MemoryAgent(blackboard, memoryEnvelope);
        const initialMemoryPromise = memoryAgent.initialize(goal);

        // MemoryAgent をツールに注入
        for (const tool of fca.getTools()) {
            if ('setMemoryAgent' in tool && typeof (tool as Record<string, unknown>).setMemoryAgent === 'function') {
                (tool as unknown as { setMemoryAgent(agent: MemoryAgent): void }).setMemoryAgent(memoryAgent);
            }
            if ('setBlackboard' in tool && typeof (tool as Record<string, unknown>).setBlackboard === 'function') {
                (tool as unknown as { setBlackboard(bb: CognitiveBlackboard): void }).setBlackboard(blackboard);
            }
        }

        // 認知プロセスを条件付きで生成
        const emotionLoop = skipEmotionLoop
            ? null
            : new EmotionLoop(blackboard, this.emotionNode);
        const metaLoop = skipMetaCognition
            ? null
            : new MetaCognitionLoop(blackboard, modelSelector);

        // MetaCognitionLoop のフィードバックを FCA に注入
        if (metaLoop) {
            metaLoop.setFeedbackCallback((feedback) => {
                fca.addFeedback(feedback);
            });

            // MetaCognition が wrong_approach/stuck を判定した場合、実行中スキルを中断
            if (state.onRequestSkillInterrupt) {
                metaLoop.setInterruptCallback(state.onRequestSkillInterrupt);
            }
        }

        // FCA の TaskTreePublisher に blackboard アクセサを設定（Minebot UI に metaState/emotion を付加）
        fca.setBlackboardAccessor(() => ({
            metaState: blackboard.metaState,
            emotionState: blackboard.emotionState,
            freeSlots: blackboard.freeSlots,
            activeEffects: blackboard.activeEffects,
        }));

        // FCA の onToolsExecuted を拡張して blackboard を更新
        const originalOnToolsExecuted = state.onToolsExecuted;

        // Minecraft: bot の実インベントリからリアルタイム取得
        // - TaskFCA へは前回との差分を注入（何が変わったかを認識させる）
        // - MetaCognition へは blackboard 経由でフルインベントリを渡す
        const getLiveInventory = isMinecraft ? state.getLiveInventory : undefined;
        let previousInventory = new Map<string, number>();
        if (getLiveInventory) {
            for (const entry of (blackboard.inventory ?? [])) {
                previousInventory.set(entry.name, (previousInventory.get(entry.name) || 0) + entry.count);
            }
        }

        // 初期記憶を取得 (FCA の最初のイテレーションでエフェメラル注入)
        let initialMemoryConsumed = false;
        const getInitialMemory = async (): Promise<string | null> => {
            if (initialMemoryConsumed) return null;
            initialMemoryConsumed = true;
            const mem = await initialMemoryPromise;
            return mem || null;
        };

        const wrappedState: FunctionCallingAgentState = {
            ...state,
            requestEnvelope: memoryEnvelope,
            selectedModel: modelSelector.modelName,
            getInitialMemory,
            getInventoryDiff: getLiveInventory ? () => {
                // ステータスエフェクトも一緒に blackboard へ反映
                if (state.getActiveEffects) {
                    const effects = state.getActiveEffects();
                    blackboard.updateSelf({ activeEffects: effects });
                }

                const current = getLiveInventory();
                const currentMap = new Map<string, number>();
                for (const entry of current) {
                    currentMap.set(entry.name, (currentMap.get(entry.name) || 0) + entry.count);
                }

                // 差分を計算
                const added: string[] = [];
                const removed: string[] = [];
                const allKeys = new Set([...previousInventory.keys(), ...currentMap.keys()]);
                for (const key of allKeys) {
                    const prev = previousInventory.get(key) || 0;
                    const curr = currentMap.get(key) || 0;
                    if (curr > prev) added.push(`+${curr - prev} ${key}`);
                    else if (curr < prev) removed.push(`-${prev - curr} ${key}`);
                }

                // 現在のインベントリを次回比較用に保存
                previousInventory = currentMap;

                // blackboard のインベントリも更新（MetaCognition 用）
                const freeSlots = 36 - current.filter(e => e.count > 0).length;
                blackboard.updateSelf({ inventory: current, freeSlots });

                // 差分がなくても現在の所持数サマリーは常に付ける
                const currentItems = current.filter(e => e.count > 0).map(e => `${e.name} x${e.count}`);
                const summaryLine = currentItems.length > 0
                    ? `【現在のインベントリ（${currentItems.length}種）: ${currentItems.join(', ')}】`
                    : '【現在のインベントリ: 空】';

                if (added.length === 0 && removed.length === 0) {
                    return summaryLine;
                }

                const diffLines: string[] = [];
                if (added.length > 0) diffLines.push(`増加: ${added.join(', ')}`);
                if (removed.length > 0) diffLines.push(`減少: ${removed.join(', ')}`);
                return `【インベントリ変化: ${diffLines.join(' / ')}】\n${summaryLine}`;
            } : undefined,
            getJournalSummary: () => {
                return blackboard.plan?.journalSummary ?? null;
            },
            getActiveSubtaskInfo: () => {
                const plan = blackboard.plan;
                if (!plan?.currentSubtaskId) return null;
                const st = blackboard.findSubtask(plan.currentSubtaskId);
                if (!st) return null;
                const childLines = st.children.map(c => {
                    const icon = { pending: '⬜', in_progress: '🔄', completed: '✅', error: '❌', skipped: '⏭️' }[c.status];
                    return `  ${icon} ${c.id}: ${c.goal}`;
                }).join('\n');
                // Find next subtask
                const allTop = plan.subtasks;
                const currentIdx = allTop.findIndex(s => s.id === plan.currentSubtaskId);
                const next = currentIdx >= 0 && currentIdx < allTop.length - 1 ? allTop[currentIdx + 1] : null;
                let result = `【現在のサブタスク: ${st.id} — ${st.goal}】`;
                if (childLines) result += `\n${childLines}`;
                if (next) result += `\n次: ${next.id} — ${next.goal}`;
                return result;
            },
            onToolsExecuted: (messages: BaseMessage[], results: ExecutionResult[]) => {
                // Blackboard にタスク状態を書き込み
                blackboard.updateTask({
                    iteration: blackboard.taskState.iteration + 1,
                    newResults: results,
                });

                // Plan: 現在のサブタスクのイテレーション数をインクリメント
                blackboard.incrementSubtaskIteration();

                // MetaCognition スキップ時: 軽量な自動エスカレーション
                if (skipMetaCognition) {
                    this.checkAutoEscalation(blackboard, modelSelector);
                }

                // NOTE: インベントリの blackboard 更新は getInventoryDiff() 側に一本化。
                // ここで重複して updateSelf({ inventory }) すると、getInventoryDiff の
                // previousInventory との差分計算が「変化なし」と誤判定される場合がある。

                // EmotionLoop が未起動の場合のフォールバック
                if (!emotionLoop) {
                    originalOnToolsExecuted?.(messages, results);
                }
            },
        };

        const activeLoops: string[] = ['TaskExecution', 'Memory'];
        if (emotionLoop) activeLoops.push('Emotion');
        if (metaLoop) activeLoops.push('MetaCognition');
        logger.info(
            `[ParallelExecutor] 🧠 ${activeLoops.length}プロセス起動: ${activeLoops.join(' + ')} (model=${modelSelector.modelName})`,
            'cyan',
        );

        // 外部 signal と blackboard を連携
        const onAbort = () => blackboard.complete();
        signal?.addEventListener('abort', onAbort, { once: true });

        // 4プロセスを並列起動
        const taskPromise = fca.run(wrappedState, blackboard.signal);
        const emotionPromise = emotionLoop?.run() ?? Promise.resolve();
        const metaPromise = metaLoop?.run() ?? Promise.resolve();
        const memoryPromise = memoryAgent.run(blackboard.signal);

        // Observe auxiliary failures immediately, including when the task is cancelled.
        const auxiliarySettlement = Promise.allSettled([emotionPromise, metaPromise, memoryPromise]);
        let taskResult: Awaited<typeof taskPromise>;
        try {
            taskResult = await taskPromise;
        } finally {
            signal?.removeEventListener('abort', onAbort);
            blackboard.complete();
            fca.setBlackboardAccessor(null);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                const settled = await Promise.race([
                    auxiliarySettlement,
                    new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 3000); }),
                ]);
                if (settled === null) {
                    logger.warn('[ParallelExecutor] 補助プロセスの停止待機がタイムアウト');
                } else {
                    const labels = ['EmotionLoop', 'MetaCognitionLoop', 'MemoryAgent'] as const;
                    settled.forEach((result, index) => {
                        if (result.status === 'rejected') {
                            logger.error(`[ParallelExecutor] ${labels[index]} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
                        }
                    });
                }
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
            }
        }
        signal?.throwIfAborted();

        logger.info(
            `[ParallelExecutor] ✅ 完了 (model: ${modelSelector.stats.currentModel}, ` +
            `escalations: ${modelSelector.stats.escalations}, ` +
            `deescalations: ${modelSelector.stats.deescalations})`,
        );

        // エピソード記憶の保存（fire-and-forget）
        try {
            const platform = state.context?.platform ?? 'unknown';
            const episode = TaskEpisodeMemory.buildEpisodeFromResult(
                goal,
                platform,
                taskResult.taskTree,
                startTime,
                blackboard.taskState.iteration,
            );
            TaskEpisodeMemory.getInstance().saveEpisode(episode, memoryEnvelope).catch(() => {});

            // 自己改善デーモンに通知（fire-and-forget）
            SelfImprovementDaemon.getInstance()
                .onEpisodeSaved(episode, blackboard.snapshot())
                .catch(() => {});

            // RoutineRecorder: パターン記録→自動ルーチン生成（fire-and-forget）
            try {
                const { RoutineRecorder } = await import('../../../minebot/routines/RoutineRecorder.js');
                RoutineRecorder.getInstance()
                    ?.onEpisodeCompleted(episode)
                    .catch(() => {});
            } catch { /* RoutineRecorder 未初期化の場合は無視 */ }
        } catch { }

        return {
            ...taskResult,
            finalEmotion: blackboard.emotionState,
            modelStats: modelSelector.stats,
        };
    }

    /** 食べ物アイテム名セット（autoEat の FALLBACK_FOOD_POINTS と同期） */
    private static readonly FOOD_ITEMS = new Set([
        'baked_potato', 'bread', 'cooked_beef', 'steak', 'cooked_porkchop',
        'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod',
        'cooked_salmon', 'golden_carrot', 'golden_apple', 'enchanted_golden_apple',
        'carrot', 'potato', 'beetroot', 'beetroot_soup', 'mushroom_stew',
        'rabbit_stew', 'suspicious_stew', 'dried_kelp', 'apple', 'melon_slice',
        'sweet_berries', 'glow_berries', 'chorus_fruit', 'cookie', 'pumpkin_pie',
        'honey_bottle', 'porkchop', 'beef', 'mutton', 'chicken', 'rabbit',
        'rotten_flesh', 'cod', 'salmon',
    ]);

    /**
     * インベントリとバイタルから vital alerts を生成する。
     * 食べ物がインベントリに1つもなければ、食料確保が最優先。
     */
    static checkVitalAlerts(
        inventory: Array<{ name: string; count: number }>,
        health?: number,
        food?: number,
    ): string[] {
        const alerts: string[] = [];
        const hasFoodItems = inventory.some(item => ParallelExecutor.FOOD_ITEMS.has(item.name));

        // HP 致命的レベルの検出
        if (health !== undefined && health < 2.0) {
            if (!hasFoodItems) {
                alerts.push('🚨 致命的: HP < 2.0 かつ食料なし。次のダメージで死亡する。タスクを即座に中止し、安全な場所で待機すべき。');
            } else {
                alerts.push('🚨 HP危険: HP < 2.0。食料を即座に食べること。');
            }
        }

        if (!hasFoodItems) {
            const foodLevel = food ?? 20;
            const healthLevel = health ?? 20;
            if (foodLevel <= 6 || healthLevel <= 10) {
                alerts.push('🚨 食料危機: 食べ物なし＋空腹/HP低下。食料確保を最優先で行うこと（近くの動物を狩る、作物を収穫する等）');
            } else {
                alerts.push('⚠️ 食料不足: インベントリに食べ物がありません。タスク中に空腹になる危険があるため、早めに食料を確保すること');
            }
        }

        return alerts;
    }

    /**
     * MetaCognition 非使用時の軽量自動エスカレーション。
     * 連続失敗が閾値を超えた場合にモデルをエスカレーションする。
     */
    private checkAutoEscalation(
        blackboard: CognitiveBlackboard,
        modelSelector: ModelSelector,
    ): void {
        const recent = blackboard.taskState.recentToolCalls;
        if (recent.length < AUTO_ESCALATE_CONSECUTIVE_FAILURES) return;

        // 末尾から連続失敗をカウント
        let consecutiveFailures = 0;
        for (let i = recent.length - 1; i >= 0; i--) {
            if (!recent[i].success) {
                consecutiveFailures++;
            } else {
                break;
            }
        }

        if (consecutiveFailures >= AUTO_ESCALATE_CONSECUTIVE_FAILURES) {
            logger.warn(
                `[ParallelExecutor] ⚡ 連続失敗${consecutiveFailures}回 → 自動エスカレーション`,
            );
            modelSelector.escalate(`AutoEscalation: ${consecutiveFailures} consecutive failures`);
        }
    }
}
