import {
    HumanMessage,
    SystemMessage,
} from '@langchain/core/messages';
import { config } from '../../../../../config/env.js';
import { logger } from '../../../../../utils/logger.js';
import { createTracedModel } from '../../../utils/langfuse.js';

/**
 * 思考過程（thinking trace）の蓄積・要約・コンテキスト構築を担当
 */
export class ThinkingManager {
    private thinkingTrace: string[] = [];
    private thinkingSummary: string = '';

    static readonly THINKING_RAW_KEEP = 6;
    static readonly THINKING_SUMMARIZE_THRESHOLD = 2000;

    /**
     * 思考状態をリセット
     */
    resetThinkingState(): void {
        this.thinkingTrace = [];
        this.thinkingSummary = '';
    }

    /**
     * 思考を追加
     */
    addThought(content: string): void {
        this.thinkingTrace.push(content);
    }

    /**
     * 一時的な思考コンテキストをLLMメッセージ用に構築
     * @returns null の場合はコンテキストなし
     */
    buildThinkingContext(): string | null {
        const parts: string[] = [];
        if (this.thinkingSummary) {
            parts.push(`【これまでの経緯】\n${this.thinkingSummary}`);
        }
        const recentThoughts = this.thinkingTrace.slice(-ThinkingManager.THINKING_RAW_KEEP);
        if (recentThoughts.length > 0) {
            const formatted = recentThoughts
                .map((t, i) => `- [思考${this.thinkingTrace.length - recentThoughts.length + i + 1}] ${t.substring(0, 120)}`)
                .join('\n');
            parts.push(`【直近の思考】\n${formatted}`);
        }
        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    /**
     * 思考が長くなりすぎたら要約する
     */
    async maybeSummarizeThinking(modelName: string): Promise<void> {
        const totalChars = this.thinkingTrace.reduce((sum, t) => sum + t.length, 0);
        if (totalChars < ThinkingManager.THINKING_SUMMARIZE_THRESHOLD) return;
        if (this.thinkingTrace.length <= ThinkingManager.THINKING_RAW_KEEP) return;

        const toSummarize = this.thinkingTrace.slice(0, -ThinkingManager.THINKING_RAW_KEEP);
        const existingSummary = this.thinkingSummary ? `既存の要約: ${this.thinkingSummary}\n\n` : '';
        const rawThoughts = toSummarize.map((t, i) => `${i + 1}. ${t}`).join('\n');

        try {
            const summaryModel = createTracedModel({
                modelName,
                apiKey: config.openaiApiKey,
                temperature: 0,
                maxTokens: 300,
            });
            const result = await summaryModel.invoke([
                new SystemMessage(
                    '以下の思考過程を3-5文で簡潔に要約してください。' +
                    '何を達成し、何が未完了で、現在どの段階にいるかを含めてください。',
                ),
                new HumanMessage(`${existingSummary}新しい思考:\n${rawThoughts}`),
            ]);
            const summary = typeof result.content === 'string' ? result.content : '';
            if (summary) {
                this.thinkingSummary = summary;
                this.thinkingTrace = this.thinkingTrace.slice(-ThinkingManager.THINKING_RAW_KEEP);
                logger.debug(`📝 思考要約を更新: ${summary.substring(0, 100)}`);
            }
        } catch (e) {
            logger.warn(`思考要約生成失敗: ${e instanceof Error ? e.message : 'unknown'}`);
        }
    }

    /**
     * 思考トレースが存在するか
     */
    hasThoughts(): boolean {
        return this.thinkingSummary !== '' || this.thinkingTrace.length > 0;
    }
}
