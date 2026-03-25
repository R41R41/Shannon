/**
 * FailureAnalyzer — 失敗パターン分析
 *
 * 蓄積された FailureRecord を gpt-4.1-mini (structuredOutput) で分類し、
 * rootCause ごとのクラスタを返す。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createTracedModel } from '../../../utils/langfuse.js';
import { createLogger } from '../../../../../utils/logger.js';
import type {
    FailureRecord,
    FailureAnalysisResult,
    FailureCluster,
    RootCause,
} from './types.js';

const log = createLogger('SelfImprove:Analyzer');

// ── Zod Schema for structuredOutput ──

const ClusterSchema = z.object({
    rootCause: z.enum([
        'skill_bug',
        'missing_precondition',
        'prompt_rule_missing',
        'recipe_missing',
        'forward_model_gap',
        'unknown',
    ]).describe('失敗の根本原因カテゴリ'),
    summary: z.string().describe('失敗パターンの要約（日本語、1-2文）'),
    relatedIndices: z.array(z.number()).describe('関連する失敗レコードのインデックス（0-based）'),
    affectedSkill: z.string().nullable().describe('関連するスキル名（mine-block, dig-block-at 等）、なければ null'),
    suggestedTier: z.union([z.literal(1), z.literal(2)]).describe('推奨改善ティア (1=JSONルール追加, 2=コード修正)'),
    confidence: z.number().min(0).max(1).describe('分析の信頼度 (0-1)'),
});

const AnalysisOutputSchema = z.object({
    clusters: z.array(ClusterSchema).describe('失敗クラスタのリスト'),
    overallConfidence: z.number().min(0).max(1).describe('全体の分析信頼度'),
});

type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

// ── System Prompt ──

const ANALYSIS_SYSTEM_PROMPT = `あなたは Minecraft ボットの失敗パターンを分析するエキスパートです。

以下の失敗エピソードリストを分析し、共通パターンをクラスタリングして根本原因を特定してください。

## 根本原因カテゴリ
- skill_bug: InstantSkill のコードにバグがある（引数の検証不足、エッジケース未処理等）
- missing_precondition: ツール実行前の前提条件チェックが不足（ツルハシなしで採掘、素材不足でクラフト等）
- prompt_rule_missing: LLM のシステムプロンプトにルールが足りない（行動指針の欠如）
- recipe_missing: クラフト/精錬のレシピ解決に不備がある
- forward_model_gap: 失敗予測ルールが不足（同じ失敗を繰り返し防げない）
- unknown: 上記に当てはまらない

## 改善ティア
- Tier 1: JSON ファイルへのルール追記で修正可能（プロンプト改善、予測ルール追加）
- Tier 2: TypeScript コードの修正が必要（スキルのロジック変更）

## 出力ルール
- 同じ根本原因の失敗はまとめて1つのクラスタにする
- 3回以上繰り返されているパターンを優先的に報告する
- confidence は根拠の明確さで判断する（繰り返しが多いほど高い）`;

export class FailureAnalyzer {
    /**
     * 失敗レコードを分析してクラスタリングする。
     */
    async analyze(records: FailureRecord[]): Promise<FailureAnalysisResult> {
        if (records.length === 0) {
            return { clusters: [], analyzedCount: 0, confidence: 0, timestamp: Date.now() };
        }

        try {
            const model = createTracedModel({
                modelName: 'gpt-4.1-mini',
                temperature: 0.1,
            });

            const structuredLLM = model.withStructuredOutput(AnalysisOutputSchema, {
                name: 'FailureAnalysis',
            });

            const prompt = this.buildAnalysisPrompt(records);

            const response: AnalysisOutput = await structuredLLM.invoke([
                new SystemMessage(ANALYSIS_SYSTEM_PROMPT),
                new HumanMessage(prompt),
            ]);

            const clusters: FailureCluster[] = response.clusters.map(c => ({
                rootCause: c.rootCause as RootCause,
                summary: c.summary,
                relatedRecordIndices: c.relatedIndices.filter(i => i >= 0 && i < records.length),
                affectedSkill: c.affectedSkill,
                occurrenceCount: c.relatedIndices.length,
                suggestedTier: c.suggestedTier,
            }));

            log.info(
                `📊 分析完了: ${clusters.length}クラスタ, confidence=${response.overallConfidence.toFixed(2)}`,
            );

            return {
                clusters,
                analyzedCount: records.length,
                confidence: response.overallConfidence,
                timestamp: Date.now(),
            };
        } catch (err) {
            log.error('LLM 分析エラー', err);
            // フォールバック: ルールベースの簡易分析
            return this.fallbackAnalysis(records);
        }
    }

    // ── プロンプト構築 ──

    private buildAnalysisPrompt(records: FailureRecord[]): string {
        const lines: string[] = [
            `## 失敗エピソード一覧 (${records.length}件)\n`,
        ];

        for (let i = 0; i < records.length; i++) {
            const r = records[i];
            const ep = r.episode;
            lines.push(`### [${i}] ${ep.goal}`);
            lines.push(`- プラットフォーム: ${ep.platform}`);
            lines.push(`- イテレーション: ${ep.iterationCount}`);
            lines.push(`- 所要時間: ${(ep.durationMs / 1000).toFixed(1)}s`);
            if (ep.failurePatterns.length > 0) {
                lines.push(`- 失敗パターン: ${ep.failurePatterns.join(' | ')}`);
            }
            if (ep.strategyUsed.length > 0) {
                lines.push(`- 使用戦略: ${ep.strategyUsed.join(' → ')}`);
            }
            if (ep.lesson) {
                lines.push(`- 教訓: ${ep.lesson}`);
            }
            if (r.metaAssessment) {
                lines.push(`- メタ認知評価: ${r.metaAssessment}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    // ── フォールバック: ルールベース分析 ──

    private fallbackAnalysis(records: FailureRecord[]): FailureAnalysisResult {
        const clusters: FailureCluster[] = [];

        // パターン集計
        const patternMap = new Map<string, number[]>();
        for (let i = 0; i < records.length; i++) {
            for (const pattern of records[i].episode.failurePatterns) {
                const key = this.normalizePattern(pattern);
                if (!patternMap.has(key)) patternMap.set(key, []);
                patternMap.get(key)!.push(i);
            }
        }

        for (const [pattern, indices] of patternMap) {
            if (indices.length < 2) continue;

            const rootCause = this.guessRootCause(pattern);
            const skill = this.extractSkillFromPattern(pattern);

            clusters.push({
                rootCause,
                summary: `繰り返し失敗パターン: ${pattern} (${indices.length}回)`,
                relatedRecordIndices: indices,
                affectedSkill: skill,
                occurrenceCount: indices.length,
                suggestedTier: rootCause === 'skill_bug' ? 2 : 1,
            });
        }

        return {
            clusters,
            analyzedCount: records.length,
            confidence: 0.4, // フォールバック分析の信頼度は低い
            timestamp: Date.now(),
        };
    }

    private normalizePattern(pattern: string): string {
        // 座標や数値を汎化
        return pattern
            .replace(/\(-?\d+\.?\d*,\s*-?\d+\.?\d*,\s*-?\d+\.?\d*\)/g, '(x,y,z)')
            .replace(/\d+\.?\d*m/g, 'Nm')
            .replace(/\d+個/g, 'N個')
            .substring(0, 100);
    }

    private guessRootCause(pattern: string): RootCause {
        const lower = pattern.toLowerCase();
        if (lower.includes('missing_tool') || lower.includes('ツルハシ') || lower.includes('ツール')) {
            return 'missing_precondition';
        }
        if (lower.includes('craft') || lower.includes('レシピ')) {
            return 'recipe_missing';
        }
        if (lower.includes('stuck') || lower.includes('スタック') || lower.includes('繰り返し')) {
            return 'forward_model_gap';
        }
        return 'unknown';
    }

    private extractSkillFromPattern(pattern: string): string | null {
        const match = pattern.match(/\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/);
        return match?.[1] ?? null;
    }
}
