/**
 * ImprovementGenerator — 改善案生成
 *
 * FailureAnalyzer の分析結果を受け取り、具体的な改善案（ImprovementProposal）を生成する。
 *
 * Tier 1: gpt-4.1-mini でプロンプトルール / ForwardModel ルールの JSON パッチを生成
 * Tier 2: Claude / gpt-4.1 でスキルコードの TypeScript 修正を生成
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createTracedModel } from '../../../utils/langfuse.js';
import { createLogger } from '../../../../../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import type {
    FailureAnalysisResult,
    FailureCluster,
    ImprovementProposal,
    ImprovementScope,
} from './types.js';
import { SELF_IMPROVE_CONSTANTS as C } from './types.js';
import { sanitizeMutableRelativePath } from './mutableCodePolicy.js';

const log = createLogger('SelfImprove:Generator');

// ── Zod Schemas ──

const Tier1ProposalSchema = z.object({
    target: z.enum(['prompt', 'forward_model']).describe('追加先 (prompt=PromptBuilder, forward_model=ForwardModel)'),
    rule: z.string().describe('追加するルール文（日本語、1-3文）。プロンプトの場合はMarkdownの箇条書き形式、ForwardModelの場合は条件→結果の形式で記述'),
    reasoning: z.string().describe('このルールが必要な理由（1文）'),
});

const Tier1OutputSchema = z.object({
    proposals: z.array(Tier1ProposalSchema).describe('Tier 1 改善案リスト'),
});

const Tier2ProposalSchema = z.object({
    action: z
        .enum(['replace', 'delete'])
        .describe('replace=ファイル全文を fullSource で上書き。delete=ファイル削除（運用で明示許可時のみ）'),
    description: z.string().describe('コード修正の説明（日本語、1-2文）'),
    targetFile: z.string().describe(
        'backend パッケージルートからの相対パス。例: src/services/llm/graph/cognitive/foo.ts',
    ),
    fullSource: z.string().describe(
        'action=replace のとき、修正後のファイルの完全な TypeScript ソース。delete のときは空文字',
    ),
    reasoning: z.string().describe('この修正が必要な理由（1文）'),
});

const Tier2OutputSchema = z.object({
    proposals: z.array(Tier2ProposalSchema).describe('Tier 2 改善案リスト'),
});

// ── System Prompts ──

const TIER1_SYSTEM_PROMPT = `あなたは Minecraft ボット「シャノン」の行動ルールを改善するエキスパートです。

失敗分析の結果に基づいて、以下のいずれかの形式でルールを生成してください:

## prompt ルール（PromptBuilder に追加）
- LLM が行動を決定する際のガイドラインとして追加される
- 「〜する前に〜を確認する」「〜の場合は〜を優先する」等の行動指針
- Markdown 箇条書き形式（「- **太字部分**: 説明」）

## forward_model ルール（ForwardModel に追加）
- ツール実行前の失敗予測に使われる
- 「[ツール名] を [条件] で呼んだ場合 → [予測結果]」の形式
- より具体的・技術的な条件を記述

## 注意事項
- 既存ルールと重複しないようにする
- 過度に一般的なルールは避け、具体的な失敗パターンに対応したルールにする
- 1つの失敗クラスタに対して最大2つまでのルールを生成`;

const TIER2_SYSTEM_PROMPT = `あなたは Shannon バックエンドの TypeScript を改善するシニアエンジニアです。

## 出力形式（必須）
- action=replace のとき、fullSource に **修正後のファイル全文** を入れる（差分説明だけでは不可）。
- 未変更の部分も含め、コンパイル可能な完全なファイルにする。
- action=delete は原則使わない（本当にファイルが不要なときのみ）。

## 編集してよいパス
- **backend パッケージ直下のほぼすべて**（\`src/config/\`・package.json・tsconfig・.env・ロックファイル・node_modules・dist 等は不可）
- **優先して修正を検討するディレクトリ**（失敗がスキル／認知に関係するときは特に）:
${C.TIER2_PRIORITY_PATHS.map(p => `- ${p}`).join('\n')}

## minebot（\`src/services/minebot/\`）
- スキル（instantSkills / constantSkills）: InstantSkill / ConstantSkill の継承・runImpl・skillName を維持。
- その他 minebot モジュール: 既存の Bot API・イベント・import 規約に合わせる。

## src/services/llm（グラフ・クライアント・認知層）
- LangGraph / LangChain / 既存の import 規約に合わせる。
- 推測で API を変えない。ユーザープロンプトに載っている現行ソースと同じ公開シンボルを優先する。

## 品質
- 失敗ログ・クラスタ要約に直接対応する最小変更。
- 型・エクスポートを壊さない。`;

export class ImprovementGenerator {
    /**
     * 分析結果から改善案を生成する。
     */
    async generate(analysis: FailureAnalysisResult): Promise<ImprovementProposal[]> {
        const proposals: ImprovementProposal[] = [];

        // Tier 1 クラスタと Tier 2 クラスタを分離
        const tier1Clusters = analysis.clusters.filter(c => c.suggestedTier === 1);
        const tier2Clusters = analysis.clusters.filter(c => c.suggestedTier === 2);

        // Tier 1: プロンプト/ForwardModel ルール生成
        if (tier1Clusters.length > 0) {
            try {
                const tier1Proposals = await this.generateTier1(tier1Clusters);
                proposals.push(...tier1Proposals);
            } catch (err) {
                log.error('Tier 1 改善案生成エラー', err);
            }
        }

        // Tier 2: コード修正案生成
        if (tier2Clusters.length > 0) {
            try {
                const tier2Proposals = await this.generateTier2(tier2Clusters);
                proposals.push(...tier2Proposals);
            } catch (err) {
                log.error('Tier 2 改善案生成エラー', err);
            }
        }

        return proposals;
    }

    // ── Tier 1: JSON ルール生成 ──

    private async generateTier1(clusters: FailureCluster[]): Promise<ImprovementProposal[]> {
        const model = createTracedModel({
            modelName: 'gpt-4.1-mini',
            temperature: 0.3,
        });

        const structuredLLM = model.withStructuredOutput(Tier1OutputSchema, {
            name: 'Tier1Improvement',
        });

        const prompt = this.buildTier1Prompt(clusters);

        const response = await structuredLLM.invoke([
            new SystemMessage(TIER1_SYSTEM_PROMPT),
            new HumanMessage(prompt),
        ]);

        return response.proposals.map((p, i) => {
            const cluster = clusters[Math.min(i, clusters.length - 1)];
            const scope: ImprovementScope = p.target === 'prompt' ? 'prompt_rule' : 'forward_model';

            return {
                id: randomUUID(),
                tier: 1 as const,
                scope,
                description: `[${p.target}] ${p.rule.substring(0, 80)}`,
                targetFile: null,
                content: p.rule,
                sourceCluster: cluster,
                createdAt: Date.now(),
            };
        });
    }

    private buildTier1Prompt(clusters: FailureCluster[]): string {
        const lines: string[] = ['## 失敗クラスタ分析結果\n'];

        for (let i = 0; i < clusters.length; i++) {
            const c = clusters[i];
            lines.push(`### クラスタ ${i + 1}: ${c.rootCause}`);
            lines.push(`- 要約: ${c.summary}`);
            lines.push(`- 発生回数: ${c.occurrenceCount}`);
            if (c.affectedSkill) lines.push(`- 関連スキル: ${c.affectedSkill}`);
            lines.push('');
        }

        lines.push('上記の失敗パターンを防ぐためのルールを生成してください。');

        return lines.join('\n');
    }

    // ── Tier 2: コード修正案生成 ──

    private async generateTier2(clusters: FailureCluster[]): Promise<ImprovementProposal[]> {
        const model = createTracedModel({
            modelName: 'gpt-4.1-mini',
            temperature: 0.2,
        });

        const structuredLLM = model.withStructuredOutput(Tier2OutputSchema, {
            name: 'Tier2Improvement',
        });

        const prompt = await this.buildTier2Prompt(clusters);

        const response = await structuredLLM.invoke([
            new SystemMessage(TIER2_SYSTEM_PROMPT),
            new HumanMessage(prompt),
        ]);

        return response.proposals.map((p, i) => {
            const cluster = clusters[Math.min(i, clusters.length - 1)];
            const norm = sanitizeMutableRelativePath(p.targetFile) ?? p.targetFile;
            const scope: ImprovementScope = norm.includes('src/services/llm/')
                ? 'llm_code'
                : 'skill_code';

            return {
                id: randomUUID(),
                tier: 2 as const,
                scope,
                description: p.description,
                targetFile: p.targetFile,
                content: p.action === 'delete' ? '' : p.fullSource,
                tier2Action: p.action,
                sourceCluster: cluster,
                createdAt: Date.now(),
            };
        });
    }

    private async buildTier2Prompt(clusters: FailureCluster[]): Promise<string> {
        const lines: string[] = ['## コード修正が必要な失敗クラスタ\n'];

        for (let i = 0; i < clusters.length; i++) {
            const c = clusters[i];
            lines.push(`### クラスタ ${i + 1}: ${c.rootCause}`);
            lines.push(`- 要約: ${c.summary}`);
            lines.push(`- 発生回数: ${c.occurrenceCount}`);
            if (c.affectedSkill) {
                lines.push(`- 関連スキル: ${c.affectedSkill}`);
            }
            lines.push('');
        }

        lines.push('\n## 現在のソース（推定・参照用）\n');

        for (const c of clusters) {
            if (c.affectedSkill) {
                const excerpt = await this.findAndReadSkillFile(c.affectedSkill);
                if (excerpt) lines.push(excerpt);
            }
        }

        const graphHint = await this.readFixedLlmExcerpts();
        if (graphHint) lines.push(graphHint);

        lines.push(
            '\n上記を踏まえ、**1 ファイルずつ** fullSource 付きの修正案を返してください。'
            + 'targetFile は必ず「編集してよいパス」の配下に限定してください。',
        );

        return lines.join('\n');
    }

    /** skillName を含む minebot スキル .ts を探索して読む */
    private async findAndReadSkillFile(skillName: string): Promise<string | null> {
        const root = getBackendRoot();
        const subdirs = ['instantSkills', 'constantSkills', 'instantSkills/generated', 'constantSkills/generated'];
        const needle = `'${skillName}'`;
        const needle2 = `"${skillName}"`;

        for (const sub of subdirs) {
            const dir = join(root, 'src/services/minebot', sub);
            let files: string[] = [];
            try {
                files = await readdir(dir);
            } catch {
                continue;
            }
            for (const f of files) {
                if (!f.endsWith('.ts')) continue;
                const abs = join(dir, f);
                const content = await readFile(abs, 'utf-8').catch(() => '');
                if (content.includes(needle) || content.includes(needle2)) {
                    const rel = `src/services/minebot/${sub}/${f}`;
                    const cap = 14_000;
                    const body = content.length > cap ? `${content.slice(0, cap)}\n/* ... truncated ... */\n` : content;
                    return `### ${rel}\n\`\`\`typescript\n${body}\n\`\`\`\n`;
                }
            }
        }
        return null;
    }

    /** グラフ周りの固定リファレンス（プロンプト品質用・短く） */
    private async readFixedLlmExcerpts(): Promise<string> {
        const root = getBackendRoot();
        const paths = [
            'src/services/llm/graph/nodes/prompt/PromptBuilder.ts',
        ];
        const parts: string[] = [];
        for (const rel of paths) {
            const abs = join(root, rel);
            const content = await readFile(abs, 'utf-8').catch(() => '');
            if (!content) continue;
            const lines = content.split('\n');
            const head = lines.slice(0, Math.min(100, lines.length)).join('\n');
            parts.push(`### ${rel}（冒頭〜100行）\n\`\`\`typescript\n${head}\n\`\`\`\n`);
        }
        return parts.length ? `\n## LLM グラフ周辺の参考抜粋\n${parts.join('\n')}` : '';
    }
}
