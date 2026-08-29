import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';
import { RecipeDependencyResolver } from '../../../minebot/knowledge/RecipeDependencyResolver.js';
import { createTracedModel } from '../../utils/langfuse.js';
import type { MemoryAgent } from '../../graph/cognitive/MemoryAgent.js';
import type { CognitiveBlackboard, PlanState, PlanSubtask } from '../../graph/cognitive/CognitiveBlackboard.js';

/**
 * plan-craft ツール — クラフト計画生成。
 *
 * FCA のツールとして実装。FCA が「クラフトが必要」と判断した時に呼ぶ。
 *
 * 処理フロー:
 * 1. 情報収集 (決定論的): レシピ解決 + インベントリ + 近傍インフラ
 * 2. 記憶問い合わせ (MemoryAgent): チェスト/かまどの中身
 * 3. LLM 計画生成: PlanState を構造化出力で生成
 */

const PLAN_SYSTEM_PROMPT = `あなたはマインクラフトのクラフト計画を立てるアシスタントです。
与えられた情報から、目標アイテムをクラフトするための最適な手順を立ててください。

以下の JSON 形式で出力してください:
{
  "strategy": "戦略の要約 (1行)",
  "subtasks": [
    { "goal": "サブタスクの目標", "id": "st_1" },
    { "goal": "サブタスクの目標", "id": "st_2" }
  ]
}

注意:
- インベントリに既にある素材は採掘しない
- 記憶にあるチェスト/かまどの中身を活用する
- crafting_table / furnace が近くにあれば活用する
- 不足素材は具体的なブロック名と個数を指定する
- 精錬が必要な場合は明示する`;

export default class PlanCraftTool extends StructuredTool {
    /** Request context is never copied from the catalog instance. */
    createForRun(): PlanCraftTool { return new PlanCraftTool(); }

    name = 'plan-craft';
    description = 'アイテムのクラフト・精錬計画を立てる。レシピ依存、インベントリ、周辺インフラ、記憶を考慮して最適な手順を出力する。';
    schema = z.object({
        target: z.string().describe('クラフトしたいアイテム名 (例: "stone_pickaxe", "iron_ingot")'),
        count: z.number().optional().describe('個数 (デフォルト1)'),
    });

    private memoryAgent: MemoryAgent | null = null;
    private blackboard: CognitiveBlackboard | null = null;
    private bot: unknown = null;
    private model: ChatOpenAI;

    constructor() {
        super();
        this.model = createTracedModel({
            modelName: 'gpt-4.1-mini',
            apiKey: config.openaiApiKey,
        });
    }

    setMemoryAgent(agent: MemoryAgent): void {
        this.memoryAgent = agent;
    }

    setBlackboard(blackboard: CognitiveBlackboard): void {
        this.blackboard = blackboard;
    }

    setBot(bot: unknown): void {
        this.bot = bot;
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        const { target, count = 1 } = data;

        try {
            // ① 情報収集 (決定論的)
            let recipeInfo = '';
            try {
                const resolver = RecipeDependencyResolver.getInstance('1.20');
                const tree = resolver.resolve(target);
                recipeInfo = tree ? this.formatDependencyTree(tree) : `レシピが見つかりません: ${target}`;
            } catch {
                recipeInfo = `レシピ解決エラー: ${target}`;
            }

            // インベントリ
            const inventory = this.blackboard?.selfState?.inventory;
            const inventoryInfo = inventory && inventory.length > 0
                ? inventory.map(e => `${e.name} x${e.count}`).join(', ')
                : '空';

            // 近傍インフラ (bot から取得)
            let infraInfo = '不明';
            try {
                const mcMeta = this.getMinecraftMetadata();
                if (mcMeta?.nearbyInfrastructure) {
                    const infra = mcMeta.nearbyInfrastructure as Array<{ name: string; x: number; y: number; z: number; distance: number }>;
                    infraInfo = infra.length > 0
                        ? infra.map(i => `${i.name}(${i.x},${i.y},${i.z}) 距離${i.distance.toFixed(1)}m`).join(', ')
                        : 'なし';
                }
            } catch { /* optional */ }

            // ② 記憶問い合わせ (MemoryAgent)
            let memoryInfo = '';
            if (this.memoryAgent) {
                try {
                    const memories = await this.memoryAgent.query(
                        `${target}のクラフトに関連する情報、近くのチェストやかまどの中身`,
                    );
                    if (memories && !memories.includes('記憶にありません')) {
                        memoryInfo = memories;
                    }
                } catch { /* optional */ }
            }

            // ③ LLM 計画生成
            const prompt = [
                `目標: ${target} x${count}`,
                `レシピ依存ツリー:\n${recipeInfo}`,
                `インベントリ: ${inventoryInfo}`,
                `近傍インフラ: ${infraInfo}`,
                memoryInfo ? `記憶:\n${memoryInfo}` : '',
            ].filter(Boolean).join('\n\n');

            const response = await this.model.invoke([
                new SystemMessage(PLAN_SYSTEM_PROMPT),
                new HumanMessage(prompt),
            ]);

            const content = typeof response.content === 'string' ? response.content : '';

            // JSON パース
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return `計画生成に失敗しました。手動でクラフトを進めてください。\n参考:\n${recipeInfo}`;
            }

            const parsed = JSON.parse(jsonMatch[0]) as {
                strategy: string;
                subtasks: Array<{ goal: string; id: string }>;
            };

            // PlanState を構築して blackboard に注入
            if (this.blackboard) {
                const now = Date.now();
                const subtasks: PlanSubtask[] = parsed.subtasks.map((st, i) => ({
                    id: st.id || `st_${i + 1}`,
                    goal: st.goal,
                    status: i === 0 ? 'in_progress' as const : 'pending' as const,
                    iterationsSpent: 0,
                    children: [],
                    createdBy: 'plan_craft' as const,
                    createdAt: now,
                }));

                const planState: PlanState = {
                    goal: `${target} x${count}`,
                    strategy: parsed.strategy,
                    subtasks,
                    currentSubtaskId: subtasks[0]?.id ?? null,
                    journalSummary: `プラン作成: ${target} x${count}。${subtasks.length}サブタスク。戦略: ${parsed.strategy}`,
                    lastUpdatedBy: 'plan_craft',
                    createdAt: now,
                    updatedAt: now,
                };
                this.blackboard.updatePlan(planState);

                logger.info(`[plan-craft] 📋 プラン生成: ${subtasks.length}サブタスク — ${parsed.strategy}`);
            }

            // FCA に返す概要
            const summary = parsed.subtasks.map((st, i) => `${i + 1}. ${st.goal}`).join('\n');
            return `【クラフト計画】${target} x${count}\n戦略: ${parsed.strategy}\n手順:\n${summary}`;

        } catch (error) {
            logger.error('[plan-craft] error:', error);
            return `クラフト計画の生成に失敗しました: ${error}`;
        }
    }

    private formatDependencyTree(tree: unknown, depth = 0): string {
        if (!tree || typeof tree !== 'object') return '';
        const t = tree as Record<string, unknown>;
        const indent = '  '.repeat(depth);
        const method = t.method ?? 'raw';
        let line = `${indent}${t.item} x${t.count ?? 1} (${method})`;
        if (Array.isArray(t.children)) {
            for (const child of t.children) {
                line += '\n' + this.formatDependencyTree(child, depth + 1);
            }
        }
        return line;
    }

    private getMinecraftMetadata(): Record<string, unknown> | null {
        // blackboard の envelope から取得するのが理想だが、
        // 現時点では bot 経由でアクセスする方法がないため null を返す
        // TODO: 実行経路から minecraft metadata を渡す
        return null;
    }
}
