import { bindRequestMemory, snapshotMemoryEnvelope } from '../../../memory/requestMemory.js';
import { bindRequestDiscordConversation } from '../../../common/discordConversationPort.js';
import { bindRequestWebConversation } from '../../../common/webConversationPort.js';
import { selectToolsForChannel } from '../../../../modules/access/toolCatalog.js';
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
import { HierarchicalSubTask, TaskContext, TaskTreeState } from '@shannon/common';
import { setMaxListeners } from 'node:events';
import { config } from '../../../../config/env.js';
import { modelManager } from '../../../../config/modelManager.js';
import { logger } from '../../../../utils/logger.js';
import { RecipeDependencyResolver } from '../../../minebot/knowledge/RecipeDependencyResolver.js';
import UpdatePlanTool from '../../tools/utility/updatePlan.js';
import { trimContext } from '../../utils/contextManager.js';
import { createTracedModel } from '../../utils/langfuse.js';
import { tokenTracker } from '../../utils/tokenTracker.js';
import { ExecutionResult } from '../types.js';
import { PromptBuilder } from './prompt/PromptBuilder.js';
import { TaskTreePublisher } from './execution/TaskTreePublisher.js';
import { ThinkingManager } from './execution/ThinkingManager.js';
import { ToolExecutor } from './execution/ToolExecutor.js';
import { LoopDetector } from './execution/LoopDetector.js';
import { ModelSelector } from '../cognitive/ModelSelector.js';
import { fcaHistoryToLangChain } from '../../../fca/openAiFcaModel.js';
import { createGeminiFcaModel } from '../../../fca/geminiFcaModel.js';
import { conversationLoadPrompt, catalogLinesForPrompt, RequestToolsTool, REQUEST_TOOLS_NAME, runConversationFca } from './conversationKernel.js';
import type { FcaModel } from '../../../../modules/fca/index.js';
import type { FunctionCallingAgentState, FlatFcaStateInput } from './fcaState.js';
import { normalizeFcaState } from './fcaState.js';

function stripAssistantContentPrefix(t: string): string {
    return t.replace(/^content:\s*/i, '').trim();
}

/**
 * Function Calling Agent (Discord/WebUI版)
 *
 * minebot版をベースに、Discord/WebUI用に適応。
 * OpenAI の function calling (tool_use) を使い、LLM が直接ツールを呼び出す。
 *
 * 特徴:
 * - ツール定義は API の `tools` パラメータで渡す（プロンプトに埋め込まない）
 * - update-plan ツールでLLMが自発的に計画を立てる + 自動ステップ記録
 * - WebNotificationHub 経由でUI通知
 *
 * フロー:
 * 1. システムプロンプト（コンテキスト + ルール）+ ユーザーメッセージを構築
 * 2. LLM に tools を bind して呼び出し
 * 3. tool_calls があれば実行し、ToolMessage で結果を返す
 * 4. tool_calls がなければタスク完了
 * 5. 2-4 を繰り返す
 */
export class FunctionCallingSession {
    private phase: "created" | "running" | "closed" = "created";
    private model: ChatOpenAI;
    private modelWithTools: ReturnType<ChatOpenAI['bindTools']>;
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
        this.tools = [...tools];
        this.toolMap = new Map(tools.map((t) => [t.name, t]));

        // update-plan ツールを探す
        const planTool = tools.find((t) => t.name === 'update-plan');
        if (planTool && planTool instanceof UpdatePlanTool) {
            this.updatePlanTool = planTool;
        }

        // 会話は OpenAI。Anthropic キーがあっても Opus にはしない。
        this.model = createTracedModel({
            modelName: FunctionCallingSession.MODEL_NAME,
            apiKey: config.openaiApiKey,
            temperature: 1,
            maxTokens: 2048,
        });
        logger.info(`🤖 FCA: Using OpenAI ${FunctionCallingSession.MODEL_NAME}`, 'cyan');

        // ツールをモデルに bind
        this.modelWithTools = this.model.bindTools(this.tools);

        // Sub-components
        this.promptBuilder = new PromptBuilder();
        this.taskTreePublisher = new TaskTreePublisher();
        this.thinkingManager = new ThinkingManager();
        this.toolExecutor = new ToolExecutor(this.taskTreePublisher);
        this.loopDetector = new LoopDetector();

        logger.info(`🤖 FunctionCallingAgent(Web/Discord): model=${FunctionCallingSession.MODEL_NAME}, tools=${tools.length}`, 'cyan');
    }

    /**
     * Session-local live effects for ephemeral prompt injection. Not a shared blackboard.
     */
    public setBlackboardAccessor(fn: (() => { freeSlots?: number | null; activeEffects?: Array<{ name: string; amplifier: number }> }) | null): void {
        if (this.phase === "closed" && fn !== null) return;
        this.blackboardAccessor = fn;
    }

    /** 登録済みツール一覧を返す */
    getTools(): StructuredTool[] {
        return [...this.tools];
    }

    // ─── メッセージ互換性 ───

    /**
     * Anthropic / Gemini は system を先頭以外に置けない。
     * 2つ目以降の SystemMessage は先頭の system に結合する。
     */
    private sanitizeMessagesForProvider(messages: BaseMessage[]): BaseMessage[] {
        const extras: string[] = [];
        const out: BaseMessage[] = [];
        let firstSystem: BaseMessage | undefined;
        for (const msg of messages) {
            if (msg._getType() === 'system') {
                const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                if (!firstSystem) {
                    firstSystem = msg;
                    out.push(msg);
                } else if (text.trim()) {
                    extras.push(text);
                }
            } else {
                out.push(msg);
            }
        }
        if (firstSystem && extras.length > 0) {
            const idx = out.indexOf(firstSystem);
            const base = typeof firstSystem.content === 'string' ? firstSystem.content : '';
            out[idx] = new SystemMessage(`${base}\n\n${extras.join('\n\n')}`);
        }
        return out;
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
        if (this.phase === "closed") return;
        this._pendingPlanUpdate = planSummary;
    }

    /**
     * ユーザーフィードバックを追加（実行中に呼ばれる）。
     * 重複排除: 既にキューにある内容と類似していれば最新のもので上書きする。
     */
    public addFeedback(feedback: string): void {
        if (this.phase === "closed") return;
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
    async run(state: FunctionCallingAgentState | FlatFcaStateInput, signal?: AbortSignal) {
        if (this.phase !== "created") throw new Error('FCA sessions are single-use');
        this.phase = "running";
        try {
            signal?.throwIfAborted();
            return await this.execute(normalizeFcaState(state), signal);
        } finally {
            this.phase = "closed";
            this.pendingFeedback.length = 0;
            this._pendingPlanUpdate = null;
            this._pendingNudge = null;
            this.setBlackboardAccessor(null);
            this.thinkingManager.resetThinkingState();
            this.loopDetector.reset();
        }
    }

    private async execute(
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
        const composition = {
            ...state.composition,
            requestEnvelope: state.composition.requestEnvelope
                ? snapshotMemoryEnvelope(state.composition.requestEnvelope)
                : undefined,
        };
        const channelAdapter = state.channel;
        state = { ...state, composition };
        bindRequestMemory(this.tools, composition.requestEnvelope);
        bindRequestDiscordConversation(this.tools, composition.requestEnvelope, signal);
        bindRequestWebConversation(this.tools, composition.requestEnvelope, signal);
        const goal = state.userMessage || 'Unknown task';
        const isEmergency = state.isEmergency || false;
        let activeCallAbort: AbortController | null = null;
        const onParentAbort = () => activeCallAbort?.abort();
        this.relaxAbortSignalListenerLimit(signal);

        this.thinkingManager.resetThinkingState();
        this.loopDetector.reset();

        // 動的モデル選択 (RAS / ModelSelector)
        const modelSelector = new ModelSelector(composition.selectedModel || FunctionCallingSession.MODEL_NAME);
        const channel = composition.requestEnvelope?.channel ?? composition.context?.platform ?? null;
        const platform = composition.context?.platform ?? null;
        if (platform === 'minecraft' || platform === 'minebot') {
            modelSelector.setMaxEscalationLevel('gpt-5-mini-fast');
        } else {
            modelSelector.setMaxEscalationLevel(modelSelector.modelName);
        }
        logger.info(`🤖 FunctionCallingAgent: タスク実行開始 "${goal}"${isEmergency ? ' [緊急]' : ''} (model=${modelSelector.modelName})`, 'cyan');

        let effectiveTools = selectToolsForChannel(channel ?? undefined, this.tools, composition.allowedTools, composition.requestEnvelope);
        let effectiveToolMap = new Map(effectiveTools.map(t => [t.name, t]));
        if (effectiveTools.length !== this.tools.length) {
            logger.info(`🔒 tools for ${channel ?? 'unknown'}: ${effectiveTools.length}/${this.tools.length}`, 'cyan');
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

        const channelOutputTools = this.promptBuilder.getDisabledOutputTools(composition.context);
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
            this.updatePlanTool.setContext(composition.channelId, state.taskId, composition.context?.platform ?? null);
        }

        const deferToolLoad = platform !== 'minecraft' && platform !== 'minebot';
        const promptClassifyMode = deferToolLoad && composition.classifyMode === 'planning'
            ? 'task_execution'
            : composition.classifyMode;

        // メッセージ構築
        let systemPrompt = this.promptBuilder.buildSystemPrompt(
            composition.context,
            composition.environmentState,
            composition.memoryPrompt,
            composition.relationshipPrompt,
            composition.selfModelPrompt,
            composition.strategyPrompt,
            composition.internalStatePrompt,
            composition.worldModelPrompt,
            promptClassifyMode,
            composition.needsTools,
        );

        if (deferToolLoad) {
            if (!effectiveTools.some(tool => tool.name === REQUEST_TOOLS_NAME)) {
                effectiveTools = [new RequestToolsTool(), ...effectiveTools];
                effectiveToolMap = new Map(effectiveTools.map(t => [t.name, t]));
            }
            systemPrompt += conversationLoadPrompt(catalogLinesForPrompt(effectiveTools));
        }

        if (composition.episodePrompt) {
            systemPrompt += `\n\n${composition.episodePrompt}`;
        }
        if (composition.worldKnowledgePrompt) {
            systemPrompt += `\n\n${composition.worldKnowledgePrompt}`;
        }

        if (platform === 'minecraft' || platform === 'minebot') {
            try {
                const mcMeta = composition.context?.metadata?.minecraft as Record<string, unknown> | undefined;
                const liveInventory = channelAdapter.getLiveInventory?.();
                const inventory = liveInventory?.length
                    ? liveInventory.map(item => ({ name: item.name, count: item.count }))
                    : Array.isArray(mcMeta?.inventory)
                        ? (mcMeta!.inventory as Array<{ name: string; count: number }>)
                        : null;
                const depPrompt = this.buildCraftDependencyPrompt(goal, inventory);
                if (depPrompt) {
                    systemPrompt += depPrompt;
                }
            } catch { }
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
        signal?.throwIfAborted();
        this.taskTreePublisher.publishTaskTree({
            status: 'in_progress',
            goal,
            strategy: 'Function Calling Agent で実行中',
            hierarchicalSubTasks: [],
            currentSubTaskId: null,
        }, {
            platform: composition.context?.platform ?? null,
            channelId: composition.channelId,
            taskId: state.taskId,
            envelope: composition.requestEnvelope,
            signal,
            onTaskTreeUpdate: channelAdapter.onTaskTreeUpdate,
        });

        signal?.throwIfAborted();
        signal?.addEventListener('abort', onParentAbort, { once: true });
        try {
            const maxIter = state.maxIterations
                ?? (isEmergency ? FunctionCallingSession.MAX_ITERATIONS_EMERGENCY : FunctionCallingSession.MAX_ITERATIONS);
            const geminiAdapter = modelSelector.provider === 'google'
                ? createGeminiFcaModel({
                    apiKey: config.google.geminiApiKey,
                    model: modelSelector.apiModelName,
                    maxTokens: 2048,
                    temperature: 1,
                    timeoutMs: modelSelector.timeoutMs,
                })
                : null;
            const kernelModel: FcaModel = {
                next: async (request, child) => {
                    child.throwIfAborted();
                    const callAbort = new AbortController();
                    const callTimeout = setTimeout(() => callAbort.abort(), modelSelector.timeoutMs);
                    const onChildAbort = () => callAbort.abort();
                    if ('addEventListener' in child) {
                        (child as AbortSignal).addEventListener('abort', onChildAbort, { once: true });
                    }
                    activeCallAbort = callAbort;
                    this.relaxAbortSignalListenerLimit(callAbort.signal);
                    try {
                        if (geminiAdapter) {
                            const result = await geminiAdapter.next(request, callAbort.signal);
                            child.throwIfAborted();
                            if (result.content) this.thinkingManager.addThought(result.content);
                            return result;
                        }
                        const names = new Set(request.tools.map(tool => tool.name));
                        const boundTools = effectiveTools.filter(tool => names.has(tool.name));
                        const bound = modelSelector.bindTools(boundTools);
                        const lc = this.sanitizeMessagesForProvider(fcaHistoryToLangChain(request.system, request.messages));
                        const response = channelAdapter.onStreamSentence
                            ? await this.streamLlmResponse(bound as any, lc, callAbort.signal, channelAdapter.onStreamSentence)
                            : await (bound as any).invoke(lc, { signal: callAbort.signal }) as AIMessage;
                        child.throwIfAborted();
                        const usage = (response as AIMessage & { usage_metadata?: { input_tokens?: number; output_tokens?: number } })?.usage_metadata;
                        if (usage) {
                            tokenTracker.record(modelSelector.modelName || 'unknown', 'FunctionCallingAgent',
                                usage.input_tokens || 0, usage.output_tokens || 0).catch(() => { });
                        }
                        const content = typeof response.content === 'string' ? response.content : '';
                        if (content) this.thinkingManager.addThought(content);
                        const toolCalls = (response.tool_calls ?? []).map((call: { id?: string; name: string; args?: unknown }) => ({
                            id: call.id ?? '', name: call.name, arguments: call.args,
                        }));
                        return { content, toolCalls };
                    } finally {
                        clearTimeout(callTimeout);
                        activeCallAbort = null;
                        if ('removeEventListener' in child) {
                            (child as AbortSignal).removeEventListener('abort', onChildAbort);
                        }
                    }
                },
            };
            const kernelResult = await runConversationFca({
                system: systemPrompt, goal, tools: effectiveTools, model: kernelModel,
                signal: signal ?? new AbortController().signal,
                maxTurns: maxIter, maxElapsedMs: FunctionCallingSession.MAX_TOTAL_TIME_MS,
                needsTools: deferToolLoad ? false : composition.needsTools,
                deferToolLoad,
                onToolStarting: channelAdapter.onToolStarting,
                filterCalls: (calls) => calls.filter(call => {
                    if (call.name === 'task-complete' || call.name === 'update-plan') return true;
                    const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
                        ? call.arguments as Record<string, unknown> : {};
                    return !this.loopDetector.isCallBlocked(call.name, args);
                }),
                onTools: (results) => {
                    try { channelAdapter.onToolsExecuted?.(messages, results); } catch { /* fire-and-forget */ }
                    this.loopDetector.recordAndCheck(results.map(result => ({ name: result.toolName, args: result.args })), results);
                },
                ephemeral: async (turn) => {
                    const extra: { role: 'system' | 'user'; content: string }[] = [];
                    if (turn === 1 && channelAdapter.getInitialMemory) {
                        const initial = await channelAdapter.getInitialMemory();
                        if (initial) extra.push({ role: 'system', content: `【初期記憶コンテキスト】\n${initial}` });
                    }
                    if (this.pendingFeedback.length) {
                        extra.push({ role: 'user', content: `ユーザーからのフィードバック: ${this.pendingFeedback[this.pendingFeedback.length - 1]}` });
                        this.pendingFeedback.length = 0;
                    }
                    if (this._pendingNudge) { extra.push({ role: 'system', content: this._pendingNudge }); this._pendingNudge = null; }
                    if (this._pendingPlanUpdate) {
                        extra.push({ role: 'system', content: `【プラン更新】\n${this._pendingPlanUpdate}` });
                        this._pendingPlanUpdate = null;
                    }
                    const inventoryDiff = channelAdapter.getInventoryDiff?.();
                    if (inventoryDiff) extra.push({ role: 'system', content: inventoryDiff });
                    try {
                      const effects = channelAdapter.getActiveEffects?.() ?? this.blackboardAccessor()?.activeEffects;
                      if (effects?.length) extra.push({ role: 'system', content: `⚠️ 【アクティブ状態効果】${effects.map(e => `${e.name}(Lv${e.amplifier + 1})`).join(', ')}` });
                    } catch { /* optional */ }
                    try {
                      const thinking = this.thinkingManager.buildThinkingContext();
                      if (thinking) extra.push({ role: 'system', content: thinking });
                    } catch { /* optional */ }
                    return extra;
                },
            });
            const summaryValue = kernelResult.value && typeof kernelResult.value === 'object'
                && typeof (kernelResult.value as { summary?: unknown }).summary === 'string'
                ? (kernelResult.value as { summary: string }).summary.trim() : '';
            const summary = summaryValue || kernelResult.content.trim();
            this.thinkingManager.resetThinkingState();
            const complete = kernelResult.stop === 'terminal' || kernelResult.stop === 'complete';
            logger.info(complete
                ? `✅ FunctionCallingAgent: タスク完了 (${kernelResult.turns}イテレーション)`
                : `⚠ FunctionCallingAgent: 停止 ${kernelResult.stop} (${maxIter})`);
            this.taskTreePublisher.publishTaskTree({
                status: complete ? 'completed' : 'error',
                goal, strategy: complete ? (summary || goal) : '最大イテレーション数に到達',
                hierarchicalSubTasks: steps, currentSubTaskId: null,
            }, {
                platform: composition.context?.platform ?? null,
                channelId: composition.channelId,
                taskId: state.taskId,
                envelope: composition.requestEnvelope,
                signal,
                onTaskTreeUpdate: channelAdapter.onTaskTreeUpdate,
            });
            return {
                taskTree: {
                    status: complete ? 'completed' : 'error',
                    goal, strategy: complete ? (summary || goal) : '最大イテレーション数に到達',
                    recoveryStatus: 'idle' as const, lastFailureType: null, recoveryAttempts: 0,
                    hierarchicalSubTasks: steps, subTasks: null,
                } as TaskTreeState,
                recoveryStatus: 'idle' as const, recoveryAttempts: 0, isEmergency,
                messages: fcaHistoryToLangChain(systemPrompt, kernelResult.messages),
                forceStop: false, lastAssistantContent: summary || undefined,
            };
        } catch (error) {
            signal?.throwIfAborted();
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
            }, {
                platform: composition.context?.platform ?? null,
                channelId: composition.channelId,
                taskId: state.taskId,
                envelope: composition.requestEnvelope,
                signal,
                onTaskTreeUpdate: channelAdapter.onTaskTreeUpdate,
            });

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
            signal.throwIfAborted();
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
                        signal.throwIfAborted();
                        try {
                            await onStreamSentence(sentence);
                        } catch (err) {
                            signal.throwIfAborted();
                            logger.error('onStreamSentence error:', err);
                        }
                    }
                }
            }
        }

        // 残りバッファを emit
        signal.throwIfAborted();
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
