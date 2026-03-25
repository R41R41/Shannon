import { ChatOpenAI } from '@langchain/openai';
import { StructuredTool } from '@langchain/core/tools';
import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';
import { createTracedModel } from '../../utils/langfuse.js';

/**
 * Reticular Activating System (RAS) — 覚醒/リソース配分。
 *
 * ClassifyNode の結果に基づいて最適な LLM モデルを選択し、
 * 実行中のエスカレーション/デエスカレーションを制御する。
 *
 * エスカレーションチェーン: gpt-4.1-mini → gpt-5-mini-fast → gpt-5-mini → gpt-5
 */

export interface ModelConfig {
    modelName: string;
    temperature?: number;
    maxTokens?: number;
    /** reasoning model (o-series, gpt-5 等) は max_completion_tokens を使う */
    isReasoningModel?: boolean;
    /** GPT-5 系: minimal | low | medium | high */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    /** GPT-5 系: low | medium | high */
    verbosity?: 'low' | 'medium' | 'high';
    /** 1回の LLM 呼び出しタイムアウト (ms) */
    timeoutMs: number;
}

interface ModelSlot {
    name: string;
    config: ModelConfig;
}

const ESCALATION_CHAIN: ModelSlot[] = [
    {
        name: 'gpt-4.1-mini',
        config: { modelName: 'gpt-4.1-mini', temperature: 1, maxTokens: 1024, timeoutMs: 15_000 },
    },
    {
        name: 'gpt-5-mini-fast',
        config: { modelName: 'gpt-5-mini', temperature: 1, maxTokens: 2048, reasoningEffort: 'low', verbosity: 'low', timeoutMs: 30_000 },
    },
    {
        name: 'gpt-5-mini',
        config: { modelName: 'gpt-5-mini', temperature: 1, maxTokens: 2048, reasoningEffort: 'medium', verbosity: 'medium', timeoutMs: 60_000 },
    },
    {
        name: 'gpt-5',
        config: { modelName: 'gpt-5', temperature: 1, maxTokens: 4096, reasoningEffort: 'medium', verbosity: 'medium', timeoutMs: 120_000 },
    },
];

export class ModelSelector {
    private currentIndex: number;
    private currentModel: ChatOpenAI;
    private currentModelWithTools: ReturnType<ChatOpenAI['bindTools']> | null = null;
    private tools: StructuredTool[] = [];
    private escalationCount = 0;
    private deescalationCount = 0;
    private maxEscalationIndex: number = ESCALATION_CHAIN.length - 1;

    constructor(initialModelName?: string) {
        const idx = initialModelName
            ? ESCALATION_CHAIN.findIndex(s => s.name === initialModelName)
            : 0;
        this.currentIndex = idx >= 0 ? idx : 0;
        this.currentModel = this.createModel(ESCALATION_CHAIN[this.currentIndex].config);
    }

    get modelName(): string {
        return ESCALATION_CHAIN[this.currentIndex].name;
    }

    get model(): ChatOpenAI {
        return this.currentModel;
    }

    get modelWithTools(): ReturnType<ChatOpenAI['bindTools']> {
        if (!this.currentModelWithTools) {
            throw new Error('ModelSelector: bindTools() has not been called yet');
        }
        return this.currentModelWithTools;
    }

    get timeoutMs(): number {
        return ESCALATION_CHAIN[this.currentIndex].config.timeoutMs;
    }

    get stats(): { escalations: number; deescalations: number; currentModel: string } {
        return {
            escalations: this.escalationCount,
            deescalations: this.deescalationCount,
            currentModel: this.modelName,
        };
    }

    /**
     * ClassifyNode の結果に基づいて初期モデルを選択する。
     */
    static selectInitialModel(
        riskLevel: 'low' | 'mid' | 'high' | undefined,
        needsPlanning: boolean | undefined,
        mode: string | undefined,
    ): string {
        if (mode === 'minecraft_emergency' || mode === 'minecraft_action') return 'gpt-4.1-mini';

        if (riskLevel === 'high') return 'gpt-5';
        if (riskLevel === 'mid' && needsPlanning) return 'gpt-5-mini-fast';
        return 'gpt-4.1-mini';
    }

    /**
     * ツールをバインドする。モデル切り替え時にも再バインドされる。
     */
    bindTools(tools: StructuredTool[]): ReturnType<ChatOpenAI['bindTools']> {
        this.tools = tools;
        this.currentModelWithTools = this.currentModel.bindTools(tools);
        return this.currentModelWithTools;
    }

    /**
     * エスカレーション上限を設定する。
     * Minecraft 等レイテンシ重視のプラットフォームでは重いモデルへの昇格を制限する。
     */
    setMaxEscalationLevel(maxModelName: string): void {
        const idx = ESCALATION_CHAIN.findIndex(s => s.name === maxModelName);
        if (idx >= 0) {
            this.maxEscalationIndex = idx;
            logger.info(`[ModelSelector] 🔒 エスカレーション上限: ${maxModelName} (index ${idx})`);
        }
    }

    /**
     * 上位モデルへエスカレーションする。
     * @returns エスカレーションが成功したか（上限/最上位の場合は false）
     */
    escalate(reason: string): boolean {
        if (this.currentIndex >= this.maxEscalationIndex) {
            logger.warn(`[ModelSelector] ⚠️ エスカレーション上限 (${this.modelName}, max=${ESCALATION_CHAIN[this.maxEscalationIndex]?.name}) — スキップ`);
            return false;
        }

        const prev = this.modelName;
        this.currentIndex++;
        this.currentModel = this.createModel(ESCALATION_CHAIN[this.currentIndex].config);
        this.escalationCount++;

        if (this.tools.length > 0) {
            this.currentModelWithTools = this.currentModel.bindTools(this.tools);
        }

        logger.warn(`[ModelSelector] 🔺 エスカレーション: ${prev} → ${this.modelName} (理由: ${reason})`);
        return true;
    }

    /**
     * 下位モデルへデエスカレーションする。
     * @returns デエスカレーションが成功したか（最下位の場合は false）
     */
    deescalate(reason: string): boolean {
        if (this.currentIndex <= 0) {
            return false;
        }

        const prev = this.modelName;
        this.currentIndex--;
        this.currentModel = this.createModel(ESCALATION_CHAIN[this.currentIndex].config);
        this.deescalationCount++;

        if (this.tools.length > 0) {
            this.currentModelWithTools = this.currentModel.bindTools(this.tools);
        }

        logger.info(`[ModelSelector] 🔽 デエスカレーション: ${prev} → ${this.modelName} (理由: ${reason})`);
        return true;
    }

    /**
     * 特定のモデルに直接切り替える。
     */
    setModel(modelName: string): boolean {
        const idx = ESCALATION_CHAIN.findIndex(s => s.name === modelName);
        if (idx < 0) {
            logger.warn(`[ModelSelector] ⚠️ 未知のモデル: ${modelName}`);
            return false;
        }

        const prev = this.modelName;
        this.currentIndex = idx;
        this.currentModel = this.createModel(ESCALATION_CHAIN[this.currentIndex].config);

        if (this.tools.length > 0) {
            this.currentModelWithTools = this.currentModel.bindTools(this.tools);
        }

        logger.info(`[ModelSelector] 🔄 モデル切り替え: ${prev} → ${this.modelName}`);
        return true;
    }

    private createModel(cfg: ModelConfig): ChatOpenAI {
        const params: Record<string, unknown> = {
            modelName: cfg.modelName,
            apiKey: config.openaiApiKey,
        };

        if (cfg.temperature !== undefined) params.temperature = cfg.temperature;

        const isGpt5 = cfg.modelName.startsWith('gpt-5');
        const useCompletionTokens = cfg.isReasoningModel
            || cfg.modelName.startsWith('o')
            || isGpt5;

        const kwargs: Record<string, unknown> = {};

        if (useCompletionTokens) {
            params.maxTokens = undefined;
            if (cfg.maxTokens) kwargs.max_completion_tokens = cfg.maxTokens;
        } else {
            if (cfg.maxTokens) params.maxTokens = cfg.maxTokens;
        }

        if (isGpt5) {
            if (cfg.reasoningEffort) kwargs.reasoning_effort = cfg.reasoningEffort;
            if (cfg.verbosity) kwargs.verbosity = cfg.verbosity;
        }

        if (Object.keys(kwargs).length > 0) {
            params.modelKwargs = kwargs;
        }

        return createTracedModel(params as Parameters<typeof createTracedModel>[0]);
    }

    /**
     * エスカレーションチェーンの情報を返す（ログ/デバッグ用）
     */
    static getChainInfo(): Array<{ name: string; index: number }> {
        return ESCALATION_CHAIN.map((s, i) => ({ name: s.name, index: i }));
    }
}
