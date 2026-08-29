import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
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
 * Anthropic キーがあっても会話FCAは OpenAI（既定 gpt-4.1-mini）。Minecraft Executor は別。
 */

export interface ModelConfig {
    modelName: string;
    temperature?: number;
    maxTokens?: number;
    isReasoningModel?: boolean;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    verbosity?: 'low' | 'medium' | 'high';
    timeoutMs: number;
    provider: 'anthropic' | 'openai' | 'google';
    streaming?: boolean;
}

interface ModelSlot {
    name: string;
    config: ModelConfig;
}

const ANTHROPIC_CHAIN: ModelSlot[] = [
    {
        name: 'claude-opus-4',
        config: {
            modelName: 'claude-opus-4-6',
            temperature: 1,
            maxTokens: 16384,
            timeoutMs: 120_000,
            provider: 'anthropic',
            streaming: true,
        },
    },
];

const OPENAI_CHAIN: ModelSlot[] = [
    {
        name: 'gpt-4.1-mini',
        config: { modelName: 'gpt-4.1-mini', temperature: 1, maxTokens: 1024, timeoutMs: 15_000, provider: 'openai' },
    },
    {
        name: 'gpt-5-mini-fast',
        config: { modelName: 'gpt-5-mini', temperature: 1, maxTokens: 2048, reasoningEffort: 'low', verbosity: 'low', timeoutMs: 30_000, provider: 'openai' },
    },
    {
        name: 'gpt-5-mini',
        config: { modelName: 'gpt-5-mini', temperature: 1, maxTokens: 2048, reasoningEffort: 'medium', verbosity: 'medium', timeoutMs: 60_000, provider: 'openai' },
    },
    {
        name: 'gpt-5',
        config: { modelName: 'gpt-5', temperature: 1, maxTokens: 4096, reasoningEffort: 'medium', verbosity: 'medium', timeoutMs: 120_000, provider: 'openai' },
    },
];

function getChain(): ModelSlot[] {
    const requested = (process.env.SHANNON_CONVERSATION_MODEL || '').trim();
    if (requested.startsWith('claude-haiku')) {
        return [{
            name: 'claude-haiku-4-5',
            config: {
                modelName: 'claude-haiku-4-5-20251001',
                temperature: 1,
                maxTokens: 2048,
                timeoutMs: 30_000,
                provider: 'anthropic',
                streaming: false,
            },
        }];
    }
    if (requested.startsWith('gemini')) {
        const modelName = requested === 'gemini' ? 'gemini-3.5-flash-lite' : requested;
        return [{
            name: modelName,
            config: {
                modelName,
                temperature: 1,
                maxTokens: 2048,
                timeoutMs: 30_000,
                provider: 'google',
            },
        }];
    }
    return OPENAI_CHAIN;
}

export class ModelSelector {
    private chain: ModelSlot[];
    private currentIndex: number;
    private currentModel: ChatOpenAI | ChatAnthropic;
    private currentModelWithTools: ReturnType<ChatOpenAI['bindTools']> | ReturnType<ChatAnthropic['bindTools']> | null = null;
    private tools: StructuredTool[] = [];
    private escalationCount = 0;
    private deescalationCount = 0;
    private maxEscalationIndex: number;

    constructor(initialModelName?: string) {
        this.chain = getChain();
        this.maxEscalationIndex = this.chain.length - 1;

        const idx = initialModelName
            ? this.chain.findIndex(s => s.name === initialModelName)
            : 0;
        this.currentIndex = idx >= 0 ? idx : 0;
        this.currentModel = this.createModel(this.chain[this.currentIndex].config);

        logger.info(`[ModelSelector] Chain: ${this.chain.map(s => s.name).join(' → ')} (provider: ${this.chain[0].config.provider})`);
    }

    get modelName(): string {
        return this.chain[this.currentIndex].name;
    }

    get apiModelName(): string {
        return this.chain[this.currentIndex].config.modelName;
    }

    get provider(): ModelConfig['provider'] {
        return this.chain[this.currentIndex].config.provider;
    }

    get model(): ChatOpenAI | ChatAnthropic {
        return this.currentModel;
    }

    get modelWithTools(): ReturnType<ChatOpenAI['bindTools']> | ReturnType<ChatAnthropic['bindTools']> {
        if (!this.currentModelWithTools) {
            throw new Error('ModelSelector: bindTools() has not been called yet');
        }
        return this.currentModelWithTools;
    }

    get timeoutMs(): number {
        return this.chain[this.currentIndex].config.timeoutMs;
    }

    get stats(): { escalations: number; deescalations: number; currentModel: string } {
        return {
            escalations: this.escalationCount,
            deescalations: this.deescalationCount,
            currentModel: this.modelName,
        };
    }

    static selectInitialModel(
        _riskLevel: 'low' | 'mid' | 'high' | undefined,
        _needsPlanning: boolean | undefined,
        _mode: string | undefined,
    ): string {
        const chain = getChain();
        return chain[0].name;
    }

    bindTools(tools: StructuredTool[]): ReturnType<ChatOpenAI['bindTools']> | ReturnType<ChatAnthropic['bindTools']> {
        this.tools = tools;
        this.currentModelWithTools = this.currentModel.bindTools(tools);
        return this.currentModelWithTools;
    }

    setMaxEscalationLevel(maxModelName: string): void {
        const idx = this.chain.findIndex(s => s.name === maxModelName);
        if (idx >= 0) {
            this.maxEscalationIndex = idx;
            logger.info(`[ModelSelector] 🔒 エスカレーション上限: ${maxModelName} (index ${idx})`);
        }
    }

    escalate(reason: string): boolean {
        if (this.currentIndex >= this.maxEscalationIndex) {
            logger.warn(`[ModelSelector] ⚠️ エスカレーション上限 (${this.modelName}) — スキップ`);
            return false;
        }

        const prev = this.modelName;
        this.currentIndex++;
        this.currentModel = this.createModel(this.chain[this.currentIndex].config);
        this.escalationCount++;

        if (this.tools.length > 0) {
            this.currentModelWithTools = this.currentModel.bindTools(this.tools);
        }

        logger.warn(`[ModelSelector] 🔺 エスカレーション: ${prev} → ${this.modelName} (理由: ${reason})`);
        return true;
    }

    deescalate(reason: string): boolean {
        if (this.currentIndex <= 0) return false;

        const prev = this.modelName;
        this.currentIndex--;
        this.currentModel = this.createModel(this.chain[this.currentIndex].config);
        this.deescalationCount++;

        if (this.tools.length > 0) {
            this.currentModelWithTools = this.currentModel.bindTools(this.tools);
        }

        logger.info(`[ModelSelector] 🔽 デエスカレーション: ${prev} → ${this.modelName} (理由: ${reason})`);
        return true;
    }

    setModel(modelName: string): boolean {
        const idx = this.chain.findIndex(s => s.name === modelName);
        if (idx < 0) {
            logger.warn(`[ModelSelector] ⚠️ 未知のモデル: ${modelName}`);
            return false;
        }

        const prev = this.modelName;
        this.currentIndex = idx;
        this.currentModel = this.createModel(this.chain[this.currentIndex].config);

        if (this.tools.length > 0) {
            this.currentModelWithTools = this.currentModel.bindTools(this.tools);
        }

        logger.info(`[ModelSelector] 🔄 モデル切り替え: ${prev} → ${this.modelName}`);
        return true;
    }

    private createModel(cfg: ModelConfig): ChatOpenAI | ChatAnthropic {
        if (cfg.provider === 'google') {
            // Conversation FCA uses REST in geminiFcaModel; this placeholder is not invoked.
            return new ChatOpenAI({
                modelName: 'gpt-4.1-mini',
                apiKey: config.openaiApiKey,
                maxRetries: 0,
            });
        }
        if (cfg.provider === 'anthropic') {
            return new ChatAnthropic({
                model: cfg.modelName,
                anthropicApiKey: config.anthropic.apiKey,
                temperature: cfg.temperature,
                maxTokens: cfg.maxTokens,
                streaming: cfg.streaming ?? true,
            });
        }

        // OpenAI
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

    static getChainInfo(): Array<{ name: string; index: number }> {
        return getChain().map((s, i) => ({ name: s.name, index: i }));
    }
}
