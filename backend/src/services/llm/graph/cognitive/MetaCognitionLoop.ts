import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';
import { createTracedModel } from '../../utils/langfuse.js';
import { CognitiveBlackboard, MetaAssessment, MetaState, BlackboardSnapshot, PlanSubtask } from './CognitiveBlackboard.js';
import { ModelSelector } from './ModelSelector.js';

/**
 * MetaCognitionLoop — 前頭前皮質 (DLPFC) に相当するメタ認知プロセス。
 *
 * ツールベースの mini-FCA で、タスク実行の進捗を俯瞰的に評価し介入する:
 *   - 評価 (assess): assessment + modelAction + shouldStop
 *   - フィードバック (send-feedback): FCA への具体的指示
 *   - プラン操作: サブタスクの CRUD・並べ替え・戦略更新
 *
 * 2段階評価サイクル:
 *   Step 1: ローリングサマリー更新 (journalSummary)
 *   Step 2: mini-FCA ツールループ
 *
 * トリガー:
 *   - task:updated (3イテレーション分蓄積後)
 *   - loop:detected (即座に)
 *   - emotion:shifted (即座に)
 */

const MAX_META_ITERATIONS = 5;
const EVALUATE_INTERVAL_ITERATIONS = 3;
const MIN_EVALUATE_INTERVAL_MS = 5_000;
const MIN_EVALUATE_INTERVAL_EMERGENCY_MS = 2_000;
const META_TIMEOUT_MS = 15_000;

// ── System Prompts ──

const SUMMARY_SYSTEM_PROMPT = `あなたはAIエージェントのタスク実行の旅程を要約するアシスタントです。
前回の要約と新しい行動結果から、タスクの旅程要約を更新してください。

以下を含めること:
- 何を試みて何が成功/失敗したか
- 失敗にどう対応したか (プラン変更、代替手段)
- 現在何に取り組んでいるか

500字以内。古い詳細は圧縮し、最近の経緯を詳しく。
前回の要約が空なら、現在の状況だけを要約してください。`;

const META_SYSTEM_PROMPT = `あなたはAIエージェント「シャノン」の前頭前皮質（メタ認知プロセス）です。
タスク実行プロセスの進捗を俯瞰的に監視し、ツールを使って適切な介入を行ってください。

# 評価基準

## assessment（進捗評価）
- on_track: 順調に進んでいる。成功率が高く、目標に近づいている
- struggling: 一部で問題が発生しているが、進展はある
- stuck: 同じ失敗を繰り返している、または進展がない
- wrong_approach: 根本的にアプローチが間違っている
  - **特に注意**: インベントリに既にある素材を無視して新たに採掘・回収しに行っている場合は wrong_approach

## modelAction（モデル切り替え）
- escalate: より強力なモデルが必要（複雑な推論が求められる場合）
- deescalate: 現在のモデルは過剰（単純なタスクにコストをかけすぎている場合）
- hold: 現状維持

## shouldStop
- true: これ以上の実行は無駄（例: 必要なリソースが存在しない、前提条件が満たせない）
- false: 継続すべき

# 手順

1. まず assess ツールで進捗を評価する（必須）
2. 必要に応じて send-feedback で具体的な指示を送る
3. プランがある場合、サブタスクの状態を更新する (update-subtask, create-subtask, delete-subtask 等)
   - 完了したサブタスクは status='completed' にする
   - **サブタスクが5イテレーション以上 in_progress で成功率50%以下 → status='error' にして代替サブタスクを create-subtask で作成**
   - 前提条件が変わって不要になったサブタスクは status='skipped' にする
4. 現在のサブタスクが適切でなければ set-active-subtask で切り替える
5. 全て完了したら done を呼ぶ`;

// ── Tool Schemas ──

const AssessSchema = z.object({
    assessment: z.enum(['on_track', 'struggling', 'stuck', 'wrong_approach'])
        .describe('タスクの進捗評価'),
    modelAction: z.enum(['escalate', 'deescalate', 'hold'])
        .describe('モデルの切り替え判断'),
    shouldStop: z.boolean()
        .describe('タスクを停止すべきか'),
});

const SendFeedbackSchema = z.object({
    message: z.string().describe('FCA への具体的な指示 (例: "crafting_tableが近くにある、新しく作らないで")'),
});

const UpdateSubtaskSchema = z.object({
    id: z.string().describe('サブタスクID'),
    status: z.enum(['pending', 'in_progress', 'completed', 'error', 'skipped']).optional(),
    result: z.string().optional().describe('完了時の成果'),
    failureReason: z.string().optional().describe('失敗時の理由'),
    goal: z.string().optional().describe('目標の修正'),
});

const CreateSubtaskSchema = z.object({
    goal: z.string().describe('新しいサブタスクの目標'),
    parentId: z.string().optional().describe('親サブタスクID (ネスト先)'),
    insertAfter: z.string().optional().describe('この ID の後に挿入'),
});

const DeleteSubtaskSchema = z.object({
    id: z.string().describe('削除するサブタスクID'),
    reason: z.string().describe('削除理由'),
});

const ReorderSubtaskSchema = z.object({
    id: z.string().describe('移動するサブタスクID'),
    position: z.number().describe('移動先の位置 (0-indexed)'),
});

const SetActiveSubtaskSchema = z.object({
    id: z.string().describe('アクティブにするサブタスクID'),
});

const UpdateStrategySchema = z.object({
    strategy: z.string().describe('新しい戦略'),
});

// ── Reward Tracker ──

interface RewardTracker {
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    recentRewardSignals: Array<{ type: 'positive' | 'negative'; magnitude: number; iteration: number }>;
}

// ── Main Class ──

export class MetaCognitionLoop {
    private blackboard: CognitiveBlackboard;
    private modelSelector: ModelSelector;
    private model: ReturnType<ChatOpenAI['bindTools']>;
    private summaryModel: ChatOpenAI;
    private stopped = false;
    private lastEvaluatedIteration = -1;
    private lastEvaluateTime = 0;
    private feedbackCallback: ((feedback: string) => void) | null = null;
    private interruptCallback: (() => void) | null = null;
    private reward: RewardTracker = {
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        recentRewardSignals: [],
    };

    /** アセスメント停滞検出 */
    private assessmentHistory: MetaAssessment[] = [];
    private static readonly STAGNATION_THRESHOLD = 3;

    /** ツール定義（LangChain bindTools 用） */
    private static readonly META_TOOL_DEFS = [
        {
            type: 'function' as const,
            function: {
                name: 'assess',
                description: 'タスク進捗を評価する（必須: done の前に1回は呼ぶこと）',
                parameters: {
                    type: 'object',
                    properties: {
                        assessment: { type: 'string', enum: ['on_track', 'struggling', 'stuck', 'wrong_approach'], description: 'タスクの進捗評価' },
                        modelAction: { type: 'string', enum: ['escalate', 'deescalate', 'hold'], description: 'モデル切り替え判断' },
                        shouldStop: { type: 'boolean', description: 'タスクを停止すべきか' },
                    },
                    required: ['assessment', 'modelAction', 'shouldStop'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'send-feedback',
                description: 'FCA への具体的な指示を送る',
                parameters: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', description: 'FCA への具体的な指示' },
                    },
                    required: ['message'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'update-subtask',
                description: 'サブタスクのステータスや情報を更新する',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'サブタスクID' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'error', 'skipped'] },
                        result: { type: 'string', description: '完了時の成果' },
                        failureReason: { type: 'string', description: '失敗時の理由' },
                        goal: { type: 'string', description: '目標の修正' },
                    },
                    required: ['id'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'create-subtask',
                description: '新しいサブタスクを作成する',
                parameters: {
                    type: 'object',
                    properties: {
                        goal: { type: 'string', description: '新しいサブタスクの目標' },
                        parentId: { type: 'string', description: '親サブタスクID（ネスト先）' },
                        insertAfter: { type: 'string', description: 'このIDの後に挿入' },
                    },
                    required: ['goal'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'delete-subtask',
                description: 'サブタスクを削除する（子も含む）',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '削除するサブタスクID' },
                        reason: { type: 'string', description: '削除理由' },
                    },
                    required: ['id', 'reason'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'reorder-subtask',
                description: 'サブタスクを同一親内で並べ替える',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '移動するサブタスクID' },
                        position: { type: 'number', description: '移動先の位置（0-indexed）' },
                    },
                    required: ['id', 'position'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'set-active-subtask',
                description: 'アクティブなサブタスクを切り替える',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'アクティブにするサブタスクID' },
                    },
                    required: ['id'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'update-strategy',
                description: 'プランの戦略を更新する',
                parameters: {
                    type: 'object',
                    properties: {
                        strategy: { type: 'string', description: '新しい戦略' },
                    },
                    required: ['strategy'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'done',
                description: 'この評価サイクルを終了する（assess を先に呼ぶこと）',
                parameters: { type: 'object', properties: {} },
            },
        },
    ];

    /** 中断シグナルのクールダウン */
    private lastInterruptTime = 0;
    private static readonly INTERRUPT_COOLDOWN_MS = 10_000;

    /** ツールバインド済みモデルを生成する */
    private buildModelWithTools(): ReturnType<ChatOpenAI['bindTools']> {
        const baseModel = createTracedModel({
            modelName: 'gpt-4.1-mini',
            apiKey: config.openaiApiKey,
        });
        return baseModel.bindTools(MetaCognitionLoop.META_TOOL_DEFS);
    }

    constructor(
        blackboard: CognitiveBlackboard,
        modelSelector: ModelSelector,
    ) {
        this.blackboard = blackboard;
        this.modelSelector = modelSelector;
        this.model = this.buildModelWithTools();
        this.summaryModel = createTracedModel({
            modelName: 'gpt-4.1-mini',
            apiKey: config.openaiApiKey,
        });
    }

    setFeedbackCallback(cb: (feedback: string) => void): void {
        this.feedbackCallback = cb;
    }

    setInterruptCallback(cb: () => void): void {
        this.interruptCallback = cb;
    }

    async run(): Promise<void> {
        this.stopped = false;

        const onTaskUpdated = () => {
            const { iteration } = this.blackboard.taskState;
            if (iteration - this.lastEvaluatedIteration >= EVALUATE_INTERVAL_ITERATIONS) {
                void this.evaluate('periodic');
            }
        };
        const onLoopDetected = (summary: string) => void this.evaluate(`loop_detected: ${summary}`);
        const onEmotionShifted = () => void this.evaluate('emotion_shifted');
        const onCompleted = () => { this.stopped = true; };

        this.blackboard.on('task:updated', onTaskUpdated);
        this.blackboard.on('loop:detected', onLoopDetected);
        this.blackboard.on('emotion:shifted', onEmotionShifted);
        this.blackboard.on('completed', onCompleted);

        await new Promise<void>(resolve => {
            if (this.stopped) return resolve();
            this.blackboard.once('completed', resolve);
        });

        this.blackboard.off('task:updated', onTaskUpdated);
        this.blackboard.off('loop:detected', onLoopDetected);
        this.blackboard.off('emotion:shifted', onEmotionShifted);
        this.blackboard.off('completed', onCompleted);
    }

    // ── Evaluate (2-step) ──

    private async evaluate(trigger: string): Promise<void> {
        if (this.stopped) return;

        const now = Date.now();
        const snapshot = this.blackboard.snapshot();
        const minInterval = snapshot.elapsedMs < 15_000
            ? MIN_EVALUATE_INTERVAL_EMERGENCY_MS
            : MIN_EVALUATE_INTERVAL_MS;
        if (now - this.lastEvaluateTime < minInterval) return;
        this.lastEvaluateTime = now;
        this.lastEvaluatedIteration = snapshot.taskState.iteration;

        // HP 危険時: インターバルを無視して即座に評価を実行する (LLM に判断させる)
        if (snapshot.selfState.health !== null && snapshot.selfState.health < 4.0) {
            logger.warn(`[MetaCognition] 🚨 HP 危険 (${snapshot.selfState.health.toFixed(1)}) → 即座に評価実行`);
        }

        // 報酬追跡
        this.updateRewardTracker(snapshot);

        try {
            // Step 1: ローリングサマリー更新
            const newSummary = await this.updateJournalSummary(snapshot);
            this.blackboard.updateJournalSummary(newSummary);

            // Step 2: mini-FCA ツールループ
            await this.runMetaFCA(snapshot, trigger);
        } catch (error) {
            logger.error('[MetaCognition] evaluate error:', error);
        }
    }

    // ── Step 1: Journal Summary ──

    private async updateJournalSummary(snapshot: BlackboardSnapshot): Promise<string> {
        const prevSummary = snapshot.plan?.journalSummary ?? '';
        const recentCalls = snapshot.taskState.recentToolCalls.slice(-10);

        // 初回 or ツール呼び出しがまだない場合はスキップ
        if (recentCalls.length === 0) return prevSummary;

        const toolCallsSummary = recentCalls.map((r, i) =>
            `${i + 1}. ${r.toolName}(${JSON.stringify(r.args).substring(0, 80)}): ${r.success ? '成功' : `失敗[${r.failureType ?? ''}]`} — ${r.message.substring(0, 100)}`,
        ).join('\n');

        const planInfo = snapshot.plan
            ? `戦略: ${snapshot.plan.strategy}\nサブタスク: ${this.formatSubtasksCompact(snapshot.plan.subtasks)}`
            : '';

        const metaInfo = snapshot.metaState
            ? `前回の評価: ${snapshot.metaState.assessment}`
            : '';

        try {
            const response = await this.summaryModel.invoke([
                new SystemMessage(SUMMARY_SYSTEM_PROMPT),
                new HumanMessage(
                    `前回の要約:\n${prevSummary || '(初回)'}\n\n直近の行動:\n${toolCallsSummary}\n\n${planInfo}\n${metaInfo}`,
                ),
            ]);
            const content = typeof response.content === 'string' ? response.content : '';
            return content.substring(0, 600); // 安全マージン
        } catch (error) {
            logger.error('[MetaCognition] サマリー更新失敗:', error);
            return prevSummary;
        }
    }

    // ── Step 2: mini-FCA ──

    private async runMetaFCA(snapshot: BlackboardSnapshot, trigger: string): Promise<void> {
        const userPrompt = this.buildEvalPrompt(snapshot, trigger);
        const messages: BaseMessage[] = [
            new SystemMessage(META_SYSTEM_PROMPT),
            new HumanMessage(userPrompt),
        ];

        let assessCalled = false;
        const startTime = Date.now();

        for (let i = 0; i < MAX_META_ITERATIONS; i++) {
            if (Date.now() - startTime > META_TIMEOUT_MS) {
                logger.warn('[MetaCognition] ⏱ 評価タイムアウト');
                break;
            }

            let response: AIMessage;
            try {
                response = (await this.model.invoke(messages)) as AIMessage;
            } catch (error) {
                logger.error('[MetaCognition] LLM呼び出し失敗:', error);
                break;
            }
            messages.push(response);

            const toolCalls = response.tool_calls || [];

            if (toolCalls.length === 0) {
                if (!assessCalled) {
                    messages.push(new HumanMessage('assessツールで評価を確定してください。'));
                    continue;
                }
                break; // assess 済みでテキストのみ → 終了
            }

            for (const tc of toolCalls) {
                const result = this.executeTool(tc.name, tc.args);
                messages.push(new ToolMessage({
                    content: result,
                    tool_call_id: tc.id || `meta_${i}_${tc.name}`,
                }));

                if (tc.name === 'assess') assessCalled = true;
                if (tc.name === 'done') {
                    if (!assessCalled) {
                        messages.push(new ToolMessage({
                            content: 'エラー: done の前に assess を呼んでください。',
                            tool_call_id: tc.id || `meta_${i}_done_err`,
                        }));
                    } else {
                        return;
                    }
                }
            }
        }

        // assess が呼ばれなかった場合のフォールバック
        if (!assessCalled) {
            logger.warn('[MetaCognition] ⚠ assess 未呼び出し → on_track で補完');
            const fallback: MetaState = {
                assessment: 'on_track',
                suggestion: null,
                modelAction: 'hold',
                shouldStop: false,
                timestamp: Date.now(),
            };
            this.blackboard.updateMeta(fallback);
        }
    }

    // ── Tool Execution ──

    private executeTool(name: string, args: Record<string, unknown>): string {
        switch (name) {
            case 'assess': return this.toolAssess(args);
            case 'send-feedback': return this.toolSendFeedback(args);
            case 'update-subtask': return this.toolUpdateSubtask(args);
            case 'create-subtask': return this.toolCreateSubtask(args);
            case 'delete-subtask': return this.toolDeleteSubtask(args);
            case 'reorder-subtask': return this.toolReorderSubtask(args);
            case 'set-active-subtask': return this.toolSetActiveSubtask(args);
            case 'update-strategy': return this.toolUpdateStrategy(args);
            case 'done': return 'OK';
            default: return `Unknown tool: ${name}`;
        }
    }

    private toolAssess(args: Record<string, unknown>): string {
        const parsed = AssessSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const { assessment: rawAssessment, modelAction: rawModelAction, shouldStop } = parsed.data;

        // 停滞検出
        const assessment = this.checkStagnation(rawAssessment);
        this.assessmentHistory.push(rawAssessment);
        if (this.assessmentHistory.length > 20) {
            this.assessmentHistory = this.assessmentHistory.slice(-20);
        }

        const assessmentChanged = assessment !== rawAssessment;
        const modelAction = assessmentChanged && rawModelAction === 'hold'
            ? 'escalate' as const
            : rawModelAction;

        const meta: MetaState = {
            assessment,
            suggestion: null,
            modelAction,
            shouldStop,
            timestamp: Date.now(),
        };

        logger.info(
            `[MetaCognition] 🧠 評価: ${assessment}${assessmentChanged ? ` (← ${rawAssessment} 停滞検出)` : ''} | model: ${modelAction} | stop: ${shouldStop} | streak: +${this.reward.consecutiveSuccesses}/-${this.reward.consecutiveFailures}`,
            'cyan',
        );

        this.blackboard.updateMeta(meta);
        this.applyAssessment(meta);

        return `評価完了: ${assessment}, model=${modelAction}, stop=${shouldStop}`;
    }

    private toolSendFeedback(args: Record<string, unknown>): string {
        const parsed = SendFeedbackSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const { message } = parsed.data;
        if (this.feedbackCallback) {
            this.feedbackCallback(`[メタ認知] ${message}`);
            logger.info(`[MetaCognition] 📝 フィードバック送信: ${message}`, 'cyan');
        }
        return `フィードバック送信: ${message}`;
    }

    private toolUpdateSubtask(args: Record<string, unknown>): string {
        const parsed = UpdateSubtaskSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const { id, ...patch } = parsed.data;
        const st = this.blackboard.findSubtask(id);
        if (!st) return `サブタスク ${id} が見つかりません`;

        this.blackboard.patchPlanSubtask(id, patch as Partial<PlanSubtask>);
        logger.info(`[MetaCognition] 📋 サブタスク更新: ${id} → ${patch.status ?? '(変更なし)'}${patch.failureReason ? ` (${patch.failureReason})` : ''}`, 'cyan');
        return `${id} を更新しました`;
    }

    private toolCreateSubtask(args: Record<string, unknown>): string {
        const parsed = CreateSubtaskSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const result = this.blackboard.createSubtask(parsed.data.goal, parsed.data.parentId, parsed.data.insertAfter);
        if (!result) return 'サブタスク作成失敗 (上限超過または親が見つかりません)';

        logger.info(`[MetaCognition] 📋 サブタスク作成: ${result.id} — ${parsed.data.goal}`, 'cyan');
        return `作成完了: ${result.id}`;
    }

    private toolDeleteSubtask(args: Record<string, unknown>): string {
        const parsed = DeleteSubtaskSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const success = this.blackboard.deleteSubtask(parsed.data.id);
        if (!success) return `削除失敗: ${parsed.data.id} (in_progress または見つかりません)`;

        logger.info(`[MetaCognition] 📋 サブタスク削除: ${parsed.data.id} — ${parsed.data.reason}`, 'cyan');
        return `${parsed.data.id} を削除しました`;
    }

    private toolReorderSubtask(args: Record<string, unknown>): string {
        const parsed = ReorderSubtaskSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const success = this.blackboard.reorderSubtask(parsed.data.id, parsed.data.position);
        if (!success) return `並べ替え失敗: ${parsed.data.id}`;

        logger.info(`[MetaCognition] 📋 サブタスク並替: ${parsed.data.id} → 位置${parsed.data.position}`, 'cyan');
        return `${parsed.data.id} を位置${parsed.data.position}に移動しました`;
    }

    private toolSetActiveSubtask(args: Record<string, unknown>): string {
        const parsed = SetActiveSubtaskSchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const success = this.blackboard.setActiveSubtask(parsed.data.id);
        if (!success) return `切替失敗: ${parsed.data.id} が見つかりません`;

        logger.info(`[MetaCognition] 📋 アクティブ切替: → ${parsed.data.id}`, 'cyan');
        return `アクティブサブタスクを ${parsed.data.id} に切り替えました`;
    }

    private toolUpdateStrategy(args: Record<string, unknown>): string {
        const parsed = UpdateStrategySchema.safeParse(args);
        if (!parsed.success) return `パラメータエラー: ${parsed.error.message}`;

        const plan = this.blackboard.plan;
        if (!plan) return 'プランがありません';

        this.blackboard.updatePlan({
            ...plan,
            strategy: parsed.data.strategy,
            lastUpdatedBy: 'meta_cognition',
        });
        logger.info(`[MetaCognition] 📋 戦略更新: ${parsed.data.strategy.substring(0, 60)}`, 'cyan');
        return `戦略を更新しました`;
    }

    // ── Assessment Actions ──

    private applyAssessment(meta: MetaState): void {
        // モデルエスカレーション/デエスカレーション
        if (meta.modelAction === 'escalate') {
            this.modelSelector.escalate('MetaCognition: ' + (meta.suggestion || meta.assessment));
        } else if (meta.modelAction === 'deescalate') {
            this.modelSelector.deescalate('MetaCognition: ' + (meta.suggestion || meta.assessment));
        }

        // wrong_approach / stuck → 実行中スキルを中断
        if ((meta.assessment === 'wrong_approach' || meta.assessment === 'stuck') && this.interruptCallback) {
            const now = Date.now();
            if (now - this.lastInterruptTime >= MetaCognitionLoop.INTERRUPT_COOLDOWN_MS) {
                logger.warn(`[MetaCognition] ⚡ ${meta.assessment} → 実行中スキルを中断`);
                this.interruptCallback();
                this.lastInterruptTime = now;
            }
        }

        // 連続失敗による自動エスカレーション
        if (this.reward.consecutiveFailures >= 5 && meta.modelAction !== 'escalate') {
            logger.warn(`[MetaCognition] ⚡ 連続失敗${this.reward.consecutiveFailures}回 → 自動エスカレーション`);
            this.modelSelector.escalate('RewardTracker: 連続失敗5+');
        }

        // 連続成功による自動デエスカレーション
        if (this.reward.consecutiveSuccesses >= 8 && meta.modelAction !== 'deescalate') {
            logger.info(`[MetaCognition] 💰 連続成功${this.reward.consecutiveSuccesses}回 → 自動デエスカレーション`);
            this.modelSelector.deescalate('RewardTracker: 連続成功8+');
        }

        // タスク停止
        if (meta.shouldStop) {
            logger.warn('[MetaCognition] ⛔ タスク停止を判断');
            this.blackboard.complete();
        }
    }

    // ── Prompt Builder ──

    private buildEvalPrompt(snapshot: BlackboardSnapshot, trigger: string): string {
        const recentCalls = snapshot.taskState.recentToolCalls.slice(-10);
        const toolCallsSummary = recentCalls.map((r, i) =>
            `${i + 1}. ${r.toolName}(${JSON.stringify(r.args).substring(0, 80)}): ${r.success ? '成功' : `失敗 [${r.failureType ?? 'unknown'}]`} — ${r.message.substring(0, 100)}`,
        ).join('\n');

        const failureRate = recentCalls.length > 0
            ? recentCalls.filter(r => !r.success).length / recentCalls.length
            : 0;

        const inventoryInfo = this.formatInventory(snapshot.selfState.inventory);
        const planInfo = this.formatPlanFull(snapshot.plan);
        // snapshot は Step 1 の前に取得しているため、Step 1 で更新した最新の journalSummary は
        // blackboard から直接読む
        const journalSummary = this.blackboard.plan?.journalSummary || snapshot.plan?.journalSummary || '';
        const vitalInfo = snapshot.selfState.vitalAlerts.length > 0
            ? `\n# ⚠️ 生存アラート\n${snapshot.selfState.vitalAlerts.join('\n')}`
            : '';

        return [
            journalSummary ? `# 旅程サマリー\n${journalSummary}` : '',
            '',
            `# 現在の状況`,
            `- 目標: ${snapshot.goal}`,
            `- イテレーション: ${snapshot.taskState.iteration}`,
            `- 経過時間: ${Math.round(snapshot.elapsedMs / 1000)}秒`,
            `- 現在のモデル: ${this.modelSelector.modelName}`,
            `- 成功/失敗: ${snapshot.taskState.totalSuccesses}/${snapshot.taskState.totalFailures}`,
            `- 直近の失敗率: ${Math.round(failureRate * 100)}%`,
            `- 連続成功: ${this.reward.consecutiveSuccesses}回`,
            `- 連続失敗: ${this.reward.consecutiveFailures}回`,
            `- 評価トリガー: ${trigger}`,
            snapshot.emotionState ? `- 現在の感情: ${snapshot.emotionState.emotion}` : '',
            snapshot.taskState.currentThinking ? `- 最新の思考: ${snapshot.taskState.currentThinking.substring(0, 200)}` : '',
            inventoryInfo,
            vitalInfo,
            planInfo,
            '',
            `# 直近のツール呼び出し履歴`,
            toolCallsSummary || '(まだなし)',
        ].filter(Boolean).join('\n');
    }

    // ── Formatters ──

    private formatInventory(inventory: import('./CognitiveBlackboard.js').InventoryEntry[] | null): string {
        if (!inventory || inventory.length === 0) return '';
        const summary = inventory.slice(0, 20).map(e => `${e.name}x${e.count}`).join(', ');
        const suffix = inventory.length > 20 ? ` ...他${inventory.length - 20}種` : '';
        return `\n# 現在のインベントリ\n${summary}${suffix}\n※ 目標達成に使える素材が既にあるなら、新たに採掘せずそれを活用すべき`;
    }

    private formatPlanFull(plan: import('./CognitiveBlackboard.js').PlanState | null): string {
        if (!plan || plan.subtasks.length === 0) return '';
        const lines = this.formatSubtaskTree(plan.subtasks, 0);
        return `\n# 現在のプラン\n  戦略: ${plan.strategy}\n  現在のサブタスク: ${plan.currentSubtaskId ?? 'なし'}\n${lines}`;
    }

    private formatSubtaskTree(subtasks: PlanSubtask[], depth: number): string {
        const indent = '  '.repeat(depth + 1);
        return subtasks.map(st => {
            const icon = { pending: '⬜', in_progress: '🔄', completed: '✅', error: '❌', skipped: '⏭️' }[st.status];
            const iterInfo = st.iterationsSpent > 0 ? ` (${st.iterationsSpent}iter)` : '';
            const extra = st.failureReason ? ` — ${st.failureReason}` : st.result ? ` — ${st.result}` : '';
            const line = `${indent}${icon} ${st.id}: ${st.goal}${iterInfo}${extra}`;
            const childLines = st.children.length > 0 ? '\n' + this.formatSubtaskTree(st.children, depth + 1) : '';
            return line + childLines;
        }).join('\n');
    }

    /** コンパクト表示 (サマリー更新用) */
    private formatSubtasksCompact(subtasks: PlanSubtask[]): string {
        return subtasks.map(st => {
            const icon = { pending: '⬜', in_progress: '🔄', completed: '✅', error: '❌', skipped: '⏭️' }[st.status];
            const children = st.children.length > 0 ? ` [${st.children.length}子]` : '';
            return `${icon}${st.id}:${st.goal}${children}`;
        }).join(', ');
    }

    // ── Reward Tracker ──

    private updateRewardTracker(snapshot: BlackboardSnapshot): void {
        const recentCalls = snapshot.taskState.recentToolCalls;
        if (recentCalls.length === 0) return;

        let consecutiveSuccesses = 0;
        let consecutiveFailures = 0;

        for (let i = recentCalls.length - 1; i >= 0; i--) {
            if (recentCalls[i].success) {
                if (consecutiveFailures > 0) break;
                consecutiveSuccesses++;
            } else {
                if (consecutiveSuccesses > 0) break;
                consecutiveFailures++;
            }
        }

        const prevFailures = this.reward.consecutiveFailures;
        const prevSuccesses = this.reward.consecutiveSuccesses;

        if (consecutiveSuccesses > prevSuccesses && prevFailures > 0) {
            this.reward.recentRewardSignals.push({
                type: 'positive',
                magnitude: Math.min(prevFailures, 5),
                iteration: snapshot.taskState.iteration,
            });
        } else if (consecutiveFailures > prevFailures && prevSuccesses > 0) {
            this.reward.recentRewardSignals.push({
                type: 'negative',
                magnitude: Math.min(prevSuccesses, 5),
                iteration: snapshot.taskState.iteration,
            });
        }

        if (this.reward.recentRewardSignals.length > 10) {
            this.reward.recentRewardSignals = this.reward.recentRewardSignals.slice(-10);
        }

        this.reward.consecutiveSuccesses = consecutiveSuccesses;
        this.reward.consecutiveFailures = consecutiveFailures;
    }

    private checkStagnation(current: MetaAssessment): MetaAssessment {
        const threshold = MetaCognitionLoop.STAGNATION_THRESHOLD;
        if (current === 'on_track' || this.assessmentHistory.length < threshold) return current;
        const recentN = this.assessmentHistory.slice(-threshold);
        if (!recentN.every(a => a === current)) return current;

        if (current === 'struggling') {
            logger.warn(`[MetaCognition] ⚡ struggling が${threshold + 1}回連続 → stuck に自動エスカレーション`);
            return 'stuck';
        }
        if (current === 'stuck') {
            logger.warn(`[MetaCognition] ⚡ stuck が${threshold + 1}回連続 → wrong_approach に自動エスカレーション`);
            return 'wrong_approach';
        }
        return current;
    }
}
