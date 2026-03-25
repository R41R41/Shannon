/**
 * SkillIdeator — プロアクティブ・スキル発想
 *
 * タスク完了後のエピソードからツール呼び出しパターンを蓄積し、
 * 繰り返し出現するパターンを新スキルとして抽象化することを提案する。
 *
 * 入力:
 *   - 成功/失敗エピソードの strategyUsed（ツール列）
 *   - MetaCognition の非効率シグナル
 *   - ユーザーの明示的リクエスト
 *
 * 出力: SkillIdeation（スキル仕様）
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createTracedModel } from '../../../utils/langfuse.js';
import { createLogger } from '../../../../../utils/logger.js';
import type { TaskEpisode } from '../TaskEpisodeMemory.js';
import type { SkillIdeation, ToolSequencePattern } from './types.js';
import { SELF_IMPROVE_CONSTANTS as C } from './types.js';

const log = createLogger('SelfImprove:Ideator');

// ── Zod Schema ──

const IdeationSchema = z.object({
    shouldCreate: z.boolean().describe('新スキルの生成が有効かどうか'),
    type: z.enum(['instant', 'constant']).describe('生成するスキルの種別'),
    name: z.string().describe('kebab-case のスキル名（例: mine-and-collect, auto-torch-placer）'),
    description: z.string().describe('スキルの説明（日本語、1-2文）'),
    rationale: z.string().describe('このスキルが必要な理由（日本語、1文）'),
    params: z.array(z.object({
        name: z.string(),
        type: z.enum(['string', 'number', 'boolean']),
        description: z.string(),
        required: z.boolean(),
    })).describe('パラメータ定義（InstantSkill の場合）'),
    suggestedInterval: z.number().nullable().describe('ConstantSkill の実行間隔 (ms)。InstantSkill なら null'),
    suggestedPriority: z.number().nullable().describe('ConstantSkill の優先度。InstantSkill なら null'),
    confidence: z.number().min(0).max(1).describe('提案の信頼度 (0-1)'),
});

const IdeationOutputSchema = z.object({
    ideations: z.array(IdeationSchema).describe('スキル提案リスト（最大2件）'),
});

// ── System Prompt ──

const IDEATION_SYSTEM_PROMPT = `あなたは Minecraft ボット「シャノン」のスキルアーキテクトです。

ボットのタスク実行パターンを分析し、繰り返し使われるツール列や自動化すべき行動を新スキルとして提案してください。

## スキル種別
- **InstantSkill**: 単発実行（1-120秒）。LLM がツールとして呼び出す。例: mine-block, craft-one
- **ConstantSkill**: バックグラウンド定期実行。例: auto-eat (1秒毎に食料チェック)

## 提案基準
- 3回以上繰り返されているツール呼び出し列は抽象化の候補
- 手動で毎回行っている作業は ConstantSkill 化の候補
- 既存スキルと重複しないこと
- シンプルで汎用性のあるスキルを優先

## 既存スキル
InstantSkill: get-position, move-to, dig-block-at, mine-block, place-block-at, craft-one,
  start-smelting, check-furnace, withdraw-from-furnace, find-blocks, check-inventory-item,
  pickup-nearest-item, get-health, get-weather, activate-block, attack-entity, describe-surroundings
ConstantSkill: auto-eat, auto-pick-up-item, auto-run-from-hostiles, auto-sleep,
  auto-update-looking-at, auto-swim

## 注意
- shouldCreate=false にするのは、パターンが不十分or既存スキルで十分な場合
- name は kebab-case（例: mine-and-smelt, auto-torch-placer）
- confidence は根拠の明確さで判断`;

export class SkillIdeator {
    /** ツール列パターンバッファ */
    private sequenceBuffer: Map<string, ToolSequencePattern> = new Map();

    /** プロアクティブ実行タイムスタンプ */
    private proactiveRunTimestamps: number[] = [];
    private lastProactiveRunAt: number | null = null;

    /**
     * エピソード完了時にツール列パターンを蓄積する。
     */
    onEpisodeCompleted(episode: TaskEpisode): void {
        if (episode.strategyUsed.length < C.MIN_SEQUENCE_LENGTH) return;

        // ツール列からスキル名を抽出
        const toolNames = episode.strategyUsed
            .map(s => this.extractToolName(s))
            .filter(Boolean) as string[];

        if (toolNames.length < C.MIN_SEQUENCE_LENGTH) return;

        // スライディングウィンドウで部分列を抽出
        for (let len = C.MIN_SEQUENCE_LENGTH; len <= Math.min(toolNames.length, 6); len++) {
            for (let i = 0; i <= toolNames.length - len; i++) {
                const subsequence = toolNames.slice(i, i + len);
                const key = subsequence.join('->');

                const existing = this.sequenceBuffer.get(key);
                if (existing) {
                    existing.count++;
                    existing.lastSeen = Date.now();
                    if (existing.exampleGoals.length < 3 && !existing.exampleGoals.includes(episode.goal)) {
                        existing.exampleGoals.push(episode.goal);
                    }
                } else {
                    this.sequenceBuffer.set(key, {
                        key,
                        count: 1,
                        exampleGoals: [episode.goal],
                        lastSeen: Date.now(),
                    });
                }
            }
        }

        // 古いパターンを掃除（24時間以上前）
        const cutoff = Date.now() - 24 * 3600_000;
        for (const [key, pattern] of this.sequenceBuffer) {
            if (pattern.lastSeen < cutoff) {
                this.sequenceBuffer.delete(key);
            }
        }
    }

    /**
     * ユーザーの明示的リクエストからスキル仕様を生成する。
     */
    async ideateFromUserRequest(description: string): Promise<SkillIdeation | null> {
        try {
            const model = createTracedModel({
                modelName: 'gpt-4.1-mini',
                temperature: 0.3,
            });

            const structuredLLM = model.withStructuredOutput(IdeationSchema, {
                name: 'UserSkillIdeation',
            });

            const response = await structuredLLM.invoke([
                new SystemMessage(IDEATION_SYSTEM_PROMPT),
                new HumanMessage(`ユーザーからのスキル作成リクエスト:\n${description}\n\n上記の要望に基づいてスキル仕様を生成してください。`),
            ]);

            if (!response.shouldCreate) return null;

            return {
                type: response.type,
                name: response.name,
                description: response.description,
                rationale: response.rationale,
                params: response.params,
                suggestedInterval: response.suggestedInterval ?? undefined,
                suggestedPriority: response.suggestedPriority ?? undefined,
                confidence: response.confidence,
            };
        } catch (err) {
            log.error('ユーザーリクエスト解析エラー', err);
            return null;
        }
    }

    /**
     * 蓄積されたパターンを分析してスキル提案を生成する。
     */
    async analyzePatterns(): Promise<SkillIdeation[]> {
        // 十分な頻度のパターンを抽出
        const frequentPatterns = Array.from(this.sequenceBuffer.values())
            .filter(p => p.count >= C.MIN_SEQUENCE_OCCURRENCES)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        if (frequentPatterns.length === 0) return [];

        try {
            const model = createTracedModel({
                modelName: 'gpt-4.1-mini',
                temperature: 0.3,
            });

            const structuredLLM = model.withStructuredOutput(IdeationOutputSchema, {
                name: 'PatternSkillIdeation',
            });

            const prompt = this.buildPatternPrompt(frequentPatterns);

            const response = await structuredLLM.invoke([
                new SystemMessage(IDEATION_SYSTEM_PROMPT),
                new HumanMessage(prompt),
            ]);

            return response.ideations
                .filter(i => i.shouldCreate && i.confidence >= 0.5)
                .map(i => ({
                    type: i.type,
                    name: i.name,
                    description: i.description,
                    rationale: i.rationale,
                    abstractedSequence: undefined,
                    params: i.params,
                    suggestedInterval: i.suggestedInterval ?? undefined,
                    suggestedPriority: i.suggestedPriority ?? undefined,
                    confidence: i.confidence,
                }));
        } catch (err) {
            log.error('パターン分析エラー', err);
            return [];
        }
    }

    /**
     * プロアクティブ発想をトリガーすべきか判定する。
     */
    shouldTriggerIdeation(): boolean {
        // パターンが十分ない
        const frequentCount = Array.from(this.sequenceBuffer.values())
            .filter(p => p.count >= C.MIN_SEQUENCE_OCCURRENCES)
            .length;
        if (frequentCount === 0) return false;

        // クールダウン
        if (this.lastProactiveRunAt && Date.now() - this.lastProactiveRunAt < C.PROACTIVE_COOLDOWN_MS) {
            return false;
        }

        // 1時間あたり上限
        const oneHourAgo = Date.now() - 3600_000;
        const recentRuns = this.proactiveRunTimestamps.filter(t => t > oneHourAgo).length;
        if (recentRuns >= C.MAX_PROACTIVE_RUNS_PER_HOUR) return false;

        return true;
    }

    /**
     * 実行タイムスタンプを記録する。
     */
    recordRun(): void {
        this.lastProactiveRunAt = Date.now();
        this.proactiveRunTimestamps.push(Date.now());
        const oneHourAgo = Date.now() - 3600_000;
        this.proactiveRunTimestamps = this.proactiveRunTimestamps.filter(t => t > oneHourAgo);
    }

    /**
     * 現在のパターンバッファの状態を取得する（デバッグ用）。
     */
    getBufferStats(): { totalPatterns: number; frequentPatterns: number } {
        const frequent = Array.from(this.sequenceBuffer.values())
            .filter(p => p.count >= C.MIN_SEQUENCE_OCCURRENCES)
            .length;
        return {
            totalPatterns: this.sequenceBuffer.size,
            frequentPatterns: frequent,
        };
    }

    // ── private ──

    private extractToolName(strategyEntry: string): string | null {
        // strategyUsed は "goal description" 形式
        // スキル名っぽいパターンを抽出
        const match = strategyEntry.match(/\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/);
        return match?.[1] ?? null;
    }

    private buildPatternPrompt(patterns: ToolSequencePattern[]): string {
        const lines: string[] = ['## 検出されたツール呼び出しパターン\n'];

        for (const p of patterns) {
            lines.push(`### パターン: ${p.key}`);
            lines.push(`- 出現回数: ${p.count}`);
            lines.push(`- 使用例: ${p.exampleGoals.join(', ')}`);
            lines.push('');
        }

        lines.push('上記のパターンを分析し、新スキルとして抽象化すべきものを提案してください。');
        lines.push('既存スキルで十分な場合は shouldCreate=false としてください。');

        return lines.join('\n');
    }
}
