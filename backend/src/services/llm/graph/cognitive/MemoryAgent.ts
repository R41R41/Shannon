import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';
import { createRequestMemory } from '../../../memory/requestMemory.js';
import { createRequestPersonMemory } from '../../../memory/requestPersonMemory.js';
import { formatPersonStatements, type PersonMemoryPort } from '../../../../modules/memory/personMemory.js';
import type { MemoryPort, MemorySaveResult } from '../../../../modules/memory/index.js';
import { createTracedModel } from '../../utils/langfuse.js';
import { CognitiveBlackboard } from './CognitiveBlackboard.js';
import type { RequestEnvelope } from '@shannon/common';

/**
 * MemoryAgent — 海馬 (Hippocampus) に相当する記憶プロセス。
 *
 * CognitiveBlackboard の4番目の並列プロセスとして動作し、
 * 記憶の **取得・保存・圧縮** を能動的に行う。
 *
 * - 取得 (on-demand): TaskFCA / plan-craft からの同期クエリに応答
 * - 保存 (event-driven): 10iter 毎にツール結果を分析、覚えるべき情報を保存
 * - 圧縮 (periodic): タスク完了時に古い記憶を整理
 */

/** 保存判断のインターバル (TaskFCA のイテレーション数) */
const SAVE_CHECK_INTERVAL_ITERATIONS = 10;

const SAVE_JUDGE_SYSTEM_PROMPT = `あなたはAIエージェントの記憶管理アシスタントです。
以下のツール実行結果の中から、長期的に覚えておくべき情報を判断してください。

覚えるべき対象:
- チェスト/かまどの中身（座標紐付き）
- 新しい場所の発見（鉱脈、村、建造物）
- 有用なアイテムの入手・消費で重要なもの
- 失敗から学んだ教訓
- ユーザーの発言で重要なもの

覚えない対象:
- ルーティンの成功（move-to 成功、採掘成功など）
- 一時的な状態（現在位置、現在のHP など）
- 既に保存済みの情報

保存すべき情報がある場合、以下の JSON 配列で返してください:
[{"content": "保存内容", "tags": ["tag1", "tag2"], "importance": 1-10}]

保存すべき情報がない場合は空配列 [] を返してください。`;

const QUERY_SYSTEM_PROMPT = `あなたはAIエージェントの記憶検索アシスタントです。
以下の記憶データベースの検索結果から、質問に関連する情報を整理して簡潔に答えてください。
記憶にない情報は「記憶にありません」と正直に答えてください。`;

export interface QueryContext {
    platform?: string;
    position?: { x: number; y: number; z: number };
    userId?: string;
    tags?: string[];
}

export class MemoryAgent {
    private blackboard: CognitiveBlackboard;
    private envelope: RequestEnvelope;
    private memory: MemoryPort;
    private personMemory: PersonMemoryPort;
    private model: ChatOpenAI;
    private stopped = false;
    private lastCheckedIteration = 0;

    constructor(blackboard: CognitiveBlackboard, envelope: RequestEnvelope) {
        this.blackboard = blackboard;
        this.envelope = envelope;
        this.memory = createRequestMemory(envelope);
        this.personMemory = createRequestPersonMemory(envelope);
        this.model = createTracedModel({
            modelName: 'gpt-4.1-mini',
            apiKey: config.openaiApiKey,
        });
    }

    // ── A. 初期記憶取得 (recall ノード代替) ──

    /**
     * execute 開始直後に非同期で呼ばれる。
     * 人物情報 + 関連記憶を取得し、初期コンテキストとして返す。
     */
    async initialize(goal: string): Promise<string> {
        try {
            const parts: string[] = [];

            // Only source-attributed statements in this author's current audience. Legacy histories stay quarantined.
            // 目標に関連する記憶を検索
            const [experiences, knowledge, personStatements] = await Promise.all([
                this.memory.search('experience', goal, 3).catch(() => []),
                this.memory.search('knowledge', goal, 3).catch(() => []),
                this.personMemory.recall(3).catch(() => []),
            ]);
            const personPrompt = formatPersonStatements(personStatements);
            if (personPrompt) parts.push(personPrompt);

            if (experiences.length > 0) {
                parts.push('【関連する体験】\n' + experiences.map(e => `- ${e.content}`).join('\n'));
            }
            if (knowledge.length > 0) {
                parts.push('【関連する知識】\n' + knowledge.map(k => `- ${k.content}`).join('\n'));
            }

            const result = parts.join('\n\n');
            if (result) {
                this.blackboard.setInitialMemoryContext(result);
            }
            return result;
        } catch (error) {
            logger.error('[MemoryAgent] initialize error:', error);
            return '';
        }
    }

    // ── B. クエリ応答 (on-demand) ──

    /**
     * recall-memory ツールから同期的に呼ばれる。
     * DB 検索 + LLM で整理して回答を返す。
     */
    async query(question: string, context?: QueryContext): Promise<string> {
        try {
            // DB 検索
            const [experiences, knowledge, personStatements] = await Promise.all([
                this.memory.search('experience', question, 5).catch(() => []),
                this.memory.search('knowledge', question, 5).catch(() => []),
                this.personMemory.recall(5).catch(() => []),
            ]);

            const allResults = [
                ...experiences.map(e => `[体験] ${e.content}`),
                ...knowledge.map(k => `[知識] ${k.content}`),
                ...(personStatements.length ? [formatPersonStatements(personStatements)] : []),
            ];

            if (allResults.length === 0) {
                return 'その件について記憶にありません。';
            }

            // LLM で整理して回答
            const response = await this.model.invoke([
                new SystemMessage(QUERY_SYSTEM_PROMPT),
                new HumanMessage(
                    `質問: ${question}\n\n記憶データ:\n${allResults.join('\n')}`,
                ),
            ]);

            return typeof response.content === 'string'
                ? response.content
                : 'その件について記憶にありません。';
        } catch (error) {
            logger.error('[MemoryAgent] query error:', error);
            return '記憶の検索中にエラーが発生しました。';
        }
    }

    // ── C. 強制保存 (save-memory ツール経由) ──

    async save(content: string, importance?: number): Promise<MemorySaveResult> {
        try {
            return await this.memory.save({
                content,
                category: 'knowledge',
                importance: importance ?? 5,
                tags: this.buildTags(content),
            });
        } catch (error) {
            logger.error('[MemoryAgent] save error:', error);
            return { saved: false, message: '記憶の保存に失敗しました。' };
        }
    }

    // ── D. 並列プロセスとして動作 ──

    async run(signal: AbortSignal): Promise<void> {
        this.stopped = false;

        const onTaskUpdated = () => {
            const iteration = this.blackboard.taskState.iteration;
            if (iteration - this.lastCheckedIteration >= SAVE_CHECK_INTERVAL_ITERATIONS) {
                void this.checkAndSave();
            }
        };
        const onCompleted = () => {
            this.stopped = true;
            void this.onTaskComplete();
        };
        const onAbort = () => { this.stopped = true; };

        this.blackboard.on('task:updated', onTaskUpdated);
        this.blackboard.on('completed', onCompleted);
        signal.addEventListener('abort', onAbort, { once: true });

        // 完了まで待機
        await new Promise<void>(resolve => {
            if (this.stopped) return resolve();
            this.blackboard.once('completed', resolve);
        });

        this.blackboard.off('task:updated', onTaskUpdated);
        this.blackboard.off('completed', onCompleted);
    }

    // ── 定期チェック: 保存すべきものがあるかチェック → あれば保存 ──

    private async checkAndSave(): Promise<void> {
        if (this.stopped) return;
        this.lastCheckedIteration = this.blackboard.taskState.iteration;

        const recentCalls = this.blackboard.taskState.recentToolCalls.slice(-15);
        if (recentCalls.length === 0) return;

        try {
            const callsSummary = recentCalls.map((r, i) =>
                `${i + 1}. ${r.toolName}(${JSON.stringify(r.args).substring(0, 60)}): ${r.success ? '成功' : '失敗'} — ${r.message.substring(0, 120)}`,
            ).join('\n');

            const response = await this.model.invoke([
                new SystemMessage(SAVE_JUDGE_SYSTEM_PROMPT),
                new HumanMessage(callsSummary),
            ]);

            const content = typeof response.content === 'string' ? response.content.trim() : '';
            if (!content || content === '[]') return;

            // JSON パース
            const match = content.match(/\[[\s\S]*\]/);
            if (!match) return;

            const items = JSON.parse(match[0]) as Array<{ content: string; tags?: string[]; importance?: number }>;

            for (const item of items) {
                if (!item.content) continue;
                await this.memory.save({
                    content: item.content,
                    category: 'knowledge',
                        importance: item.importance ?? 5,
                    tags: item.tags ?? this.buildTags(item.content),
                });
                logger.info(`[MemoryAgent] 💾 自律保存: ${item.content.substring(0, 80)}`);
            }
        } catch (error) {
            logger.error('[MemoryAgent] checkAndSave error:', error);
        }
    }

    // ── タスク完了時の最終保存 ──

    private async onTaskComplete(): Promise<void> {
        // 最終チェック
        await this.checkAndSave();

        // Consolidation is a separately scoped maintenance operation.
    }

    // ── ヘルパー ──

    private buildTags(content: string): string[] {
        const tags: string[] = [];
        if (this.envelope.channel) tags.push(this.envelope.channel);

        // 座標タグ (content 内の座標パターンを検出)
        const coordMatch = content.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
        if (coordMatch) {
            tags.push(`location:${coordMatch[1]}_${coordMatch[2]}_${coordMatch[3]}`);
        }

        // アイテムタグ (snake_case パターン)
        const itemMatches = content.match(/[a-z][a-z_]+[a-z]/g);
        if (itemMatches) {
            for (const item of itemMatches.slice(0, 5)) {
                tags.push(item);
            }
        }

        return tags;
    }
}
