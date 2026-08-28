import { selectAllowedTools } from '../../../../modules/access/toolSelection.js';
import {
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { HierarchicalSubTask, TaskContext, TaskTreeState } from '@shannon/common';
import { setMaxListeners } from 'node:events';
import { config } from '../../../../config/env.js';
import { modelManager } from '../../../../config/modelManager.js';
import { logger } from '../../../../utils/logger.js';
import { getEventBus } from '../../../eventBus/index.js';
import { WorldKnowledgeService } from '../../../minebot/knowledge/WorldKnowledgeService.js';
import { RecipeDependencyResolver } from '../../../minebot/knowledge/RecipeDependencyResolver.js';
import { TaskEpisodeMemory } from '../cognitive/TaskEpisodeMemory.js';
import UpdatePlanTool from '../../tools/utility/updatePlan.js';
import { trimContext } from '../../utils/contextManager.js';
import { createTracedModel } from '../../utils/langfuse.js';
import { tokenTracker } from '../../utils/tokenTracker.js';
import { ExecutionResult } from '../types.js';
import { EmotionState } from './EmotionNode.js';
import { MemoryState } from './MemoryNode.js';
import { PromptBuilder } from './prompt/PromptBuilder.js';
import { TaskTreePublisher } from './execution/TaskTreePublisher.js';
import { ThinkingManager } from './execution/ThinkingManager.js';
import { ToolExecutor } from './execution/ToolExecutor.js';
import { LoopDetector } from './execution/LoopDetector.js';
import { ModelSelector } from '../cognitive/ModelSelector.js';

function stripAssistantContentPrefix(t: string): string {
    return t.replace(/^content:\s*/i, '').trim();
}

/**
 * FunctionCallingAgent の run() に渡す状態
 */
export interface FunctionCallingAgentState {
    taskId: string;
    userMessage: string | null;
    messages: BaseMessage[];
    emotionState: EmotionState;
    memoryState?: MemoryState;
    context: TaskContext | null;
    channelId: string | null;
    environmentState: string | null;
    isEmergency: boolean;
    /** Pre-formatted memory prompt from ScopedMemoryService (replaces memoryState when set) */
    memoryPrompt?: string;
    relationshipPrompt?: string;
    selfModelPrompt?: string;
    strategyPrompt?: string;
    internalStatePrompt?: string;
    worldModelPrompt?: string;

    /** ツール実行後に呼ばれるコールバック（非同期感情再評価のトリガー） */
    onToolsExecuted: (
        messages: BaseMessage[],
        results: ExecutionResult[]
    ) => void;

    /** 音声向け: 使用を許可するツール名リスト。指定時はこれ以外のツールは bind しない */
    allowedTools?: string[];
    /** 音声向け: 各ツール実行直前に呼ばれるコールバック */
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    /** Minebot UI 同期向け: taskTree 更新のたびに呼ばれるコールバック */
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    /** 音声向け: LLMストリーミング中に1文完成するたびに呼ばれるコールバック */
    onStreamSentence?: (sentence: string) => Promise<void>;
    /** 動的モデル選択: ClassifyNode の結果に基づくモデル名 */
    selectedModel?: string;
    /** メタ認知等から現在実行中のスキルを中断するためのコールバック */
    onRequestSkillInterrupt?: () => void;
    /** Minecraft: bot から実インベントリをリアルタイム取得するコールバック */
    getLiveInventory?: () => import('@shannon/common').MinecraftInventoryEntry[];
    /** Minecraft: bot のアクティブなステータスエフェクトを取得するコールバック */
    getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
    /** ClassifyNode からの分類結果 */
    classifyMode?: string;
    needsTools?: boolean;
    needsPlanning?: boolean;
    /** イテレーション毎に最新のインベントリ差分を返すコールバック */
    getInventoryDiff?: () => string | null;
    /** Blackboard から最新の journalSummary を取得するコールバック */
    getJournalSummary?: () => string | null;
    /** Blackboard から最新のアクティブサブタスク情報を取得するコールバック */
    getActiveSubtaskInfo?: () => string | null;
    /** MemoryAgent からの初期記憶コンテキストを取得するコールバック (初回のみ) */
    getInitialMemory?: () => Promise<string | null>;
    /** SubTaskExecutor: FCA の最大イテレーション数をオーバーライド */
    maxIterations?: number;
}

/**
 * Function Calling Agent (Discord/WebUI版)
 *
 * minebot版をベースに、Discord/WebUI用に適応。
 * OpenAI の function calling (tool_use) を使い、LLM が直接ツールを呼び出す。
 *
 * 特徴:
 * - ツール定義は API の `tools` パラメータで渡す（プロンプトに埋め込まない）
 * - 各イテレーションで最新の感情状態を読み込み（擬似並列）
 * - update-plan ツールでLLMが自発的に計画を立てる + 自動ステップ記録
 * - EventBus 経由でUI通知
 *
 * フロー:
 * 1. システムプロンプト（感情 + コンテキスト + ルール）+ ユーザーメッセージを構築
 * 2. LLM に tools を bind して呼び出し
 * 3. tool_calls があれば実行し、ToolMessage で結果を返す → 非同期感情再評価をトリガー
 * 4. tool_calls がなければタスク完了
 * 5. 2-4 を繰り返す
 */
export class FunctionCallingAgent {
    private model: ChatOpenAI | ChatAnthropic;
    private modelWithTools: ReturnType<ChatOpenAI['bindTools']> | ReturnType<ChatAnthropic['bindTools']>;
    private tools: StructuredTool[];
    private toolMap: Map<string, StructuredTool>;
    private updatePlanTool: UpdatePlanTool | null = null;

    // Sub-components
    private promptBuilder: PromptBuilder;
    private taskTreePublisher: TaskTreePublisher;
    private thinkingManager: ThinkingManager;
    private toolExecutor: ToolExecutor;
    private loopDetector: LoopDetector;

    // ユーザーからのリアルタイムフィードバック
    private pendingFeedback: string[] = [];

    // プラン更新通知（メタ認知からの注入用）
    private _pendingPlanUpdate: string | null = null;

    // ナッジメッセージ（エフェメラル注入用）
    private _pendingNudge: string | null = null;

    private blackboardAccessor: (() => { freeSlots?: number | null; activeEffects?: Array<{ name: string; amplifier: number }> }) | null = null;

    /** RoutineManager 参照（循環参照回避: LLMService.registerRoutineTools 経由で設定） */
    private _routineManager: { get(name: string): any; getAll(): any[] } | null = null;

    // === 設定 ===
    static get MODEL_NAME() { return modelManager.get('functionCalling'); }
    static readonly MAX_ITERATIONS = 25;
    static readonly MAX_ITERATIONS_EMERGENCY = 15;
    static readonly LLM_TIMEOUT_MS_DEFAULT = 30000;
    static readonly MAX_TOTAL_TIME_MS = 300000; // 全体: 5分

    constructor(tools: StructuredTool[]) {
        const eventBus = getEventBus();
        this.tools = tools;
        this.toolMap = new Map(tools.map((t) => [t.name, t]));

        // update-plan ツールを探す
        const planTool = tools.find((t) => t.name === 'update-plan');
        if (planTool && planTool instanceof UpdatePlanTool) {
            this.updatePlanTool = planTool;
        }

        // Claude Anthropic を優先、フォールバックで OpenAI
        if (config.anthropic?.apiKey) {
            this.model = new ChatAnthropic({
                model: 'claude-opus-4-20250514',
                anthropicApiKey: config.anthropic.apiKey,
                temperature: 1,
                maxTokens: 16384,
                streaming: true,
            });
            logger.info('🧠 FCA: Using Claude Opus 4.6 (Anthropic)', 'magenta');
        } else {
            this.model = createTracedModel({
                modelName: FunctionCallingAgent.MODEL_NAME,
                apiKey: config.openaiApiKey,
                temperature: 1,
                maxTokens: 1024,
            });
            logger.info('🤖 FCA: Using OpenAI (Anthropic key not configured)', 'yellow');
        }

        // ツールをモデルに bind
        this.modelWithTools = this.model.bindTools(this.tools);

        // Sub-components
        this.promptBuilder = new PromptBuilder();
        this.taskTreePublisher = new TaskTreePublisher(eventBus);
        this.thinkingManager = new ThinkingManager();
        this.toolExecutor = new ToolExecutor(this.taskTreePublisher);
        this.loopDetector = new LoopDetector();

        logger.info(`🤖 FunctionCallingAgent(Web/Discord): model=${FunctionCallingAgent.MODEL_NAME}, tools=${tools.length}`, 'cyan');
    }

    public addTools(tools: StructuredTool[]): void {
        let added = 0;
        for (const tool of tools) {
            if (this.toolMap.has(tool.name)) continue;
            this.tools.push(tool);
            this.toolMap.set(tool.name, tool);
            added += 1;
            if (tool.name === 'update-plan' && tool instanceof UpdatePlanTool) {
                this.updatePlanTool = tool;
            }
        }

        if (added > 0) {
            this.modelWithTools = this.model.bindTools(this.tools);
            logger.info(`🔧 FunctionCallingAgent: added ${added} tools (total=${this.tools.length})`, 'cyan');
        }
    }

    public getToolNames(): string[] {
        return [...this.toolMap.keys()];
    }

    /**
     * CognitiveBlackboard のアクセサを TaskTreePublisher に転送する。
     * ParallelExecutor から呼び出される。
     */
    public setBlackboardAccessor(fn: Parameters<typeof this.taskTreePublisher.setBlackboardAccessor>[0]): void {
        this.taskTreePublisher.setBlackboardAccessor(fn);
        this.blackboardAccessor = fn as typeof this.blackboardAccessor;
    }

    /** 登録済みツール一覧を返す (ParallelExecutor が MemoryAgent 等を注入するために使用) */
    getTools(): StructuredTool[] {
        return this.tools;
    }

    // ─── メッセージ互換性 ───

    /**
     * Anthropic API は SystemMessage を最初の1つしか受け付けない。
     * 2つ目以降の SystemMessage を HumanMessage に変換する。
     * OpenAI の場合はそのまま返す。
     */
    private sanitizeMessagesForProvider(messages: BaseMessage[]): BaseMessage[] {
        if (!(this.model instanceof ChatAnthropic)) return messages;

        let firstSystemSeen = false;
        return messages.map(msg => {
            if (msg instanceof SystemMessage) {
                if (!firstSystemSeen) {
                    firstSystemSeen = true;
                    return msg; // 最初の SystemMessage はそのまま
                }
                // 2つ目以降は HumanMessage に変換
                return new HumanMessage({ content: `[System Context] ${msg.content}` });
            }
            return msg;
        });
    }

    // ─── Routine 関連 ───

    public setRoutineManager(manager: typeof this._routineManager): void {
        this._routineManager = manager;
        this.promptBuilder.setRoutineManager(manager as any);
    }

    /** ルーチンがカバーするスキルのマップを構築 (skill名 → カバーするルーチン名[]) */
    private buildRoutineCoverageMap(tools: StructuredTool[]): Map<string, string[]> {
        const coverage = new Map<string, string[]>();
        if (!this._routineManager) return coverage;

        for (const tool of tools) {
            if (!tool.name.startsWith('routine:')) continue;
            const def = this._routineManager.get(tool.name.replace('routine:', ''));
            if (!def) continue;
            for (const step of def.steps) {
                if ('skill' in step && typeof step.skill === 'string') {
                    const existing = coverage.get(step.skill) || [];
                    existing.push(`routine:${(def as any).name}`);
                    coverage.set(step.skill, existing);
                }
            }
        }
        return coverage;
    }

    /** スキルツールの description を短縮し、対応ルーチンを案内する */
    private wrapWithShortenedDescription(tool: StructuredTool, routineNames: string[]): StructuredTool {
        const routineHint = routineNames.slice(0, 2).join(' or ');
        const shortened = Object.create(tool) as StructuredTool;
        Object.defineProperty(shortened, 'description', {
            get: () => `${tool.description.slice(0, 60).trim()}… Prefer ${routineHint} for common patterns.`,
            configurable: true,
        });
        return shortened;
    }

    /**
     * メタ認知等からプラン更新を通知する。次のLLM呼び出し時にエフェメラルとして注入される。
     */
    public notifyPlanUpdated(planSummary: string): void {
        this._pendingPlanUpdate = planSummary;
    }

    /**
     * ユーザーフィードバックを追加（実行中に呼ばれる）。
     * 重複排除: 既にキューにある内容と類似していれば最新のもので上書きする。
     */
    public addFeedback(feedback: string): void {
        if (this.pendingFeedback.length > 0) {
            const last = this.pendingFeedback[this.pendingFeedback.length - 1];
            if (last.startsWith('[メタ認知]') && feedback.startsWith('[メタ認知]')) {
                this.pendingFeedback[this.pendingFeedback.length - 1] = feedback;
                logger.warn(`📝 FunctionCallingAgent: メタ認知フィードバック上書き: ${feedback}`);
                return;
            }
        }
        this.pendingFeedback.push(feedback);
        logger.warn(`📝 FunctionCallingAgent: フィードバック追加: ${feedback}`);
    }

    /**
     * メインの実行ループ
     */
    async run(
        state: FunctionCallingAgentState,
        signal?: AbortSignal,
    ): Promise<{
        taskTree: TaskTreeState;
        recoveryStatus?: 'idle' | 'awaiting_user' | 'failed_terminal';
        recoveryAttempts?: number;
        lastFailureType?: string;
        isEmergency?: boolean;
        messages: BaseMessage[];
        forceStop: boolean;
        /** ユーザー向け応答文（task-complete 時の最後の assistant content） */
        lastAssistantContent?: string;
    }> {
        signal?.throwIfAborted();
        const startTime = Date.now();
        const goal = state.userMessage || 'Unknown task';
        const isEmergency = state.isEmergency || false;
        let activeCallAbort: AbortController | null = null;
        const onParentAbort = () => activeCallAbort?.abort();
        this.relaxAbortSignalListenerLimit(signal);

        this.thinkingManager.resetThinkingState();
        this.loopDetector.reset();

        // 動的モデル選択 (RAS / ModelSelector)
        const modelSelector = new ModelSelector(state.selectedModel || FunctionCallingAgent.MODEL_NAME);
        const platform = state.context?.platform ?? null;
        if (platform === 'minecraft' || platform === 'minebot') {
            modelSelector.setMaxEscalationLevel('gpt-5-mini-fast');
        }
        logger.info(`🤖 FunctionCallingAgent: タスク実行開始 "${goal}"${isEmergency ? ' [緊急]' : ''} (model=${modelSelector.modelName})`, 'cyan');
        if (signal) {
            signal.addEventListener('abort', onParentAbort, { once: true });
        }

        // allowedTools が指定されている場合、フィルタリングした modelWithTools を使う
        let effectiveTools = [...this.tools];
        let effectiveToolMap = new Map(this.toolMap);
        if (state.allowedTools !== undefined) {
            effectiveTools = selectAllowedTools(this.tools, state.allowedTools);
            effectiveToolMap = new Map(effectiveTools.map(t => [t.name, t]));
            logger.info(`🔒 allowedTools: ${state.allowedTools.join(', ')} (${effectiveTools.length}/${this.tools.length})`, 'cyan');
        }

        // Phase 2-D: Minecraft はプラットフォーム非関連ツールを除外（入力トークン -1600〜3200）
        if (platform === 'minecraft' || platform === 'minebot') {
            const NON_MINECRAFT_TOOLS = new Set([
                'post-on-twitter', 'like-tweet', 'retweet-tweet', 'quote-retweet',
                'get-x-or-twitter-post-content-from-url', 'generate-tweet-text',
                'chat-on-discord', 'get-discord-recent-messages',
                'get-server-emoji-on-discord', 'react-by-server-emoji-on-discord', 'get-discord-images',
                'chat-on-web',
                'get-youtube-video-content-from-url',
                'get-notion-page-content-from-url',
                'create-image', 'describe-image', 'edit-image', 'describe-notion-image',
                'google-search', 'search-by-wikipedia', 'search-weather', 'wolframalpha', 'fetch-url',
            ]);
            const beforeCount = effectiveTools.length;
            effectiveTools = effectiveTools.filter(t => !NON_MINECRAFT_TOOLS.has(t.name));
            effectiveToolMap = new Map(effectiveTools.map(t => [t.name, t]));
            if (effectiveTools.length < beforeCount) {
                logger.info(`🎮 Minecraft ツールフィルタ: ${beforeCount} → ${effectiveTools.length} ツール`, 'cyan');
            }
        }

        // Phase: ルーチンカバレッジによるスキル description 短縮（トークン削減）
        if (platform === 'minecraft' || platform === 'minebot') {
            const routineCoveredSkills = this.buildRoutineCoverageMap(effectiveTools);
            if (routineCoveredSkills.size > 0) {
                effectiveTools = effectiveTools.map(tool => {
                    const coveringRoutines = routineCoveredSkills.get(tool.name);
                    if (coveringRoutines && coveringRoutines.length > 0) {
                        return this.wrapWithShortenedDescription(tool, coveringRoutines);
                    }
                    return tool;
                });
                effectiveToolMap = new Map(effectiveTools.map(t => [t.name, t]));
            }
        }

        const channelOutputTools = this.promptBuilder.getDisabledOutputTools(state.context);
        if (channelOutputTools.length > 0) {
            effectiveTools = effectiveTools.filter(
                (tool) => !channelOutputTools.includes(tool.name),
            );
            effectiveToolMap = new Map(effectiveTools.map((tool) => [tool.name, tool]));
        }

        // ModelSelector にツールをバインド
        let effectiveModelWithTools = modelSelector.bindTools(effectiveTools);

        // update-plan ツールにコンテキストを設定
        if (this.updatePlanTool) {
            this.updatePlanTool.setContext(state.channelId, state.taskId);
        }

        // メッセージ構築
        let systemPrompt = this.promptBuilder.buildSystemPrompt(
            state.emotionState,
            state.context,
            state.environmentState,
            state.memoryState,
            state.memoryPrompt,
            state.relationshipPrompt,
            state.selfModelPrompt,
            state.strategyPrompt,
            state.internalStatePrompt,
            state.worldModelPrompt,
            state.classifyMode,
            state.needsTools,
        );

        // Phase 3-A: Minecraft 事前準備を並列化（WorldKnowledge + TaskEpisodeMemory: -0.5〜1.5秒）
        {
            const isMinecraft = platform === 'minecraft' || platform === 'minebot';

            // 並列タスク群を構築
            const parallelTasks: Promise<string | null>[] = [];

            // 1. WorldKnowledge (Minecraft のみ)
            if (isMinecraft) {
                parallelTasks.push(
                    (async () => {
                        try {
                            const envObj = state.environmentState ? JSON.parse(state.environmentState) : null;
                            if (envObj?.botPosition) {
                                const wk = WorldKnowledgeService.getInstance();
                                const pos = envObj.botPosition;
                                return await wk.buildContextForPosition(
                                    { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
                                    64,
                                );
                            }
                        } catch { }
                        return null;
                    })(),
                );
            }

            // 2. TaskEpisodeMemory (全プラットフォーム)
            parallelTasks.push(
                (async () => {
                    try {
                        const episodeMemory = TaskEpisodeMemory.getInstance();
                        const episodes = await episodeMemory.recallRelevantEpisodes(
                            goal,
                            state.context?.platform ?? 'unknown',
                        );
                        return episodeMemory.formatForPrompt(episodes) || null;
                    } catch { }
                    return null;
                })(),
            );

            // 並列実行
            const results = await Promise.all(parallelTasks);

            // 結果をシステムプロンプトに注入
            for (const result of results) {
                if (result) systemPrompt += `\n\n${result}`;
            }

            if (isMinecraft) {
                try {
                    const mcMeta = state.context?.metadata?.minecraft as Record<string, unknown> | undefined;
                    const inventory = Array.isArray(mcMeta?.inventory)
                        ? (mcMeta!.inventory as Array<{ name: string; count: number }>)
                        : null;
                    const depPrompt = this.buildCraftDependencyPrompt(goal, inventory);
                    if (depPrompt) {
                        systemPrompt += depPrompt;
                    }
                } catch { }
            }
        }

        const messages: BaseMessage[] = [
            new SystemMessage(systemPrompt),
        ];

        // 会話履歴を追加（コンテキストとして）
        if (state.messages && state.messages.length > 0) {
            const historyMessages = state.messages.slice(-10, -1);
            const historyLines = historyMessages
                .filter((msg) => msg instanceof HumanMessage)
                .map((msg) => typeof msg.content === 'string' ? msg.content : '')
                .filter((c) => c.length > 0);
            if (historyLines.length > 0) {
                messages.push(
                    new SystemMessage(
                        `【最近の会話履歴（参考情報）】\n${historyLines.join('\n')}\n\n↑ 上記は過去の会話です。以下の最新メッセージに返信してください。`,
                    ),
                );
            }
        }

        // ユーザーメッセージ（これに返信する）
        messages.push(new HumanMessage(goal));

        // プロンプトサイズを計測
        const totalChars = messages.reduce(
            (sum, m) => sum + String(m.content).length,
            0,
        );
        logger.info(`📏 System prompt: ${totalChars}文字`, 'cyan');

        // タスクツリー（UI表示用: 自動ステップ記録）
        const steps: HierarchicalSubTask[] = [];
        let stepCounter = 0;
        let iteration = 0;
        let pendingRecoveryFailure: ExecutionResult | null = null;
        let lastRecoverableFailure: ExecutionResult | null = null;
        let forcedRecoveryAttempts = 0;
        let consecutiveTextOnly = 0;
        const MAX_CONSECUTIVE_TEXT_ONLY = 3;
        let lastThinkingContent: string | null = null;
        let consecutiveBlockedOnly = 0;
        const MAX_CONSECUTIVE_BLOCKED_ONLY = 5;

        // 初期 UI 更新
        this.taskTreePublisher.publishTaskTree({
            status: 'in_progress',
            goal,
            strategy: 'Function Calling Agent で実行中',
            hierarchicalSubTasks: [],
            currentSubTaskId: null,
        }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

        try {
            const maxIter = state.maxIterations
                ?? (isEmergency ? FunctionCallingAgent.MAX_ITERATIONS_EMERGENCY : FunctionCallingAgent.MAX_ITERATIONS);
            while (iteration < maxIter) {
                // ── 中断チェック ──
                if (signal?.aborted) throw new Error('Task aborted');

                if (Date.now() - startTime > FunctionCallingAgent.MAX_TOTAL_TIME_MS) {
                    logger.error('⏱ FunctionCallingAgent: 総実行時間超過 (5分)');
                    break;
                }

                // ── ユーザーフィードバック（最新のみエフェメラル注入用に保持） ──
                let latestFeedback: string | null = null;
                if (this.pendingFeedback.length > 0) {
                    // 最新のフィードバックのみ使用し、古いものは破棄
                    latestFeedback = this.pendingFeedback[this.pendingFeedback.length - 1];
                    this.pendingFeedback.length = 0;
                    logger.warn(`📝 フィードバックをエフェメラル注入: ${latestFeedback}`);
                }

                // ── コンテキストウィンドウのトリミング ──
                const trimmed = trimContext(messages, { maxContextTokens: 16000 });
                if (trimmed.length < messages.length) {
                    logger.debug(`コンテキストトリミング: ${messages.length} → ${trimmed.length} メッセージ`);
                    messages.length = 0;
                    messages.push(...trimmed);
                }

                // ── 一時的な思考/感情コンテキストを注入（LLM呼び出し後に除去） ──
                const ephemeralMessages: BaseMessage[] = [];
                // ── 初期記憶コンテキスト (初回のみ) ──
                if (iteration === 0 && state.getInitialMemory) {
                    try {
                        const initialMem = await state.getInitialMemory();
                        if (initialMem) {
                            ephemeralMessages.push(new SystemMessage(`【初期記憶コンテキスト】\n${initialMem}`));
                        }
                    } catch { /* optional */ }
                }
                if (iteration > 0 && this.thinkingManager.hasThoughts()) {
                    const thinkingContext = this.thinkingManager.buildThinkingContext();
                    if (thinkingContext) {
                        const msg = new SystemMessage(thinkingContext);
                        ephemeralMessages.push(msg);
                    }
                }
                if (iteration > 0 && state.emotionState.current) {
                    const msg = new SystemMessage(
                        `[感情更新] 現在の感情: ${state.emotionState.current.emotion} ` +
                        `(joy=${state.emotionState.current.parameters.joy}, ` +
                        `trust=${state.emotionState.current.parameters.trust}, ` +
                        `anticipation=${state.emotionState.current.parameters.anticipation})`
                    );
                    ephemeralMessages.push(msg);
                }
                // ── インベントリ差分注入（Minecraft: LLMに在庫の変化を認識させる） ──
                if (iteration > 0 && state.getInventoryDiff) {
                    const inventoryDiff = state.getInventoryDiff();
                    if (inventoryDiff) {
                        ephemeralMessages.push(new SystemMessage(inventoryDiff));
                    }
                }
                // ── ステータスエフェクト注入 ──
                if (this.blackboardAccessor) {
                    const effects = this.blackboardAccessor()?.activeEffects;
                    if (effects && effects.length > 0) {
                        const effectText = effects.map(e => `${e.name}(Lv${e.amplifier + 1})`).join(', ');
                        ephemeralMessages.push(new SystemMessage(`⚠️ 【アクティブ状態効果】${effectText}`));
                    }
                }
                // ── フィードバックをエフェメラル注入 ──
                if (latestFeedback) {
                    ephemeralMessages.push(new HumanMessage(`ユーザーからのフィードバック: ${latestFeedback}`));
                }
                // ── journalSummary 注入 ──
                if (state.getJournalSummary) {
                    const summary = state.getJournalSummary();
                    if (summary) {
                        ephemeralMessages.push(new SystemMessage(`【旅程サマリー】\n${summary}`));
                    }
                }
                // ── 現在のサブタスク注入 ──
                if (state.getActiveSubtaskInfo) {
                    const info = state.getActiveSubtaskInfo();
                    if (info) {
                        ephemeralMessages.push(new SystemMessage(info));
                    }
                }
                // ── プラン更新通知注入 ──
                if (this._pendingPlanUpdate) {
                    ephemeralMessages.push(new SystemMessage(`【プラン更新】\n${this._pendingPlanUpdate}`));
                    this._pendingPlanUpdate = null;
                }
                // ── ナッジメッセージ注入（前回イテレーションからの繰越） ──
                if (this._pendingNudge) {
                    ephemeralMessages.push(new SystemMessage(this._pendingNudge));
                    this._pendingNudge = null;
                }
                messages.push(...ephemeralMessages);

                // ── LLM 呼び出し（タイムアウト付き） ──
                const callAbort = new AbortController();
                const currentTimeoutMs = modelSelector.timeoutMs;
                const callTimeout = setTimeout(
                    () => callAbort.abort(),
                    currentTimeoutMs,
                );
                activeCallAbort = callAbort;
                this.relaxAbortSignalListenerLimit(callAbort.signal);

                const llmStart = Date.now();
                let response: AIMessage;

                // Anthropic API: SystemMessage は最初の1つのみ許可。
                // 2つ目以降の SystemMessage を HumanMessage に変換する。
                const sanitizedMessages = this.sanitizeMessagesForProvider(messages);

                try {
                    if (state.onStreamSentence) {
                        response = await this.streamLlmResponse(
                            effectiveModelWithTools as any, sanitizedMessages, callAbort.signal, state.onStreamSentence,
                        );
                    } else {
                        response = (await (effectiveModelWithTools as any).invoke(sanitizedMessages, {
                            signal: callAbort.signal,
                        })) as AIMessage;
                    }
                    clearTimeout(callTimeout);
                    const usage = (response as AIMessage & { usage_metadata?: { input_tokens?: number; output_tokens?: number } })?.usage_metadata;
                    if (usage) {
                        tokenTracker.record(
                            modelSelector.modelName || 'unknown',
                            'FunctionCallingAgent',
                            usage.input_tokens || 0,
                            usage.output_tokens || 0,
                        ).catch(() => { });
                    }
                    logger.success(`⏱ LLM応答: ${Date.now() - llmStart}ms (iteration ${iteration + 1})`);
                } catch (e: unknown) {
                    clearTimeout(callTimeout);
                    activeCallAbort = null;
                    if (signal?.aborted) throw new Error('Task aborted');
                    if ((e instanceof Error && e.name === 'AbortError') || callAbort.signal.aborted) {
                        throw new Error(
                            `LLM timeout (${currentTimeoutMs / 1000}s)`,
                        );
                    }
                    throw e;
                }
                activeCallAbort = null;

                // ephemeral メッセージを除去（蓄積防止）
                if (ephemeralMessages.length > 0) {
                    messages.splice(messages.length - ephemeralMessages.length, ephemeralMessages.length);
                }

                messages.push(response);

                // ── 思考過程を記録（content があれば） ──
                const thinkingContent =
                    typeof response.content === 'string' ? response.content : '';
                if (thinkingContent) {
                    lastThinkingContent = thinkingContent;
                    this.thinkingManager.addThought(thinkingContent);
                    logger.info(`💭 思考: ${thinkingContent.substring(0, 150)}`, 'cyan');
                    await this.thinkingManager.maybeSummarizeThinking(FunctionCallingAgent.MODEL_NAME);
                    if (state.context?.platform === 'minecraft' || state.context?.platform === 'minebot') {
                        void this.taskTreePublisher.postDetailedLogToMinebotUi(
                            goal, 'thinking', 'info', 'FunctionCallingAgent', thinkingContent,
                        );
                    }
                }

                // ── ツール呼び出しチェック ──
                const toolCalls = response.tool_calls || [];

                if (toolCalls.length === 0) {
                    consecutiveTextOnly++;

                    // ── 分類駆動の即完了: needsTools=false かつ初回テキスト応答を完了扱いにする ──
                    // 安全条件: (1) ツールが一度も使われていない (2) 初回イテレーション (3) 応答が十分な長さ
                    // ツール使用後の即完了は禁止 — LLM が途中で止まるのを防ぐ
                    const textContent = typeof thinkingContent === 'string' ? thinkingContent.trim() : '';
                    const MIN_SUBSTANTIVE_LENGTH = 30;
                    if (state.needsTools === false && stepCounter === 0 && iteration === 0 && textContent.length >= MIN_SUBSTANTIVE_LENGTH) {
                        const cleanContent = stripAssistantContentPrefix(textContent);
                        if (cleanContent.length > 0) {
                            logger.info(`⚡ 分類駆動即完了: needsTools=false → テキスト応答で完了 (${iteration + 1}イテレーション, ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

                            this.taskTreePublisher.publishTaskTree({
                                status: 'completed',
                                goal,
                                strategy: cleanContent,
                                hierarchicalSubTasks: steps,
                                currentSubTaskId: null,
                            }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

                            this.thinkingManager.resetThinkingState();

                            return {
                                taskTree: {
                                    status: 'completed' as const,
                                    goal,
                                    strategy: cleanContent,
                                    recoveryStatus: 'idle' as const,
                                    lastFailureType: null,
                                    recoveryAttempts: 0,
                                    hierarchicalSubTasks: steps,
                                    subTasks: null,
                                } as TaskTreeState,
                                recoveryStatus: 'idle' as const,
                                recoveryAttempts: 0,
                                lastFailureType: undefined,
                                isEmergency: false,
                                messages,
                                forceStop: false,
                                lastAssistantContent: cleanContent,
                            };
                        }
                    }

                    // UI に思考を反映
                    this.taskTreePublisher.publishTaskTree({
                        status: 'in_progress',
                        goal,
                        strategy: `思考中... (${consecutiveTextOnly}/${MAX_CONSECUTIVE_TEXT_ONLY})`,
                        currentThinking: lastThinkingContent,
                        hierarchicalSubTasks: steps,
                        currentSubTaskId: steps[steps.length - 1]?.id ?? null,
                    }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

                    // テキストのみ応答が続きすぎたら強制終了
                    if (consecutiveTextOnly >= MAX_CONSECUTIVE_TEXT_ONLY) {
                        logger.warn(`⚠ テキストのみ応答が${MAX_CONSECUTIVE_TEXT_ONLY}回連続 → ループ終了`);
                        break;
                    }

                    // ツール呼び出しなし → 思考のみ。ループを継続して次のアクションを促す
                    const relevantRecoveryFailure = pendingRecoveryFailure ?? lastRecoverableFailure;
                    const needsMinecraftRecovery = ToolExecutor.requiresMinecraftRecoveryResponse(
                        state.context,
                        relevantRecoveryFailure,
                        thinkingContent,
                    );

                    if (needsMinecraftRecovery && forcedRecoveryAttempts < 2) {
                        forcedRecoveryAttempts++;
                        messages.push(
                            new SystemMessage(
                                `直前のツール失敗は recoverable (${relevantRecoveryFailure?.failureType ?? 'unknown'}) です。` +
                                '失敗報告だけで終了せず、次のいずれかを必ず行ってください: ' +
                                '1. 別手段で再試行する 2. 足りない物や条件を具体的に1つ質問する。',
                            ),
                        );
                        logger.warn(`🔁 Minecraft recovery forced after ${relevantRecoveryFailure?.toolName}`);
                        iteration++;
                        continue;
                    }

                    // 次のアクションを促すプロンプト（エスカレーション付き） → エフェメラルとして次イテレーションで注入
                    this._pendingNudge = consecutiveTextOnly >= 2
                        ? 'これが最後の警告です。次の応答では必ずツールを呼び出すか、task-complete を呼んでください。テキストだけの応答は無効です。'
                        : 'ツール呼び出しがありませんでした。content（テキスト）はユーザーに届きません。' +
                          '回答が準備できているなら task-complete の summary に完全な回答（表・箇条書き等を含む）を書いてください。' +
                          'まだ途中なら次のツールを呼び出してください。';
                    logger.info(`🔄 テキストのみ応答 (${consecutiveTextOnly}/${MAX_CONSECUTIVE_TEXT_ONLY}) → 次のアクションを促して継続`, 'cyan');
                    iteration++;
                    continue;
                }

                // ツール呼び出しがあった → カウンタリセット
                consecutiveTextOnly = 0;

                // ── LoopDetector: ブロック済みツールのフィルタリング ──
                const blockedCalls: Array<{ call: typeof toolCalls[0]; reason: string }> = [];
                const passedToolCalls = toolCalls.filter(tc => {
                    if (tc.name === 'task-complete' || tc.name === 'update-plan') return true;

                    if (this.loopDetector.isCallBlocked(tc.name, tc.args)) {
                        blockedCalls.push({ call: tc, reason: 'LoopDetector によりブロック済み' });
                        return false;
                    }
                    return true;
                });

                if (blockedCalls.length > 0) {
                    for (const { call, reason } of blockedCalls) {
                        logger.info(`[LoopDetector] 🧠 ブロック: ${call.name} — ${reason}`, 'yellow');
                        messages.push(new ToolMessage({
                            content: `結果: 失敗 詳細: ⚠️ ${call.name} の実行がブロックされました。理由: ${reason} 別のアプローチを試してください。 [failure_type=loop_blocked recoverable=true]`,
                            tool_call_id: call.id || `call_${Date.now()}`,
                        }));
                    }

                    if (passedToolCalls.length === 0) {
                        consecutiveBlockedOnly++;
                        if (consecutiveBlockedOnly >= MAX_CONSECUTIVE_BLOCKED_ONLY) {
                            logger.warn(`⚠ ブロックのみ${MAX_CONSECUTIVE_BLOCKED_ONLY}回連続 → イテレーション消費`);
                            iteration++;
                            consecutiveBlockedOnly = 0;
                        }
                        continue;
                    }
                }

                consecutiveBlockedOnly = 0;

                // ── ツール実行 ──
                logger.info(`🔧 ${passedToolCalls.length}個のツールを実行中...`, 'cyan');

                const execResult = await this.toolExecutor.executeToolCalls(
                    passedToolCalls,
                    effectiveToolMap,
                    messages,
                    {
                        goal,
                        platform: state.context?.platform ?? null,
                        channelId: state.channelId,
                        taskId: state.taskId,
                        context: state.context,
                        steps,
                        stepCounter,
                        lastThinkingContent,
                        onToolStarting: state.onToolStarting,
                        onTaskTreeUpdate: state.onTaskTreeUpdate,
                    },
                    signal,
                );
                stepCounter = execResult.stepCounter;
                const iterationResults = execResult.results;

                // ── task-complete 検出 → タスク完了 ──
                const completeCall = toolCalls.find((tc) => tc.name === 'task-complete');
                if (completeCall) {
                    // Guard: needsTools=true なのに task-complete 以外のツールを一度も使わず完了しようとした場合、
                    // 実際の作業をさせるためにリジェクトして継続する（最大1回）
                    const onlyTaskComplete = toolCalls.length === 1 && toolCalls[0].name === 'task-complete';
                    if (state.needsTools !== false && onlyTaskComplete && stepCounter === 0 && iteration < maxIter - 1) {
                        logger.warn('⚠️ task-complete rejected: needsTools=true but no tools used yet. Continuing loop.');
                        messages.push(new ToolMessage({
                            tool_call_id: completeCall.id || 'task-complete',
                            content: 'Rejected: you have not used any tools yet. This task requires tool use (e.g., search, fetch). ' +
                                'Gather the needed information first, then call task-complete with the full answer in summary.',
                        }));
                        iteration++;
                        continue;
                    }

                    const summaryArg = completeCall.args?.summary;
                    const trimmedSummary =
                        typeof summaryArg === 'string' && summaryArg.trim().length > 0
                            ? summaryArg.trim()
                            : '';
                    const summary = trimmedSummary.length > 0 ? trimmedSummary : 'タスク完了';

                    const fromThinking =
                        typeof thinkingContent === 'string' && thinkingContent.trim()
                            ? stripAssistantContentPrefix(thinkingContent)
                            : typeof lastThinkingContent === 'string' && lastThinkingContent.trim()
                                ? stripAssistantContentPrefix(lastThinkingContent)
                                : undefined;

                    // task-complete の summary をユーザー向け最終文の正とする（言語・ドメイン非依存）。
                    // summary が空のときだけ思考本文へフォールバック。
                    const lastAssistantContent =
                        trimmedSummary.length > 0 ? trimmedSummary : fromThinking;

                    logger.success(`✅ FunctionCallingAgent: タスク完了 (${iteration + 1}イテレーション, ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
                    logger.info(`   応答: ${summary.substring(0, 200)}`);

                    const awaitingUser = !!(lastRecoverableFailure && /[?？]/.test(summary));

                    this.taskTreePublisher.publishTaskTree({
                        status: awaitingUser ? 'in_progress' : 'completed',
                        goal,
                        strategy: summary,
                        recoveryStatus: awaitingUser ? 'awaiting_user' : 'idle',
                        lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType ?? null,
                        recoveryAttempts: forcedRecoveryAttempts,
                        hierarchicalSubTasks: steps,
                        currentSubTaskId: null,
                    }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

                    this.thinkingManager.resetThinkingState();

                    return {
                        taskTree: {
                            status: awaitingUser ? 'in_progress' : 'completed',
                            goal,
                            strategy: summary,
                            recoveryStatus: awaitingUser ? 'awaiting_user' : 'idle',
                            lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType ?? null,
                            recoveryAttempts: forcedRecoveryAttempts,
                            hierarchicalSubTasks: steps,
                            subTasks: null,
                        } as TaskTreeState,
                        recoveryStatus: awaitingUser ? 'awaiting_user' : 'idle',
                        recoveryAttempts: forcedRecoveryAttempts,
                        lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType,
                        isEmergency,
                        messages,
                        forceStop: false,
                        lastAssistantContent,
                    };
                }

                // ── LoopDetector: 繰り返し失敗の検出（前帯状皮質） ──
                const loopDetection = this.loopDetector.recordAndCheck(passedToolCalls, iterationResults);

                if (loopDetection.detected) {
                    logger.warn(`[LoopDetector] 🔴 ループ検出: ${loopDetection.summary}`);

                    // ブロック対象ツールを effectiveToolMap から除去
                    if (loopDetection.blockedTools.size > 0) {
                        const availableTools = [...effectiveToolMap.values()].filter(
                            t => !loopDetection.blockedTools.has(t.name),
                        );
                        effectiveModelWithTools = modelSelector.bindTools(availableTools);
                        effectiveToolMap = new Map(availableTools.map(t => [t.name, t]));
                    }

                    // エスカレーション推奨 → モデルを上げる
                    // Minecraft ではツール失敗はゲーム状態起因が多く、モデル能力不足ではない。
                    // エスカレーションすると応答速度が低下するだけなのでスキップ。
                    const isMinecraftPlatform = state.context?.platform === 'minecraft' || state.context?.platform === 'minebot';
                    if (loopDetection.needsEscalation && !isMinecraftPlatform) {
                        if (modelSelector.escalate('LoopDetector: 高失敗率')) {
                            effectiveModelWithTools = modelSelector.bindTools(
                                [...effectiveToolMap.values()],
                            );
                        }
                    }

                    // ループ回避プロンプトを注入
                    if (loopDetection.breakingPrompt) {
                        messages.push(new SystemMessage(loopDetection.breakingPrompt));
                    }
                }

                const newRecoverableFailure = ToolExecutor.pickRecoverableFailure(iterationResults, state.context);
                const madeSuccessfulProgress = iterationResults.some((result) => result.success);
                if (newRecoverableFailure) {
                    pendingRecoveryFailure = newRecoverableFailure;
                    lastRecoverableFailure = newRecoverableFailure;
                } else {
                    pendingRecoveryFailure = null;
                    forcedRecoveryAttempts = 0;
                    if (madeSuccessfulProgress) {
                        lastRecoverableFailure = null;
                    }
                }

                // UI 更新（ツール実行後）
                this.taskTreePublisher.publishTaskTree({
                    status: 'in_progress',
                    goal,
                    strategy: pendingRecoveryFailure
                        ? `${stepCounter}ステップ完了 / recovery ${pendingRecoveryFailure.failureType ?? 'unknown'}`
                        : `${stepCounter}ステップ完了`,
                    currentThinking: lastThinkingContent,
                    recoveryStatus: pendingRecoveryFailure ? 'retrying' : 'idle',
                    lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType ?? null,
                    recoveryAttempts: forcedRecoveryAttempts,
                    hierarchicalSubTasks: steps,
                    currentSubTaskId: null,
                }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

                // ── 非同期感情再評価をトリガー（fire-and-forget） ──
                if (iterationResults.length > 0) {
                    try {
                        state.onToolsExecuted(messages, iterationResults);
                    } catch (e) {
                        // fire-and-forget: エラーは無視
                    }
                }

                iteration++;
            }

            // 最大イテレーション到達
            logger.warn(`⚠ FunctionCallingAgent: 最大イテレーション(${maxIter})に到達`);

            this.taskTreePublisher.publishTaskTree({
                status: 'error',
                goal,
                strategy: '最大イテレーション数に到達',
                currentThinking: lastThinkingContent,
                recoveryStatus: (pendingRecoveryFailure ?? lastRecoverableFailure) ? 'failed_terminal' : 'idle',
                lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType ?? null,
                recoveryAttempts: forcedRecoveryAttempts,
                hierarchicalSubTasks: steps,
                currentSubTaskId: null,
            }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

            return {
                taskTree: {
                    status: 'error',
                    goal,
                    strategy: '最大イテレーション数に到達',
                    recoveryStatus: (pendingRecoveryFailure ?? lastRecoverableFailure) ? 'failed_terminal' : 'idle',
                    lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType ?? null,
                    recoveryAttempts: forcedRecoveryAttempts,
                    hierarchicalSubTasks: steps,
                    subTasks: null,
                } as TaskTreeState,
                recoveryStatus: (pendingRecoveryFailure ?? lastRecoverableFailure) ? 'failed_terminal' : 'idle',
                recoveryAttempts: forcedRecoveryAttempts,
                lastFailureType: (pendingRecoveryFailure ?? lastRecoverableFailure)?.failureType,
                isEmergency,
                messages,
                forceStop: false,
            };
        } catch (error) {
            const errorMsg =
                error instanceof Error ? error.message : 'Unknown error';
            logger.error(`❌ FunctionCallingAgent error: ${errorMsg}`);

            this.taskTreePublisher.publishTaskTree({
                status: 'error',
                goal,
                strategy: `エラー: ${errorMsg}`,
                currentThinking: lastThinkingContent,
                recoveryStatus: 'failed_terminal',
                recoveryAttempts: forcedRecoveryAttempts,
                hierarchicalSubTasks: steps,
                currentSubTaskId: null,
            }, state.context?.platform ?? null, state.channelId, state.taskId, state.onTaskTreeUpdate);

            return {
                taskTree: {
                    status: 'error',
                    goal: `エラー: ${errorMsg}`,
                    strategy: '',
                    recoveryStatus: 'failed_terminal',
                    recoveryAttempts: forcedRecoveryAttempts,
                    subTasks: null,
                } as TaskTreeState,
                recoveryStatus: 'failed_terminal',
                recoveryAttempts: forcedRecoveryAttempts,
                isEmergency,
                messages,
                forceStop: signal?.aborted || false,
            };
        } finally {
            activeCallAbort = null;
            if (signal) {
                signal.removeEventListener('abort', onParentAbort);
            }
        }
    }

    // ── Private helpers ──

    /**
     * ストリーミングモードでLLM応答を取得し、文境界でコールバックを呼ぶ
     */
    private async streamLlmResponse(
        modelWithTools: ReturnType<ChatOpenAI['bindTools']>,
        messages: BaseMessage[],
        signal: AbortSignal,
        onStreamSentence: (sentence: string) => Promise<void>,
    ): Promise<AIMessage> {
        const stream = await modelWithTools.stream(messages, { signal });

        let accumulatedContent = '';
        let sentenceBuffer = '';
        let hasToolCalls = false;
        let accumulatedChunk: AIMessageChunk | null = null;

        const SENTENCE_BOUNDARY = /[。！？!?]/;

        for await (const chunk of stream) {
            if (accumulatedChunk === null) {
                accumulatedChunk = chunk as AIMessageChunk;
            } else {
                accumulatedChunk = accumulatedChunk.concat(chunk as AIMessageChunk);
            }

            if ((chunk as AIMessageChunk).tool_call_chunks?.length) {
                hasToolCalls = true;
            }

            const textPart = typeof chunk.content === 'string' ? chunk.content : '';
            if (textPart && !hasToolCalls) {
                accumulatedContent += textPart;
                sentenceBuffer += textPart;

                let boundaryIdx: number;
                while ((boundaryIdx = sentenceBuffer.search(SENTENCE_BOUNDARY)) !== -1) {
                    const sentence = sentenceBuffer.slice(0, boundaryIdx + 1).trim();
                    sentenceBuffer = sentenceBuffer.slice(boundaryIdx + 1);
                    if (sentence) {
                        try {
                            await onStreamSentence(sentence);
                        } catch (err) {
                            logger.error('onStreamSentence error:', err);
                        }
                    }
                }
            }
        }

        // 残りバッファを emit
        if (!hasToolCalls && sentenceBuffer.trim()) {
            try {
                await onStreamSentence(sentenceBuffer.trim());
            } catch (err) {
                logger.error('onStreamSentence (tail) error:', err);
            }
        }

        // AIMessageChunk -> AIMessage に変換
        if (accumulatedChunk) {
            return new AIMessage({
                content: accumulatedChunk.content,
                tool_calls: accumulatedChunk.tool_calls,
                additional_kwargs: accumulatedChunk.additional_kwargs,
            });
        }
        return new AIMessage({ content: '' });
    }

    /**
     * ゴール文字列からクラフト対象アイテムを推定し、依存チェーンをプロンプト用テキストとして返す。
     * インベントリが渡された場合は突合済みの製作計画を返す。
     */
    private buildCraftDependencyPrompt(
        goal: string,
        inventory: Array<{ name: string; count: number }> | null,
    ): string | null {
        const MC_VERSION = '1.20';
        const resolver = RecipeDependencyResolver.getInstance(MC_VERSION);

        const items = this.extractCraftTargets(goal);
        if (items.length === 0) return null;

        if (inventory && inventory.length > 0) {
            return resolver.buildDependencyPromptWithInventory(items, inventory);
        }
        return resolver.buildDependencyPrompt(items);
    }

    /**
     * テキストからクラフト／精錬対象と思われるアイテム名を抽出する。
     * 英語名 (snake_case) と日本語の「〇〇を作って」パターンの両方をサポート。
     */
    private extractCraftTargets(text: string): string[] {
        const targets: string[] = [];

        const snakeCaseMatches = text.match(/[a-z][a-z0-9_]+(?:_[a-z0-9]+)+/g);
        if (snakeCaseMatches) {
            targets.push(...snakeCaseMatches);
        }

        const JP_ITEM_MAP: Record<string, string> = {
            '鉄インゴット': 'iron_ingot', '金インゴット': 'gold_ingot', '銅インゴット': 'copper_ingot',
            '作業台': 'crafting_table', 'かまど': 'furnace', 'チェスト': 'chest',
            '木のツルハシ': 'wooden_pickaxe', '石のツルハシ': 'stone_pickaxe', '鉄のツルハシ': 'iron_pickaxe',
            'ダイヤのツルハシ': 'diamond_pickaxe', '木の剣': 'wooden_sword', '石の剣': 'stone_sword',
            '鉄の剣': 'iron_sword', 'ダイヤの剣': 'diamond_sword', 'ベッド': 'bed',
            '松明': 'torch', 'たいまつ': 'torch', 'はしご': 'ladder',
            'ドア': 'oak_door', '柵': 'oak_fence', 'バケツ': 'bucket',
            '鉄の防具': 'iron_chestplate', '鉄のヘルメット': 'iron_helmet', '鉄のブーツ': 'iron_boots',
            '鉄のレギンス': 'iron_leggings', '盾': 'shield', '弓': 'bow',
            '矢': 'arrow', '釣り竿': 'fishing_rod', '焼き鳥': 'cooked_chicken',
            '焼き肉': 'cooked_beef', '焼き豚': 'cooked_porkchop',
            'パン': 'bread', 'ケーキ': 'cake',
        };

        for (const [jp, en] of Object.entries(JP_ITEM_MAP)) {
            if (text.includes(jp) && !targets.includes(en)) {
                targets.push(en);
            }
        }

        return targets;
    }

    private relaxAbortSignalListenerLimit(
        signal?: AbortSignal | null,
    ): void {
        if (!signal) return;
        try {
            setMaxListeners(0, signal);
        } catch {
            // Node の実装差異があっても本処理には影響させない
        }
    }
}
