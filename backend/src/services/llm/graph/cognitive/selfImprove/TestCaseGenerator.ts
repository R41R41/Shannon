/**
 * TestCaseGenerator — スキル定義 + ワールド状態からテストケースを自動生成
 *
 * スキルのパラメータ定義と bot の現在状態を読み取り、
 * LLM を使って実行可能なテストケースを生成する。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createTracedModel } from '../../../utils/langfuse.js';
import { createLogger } from '../../../../../utils/logger.js';
import type { TestCase } from './types.js';
import type { CustomBot, InstantSkill } from '../../../../minebot/types.js';

const log = createLogger('SelfTest:TestGen');

/** テスト時にスキップするスキル（副作用が大きい/特定条件が必要） */
const SKIP_SKILLS = new Set([
    'attack-nearest', 'attack-continuously', 'combat',
    'flee-from', 'stair-mine', 'enter-portal',
    'sleep-in-bed', 'drop-item', 'fill-area',
    'chat', 'disconnect',
]);

// ── Zod Schema ──

const TestCaseSchema = z.object({
    tests: z.array(z.object({
        args: z.array(z.unknown()).describe('スキルの params 順に並べた引数配列'),
        description: z.string().describe('テスト内容の説明（日本語）'),
        preconditions: z.array(z.string()).describe('このテストの前提条件'),
        expectedOutcome: z.enum(['success', 'failure', 'either']).describe('期待される結果'),
    })),
});

const SYSTEM_PROMPT = `あなたは Minecraft bot のスキルテストケースジェネレーターです。
スキルの定義とボットの現在状態から、今すぐ実行可能なテストケースを1-3個生成してください。

ルール:
- args はスキルの params 定義の順序に合わせた配列で返す
- 現在のワールド状態で実行可能なテストのみ生成する（材料がなければテスト不可）
- 座標を使う場合は bot の現在位置の近く（半径16以内）にする
- expectedOutcome は前提条件が満たされていれば 'success'、不明なら 'either'
- 危険なテスト（大量破壊、遠距離移動）は避ける
- デフォルト値があるパラメータは省略可能（undefined で渡す）`;

export class TestCaseGenerator {
    /**
     * スキル定義と bot 状態からテストケースを生成する。
     * パラメータなしスキルは LLM を使わず直接生成。
     */
    async generate(skill: InstantSkill, bot: CustomBot): Promise<TestCase[]> {
        const skillName = skill.skillName;

        // スキップリストチェック
        if (SKIP_SKILLS.has(skillName)) {
            return [];
        }

        const params = skill.params ?? [];

        // パラメータなしスキル → LLM 不要
        if (params.length === 0 || params.every(p => !p.required && p.default !== undefined)) {
            return [{
                id: `${skillName}-default-0`,
                skillName,
                args: [],
                description: `${skillName} をデフォルト引数で実行`,
                expectedOutcome: 'either',
            }];
        }

        try {
            const worldContext = this.buildWorldContext(bot);
            const prompt = this.buildPrompt(skill, worldContext);

            const model = createTracedModel({
                modelName: 'gpt-4.1-mini',
                temperature: 0.3,
            });
            const structuredLLM = model.withStructuredOutput(TestCaseSchema, {
                name: 'TestCaseGeneration',
            });

            const response = await structuredLLM.invoke([
                new SystemMessage(SYSTEM_PROMPT),
                new HumanMessage(prompt),
            ]);

            if (!response?.tests?.length) {
                log.info(`テストケース生成なし: ${skillName}`);
                return [];
            }

            return response.tests.map((t: z.infer<typeof TestCaseSchema>['tests'][number], i: number) => ({
                id: `${skillName}-gen-${i}`,
                skillName,
                args: t.args,
                description: t.description,
                expectedOutcome: t.expectedOutcome,
            }));
        } catch (err: any) {
            log.error(`テストケース生成エラー (${skillName}): ${err.message}`);
            return [];
        }
    }

    /** bot の現在状態をテキスト化 */
    private buildWorldContext(bot: CustomBot): string {
        const lines: string[] = [];

        // 位置
        const pos = bot.entity?.position;
        if (pos) {
            lines.push(`位置: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`);
        }

        // HP / 食料
        lines.push(`HP: ${bot.health ?? '?'}/20, 食料: ${bot.food ?? '?'}/20`);

        // ディメンション
        const dimension = (bot as any).game?.dimension ?? 'overworld';
        lines.push(`ディメンション: ${dimension}`);

        // インベントリ（上位10アイテム）
        const items = bot.inventory?.items() ?? [];
        if (items.length > 0) {
            const summary = items
                .slice(0, 10)
                .map(i => `${i.name} x${i.count}`)
                .join(', ');
            lines.push(`インベントリ: ${summary}${items.length > 10 ? ` 他${items.length - 10}種` : ''}`);
        } else {
            lines.push('インベントリ: 空');
        }

        // 周辺ブロック（主要なもの）
        try {
            const scanBlocks = ['crafting_table', 'furnace', 'chest', 'stone', 'dirt', 'oak_log'];
            const found: string[] = [];
            for (const blockName of scanBlocks) {
                const blockId = (bot as any).registry?.blocksByName?.[blockName]?.id;
                if (blockId == null) continue;
                const blocks = bot.findBlocks({ matching: blockId, maxDistance: 16, count: 1 });
                if (blocks.length > 0) {
                    const b = blocks[0];
                    found.push(`${blockName}(${b.x},${b.y},${b.z})`);
                }
            }
            if (found.length > 0) {
                lines.push(`周辺ブロック: ${found.join(', ')}`);
            }
        } catch { /* non-critical */ }

        return lines.join('\n');
    }

    /** LLM プロンプトを構築 */
    private buildPrompt(skill: InstantSkill, worldContext: string): string {
        const params = skill.params ?? [];
        const paramDesc = params.map(p =>
            `  - ${p.name} (${p.type}${p.required ? ', 必須' : ', 任意'}): ${p.description}${p.default !== undefined ? ` [default: ${p.default}]` : ''}`,
        ).join('\n');

        return `## スキル情報
名前: ${skill.skillName}
説明: ${skill.description}
パラメータ:
${paramDesc || '  なし'}

## 現在のワールド状態
${worldContext}

上記の情報を基に、今すぐ実行可能なテストケースを1-3個生成してください。`;
    }
}
