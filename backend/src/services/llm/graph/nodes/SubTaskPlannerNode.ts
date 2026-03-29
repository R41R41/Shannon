/**
 * SubTaskPlannerNode — Minecraft の複雑タスクを1回の LLM 呼出でサブタスク分解
 *
 * ClassifyNode が needsPlanning=true と判断した Minecraft タスクに対し、
 * ルーチンカタログ + 現在インベントリ + strategy/worldModel を元に、
 * gpt-4.1-mini の structured output でサブタスクプランを生成する。
 *
 * 各サブタスクは type: 'routine' (LLM 0回) か type: 'fca' (mini-FCA) に分類される。
 */

import { z } from 'zod';
import { createLogger } from '../../../../utils/logger.js';
import { createTracedModel } from '../../utils/langfuse.js';
import type { ToolCategory } from '../cognitive/ToolCategoryMap.js';

const log = createLogger('LLM:SubTaskPlanner');

// ─── 型定義 ───

export interface SubTaskPlanEntry {
    id: string;
    goal: string;
    type: 'routine' | 'fca';
    routineName?: string;
    routineParams?: Record<string, unknown>;
    toolCategory?: ToolCategory;
}

export interface SubTaskPlanResult {
    strategy: string;
    subtasks: SubTaskPlanEntry[];
}

/** RoutineManager の最小インターフェース（循環参照回避） */
interface RoutineManagerLike {
    getAll(): Array<{
        name: string;
        description: string;
        params: Array<{ name: string; type: string; description: string; default?: unknown }>;
        steps: unknown[];
    }>;
}

// ─── Zod Schema for Structured Output ───

const SubTaskSchema = z.object({
    strategy: z.string().describe('全体戦略の1行要約'),
    subtasks: z.array(z.object({
        id: z.string().describe('サブタスクID (st_1, st_2, ...)'),
        goal: z.string().describe('サブタスクのゴール'),
        type: z.enum(['routine', 'fca']).describe('routine = ルーチンで実行 (LLM不要), fca = 個別スキルで実行'),
        routineName: z.string().optional().describe('type=routine のとき、使用するルーチン名'),
        routineParams: z.record(z.unknown()).optional().describe('type=routine のとき、ルーチンに渡すパラメータ'),
        toolCategory: z.string().optional().describe('type=fca のとき、必要なツールカテゴリ (mining/crafting/smelting/navigation/combat/farming/building/inventory/observation/utility)'),
    })),
});

// ─── SubTaskPlannerNode ───

export class SubTaskPlannerNode {
    private model: ReturnType<typeof createTracedModel>;

    constructor() {
        this.model = createTracedModel({
            modelName: 'gpt-4.1-mini',
            temperature: 0.2,
        });
    }

    /**
     * タスクをサブタスクに分解する。
     * 失敗時は null を返し、呼び出し側は従来の FCA パスにフォールバックする。
     */
    async plan(
        goal: string,
        routineManager: RoutineManagerLike,
        context: {
            inventory?: string;
            position?: string;
            strategyPrompt?: string;
            worldModelPrompt?: string;
        },
    ): Promise<SubTaskPlanResult | null> {
        try {
            const systemPrompt = this.buildPlannerPrompt(routineManager, context);
            const modelWithOutput = this.model.withStructuredOutput(SubTaskSchema);

            log.info(`📋 SubTaskPlanner: planning "${goal.slice(0, 50)}..."`, 'cyan');

            const result = await modelWithOutput.invoke([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: goal },
            ]);

            if (!result || !result.subtasks || result.subtasks.length === 0) {
                log.warn('⚠ SubTaskPlanner: empty plan, falling back to FCA');
                return null;
            }

            log.info(
                `✔ SubTaskPlanner: ${result.subtasks.length} subtasks ` +
                `(${result.subtasks.filter(s => s.type === 'routine').length} routines, ` +
                `${result.subtasks.filter(s => s.type === 'fca').length} fca)`,
                'green',
            );

            return {
                strategy: result.strategy,
                subtasks: result.subtasks.map((s, i) => ({
                    ...s,
                    id: s.id || `st_${i + 1}`,
                    toolCategory: (s.toolCategory as ToolCategory) || undefined,
                })),
            };
        } catch (e) {
            log.error('✖ SubTaskPlanner failed, falling back to FCA', e);
            return null;
        }
    }

    private buildPlannerPrompt(
        routineManager: RoutineManagerLike,
        context: {
            inventory?: string;
            position?: string;
            strategyPrompt?: string;
            worldModelPrompt?: string;
        },
    ): string {
        const routines = routineManager.getAll();
        const routineCatalog = routines.map(r => {
            const params = r.params.length > 0
                ? ` params: {${r.params.map(p => `${p.name}: ${p.type}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}`).join(', ')}}`
                : '';
            return `- ${r.name}: ${r.description} (${r.steps.length} steps)${params}`;
        }).join('\n');

        return `あなたは Minecraft 自律エージェント「シャノン」のタスクプランナーです。
ユーザーの指示を、実行可能なサブタスクのリストに分解してください。

## 利用可能なルーチン（LLM 呼出なしで高速実行可能）
${routineCatalog || '（なし）'}

## ルール
1. ルーチンで実行可能なサブタスクは type: "routine" にし、routineName と routineParams を指定する
2. ルーチンがないサブタスクは type: "fca" にし、toolCategory を指定する
3. サブタスクは依存順に並べる（先行タスクの結果が後続に必要な場合）
4. 各サブタスクは独立して実行可能な単位にする
5. ルーチンのパラメータは定義に合わせて正確に指定する
6. toolCategory は以下から選択: mining, crafting, smelting, navigation, combat, farming, building, inventory, observation, utility

## 現在の状態
${context.inventory ? `インベントリ: ${context.inventory}` : ''}
${context.position ? `位置: ${context.position}` : ''}
${context.strategyPrompt ? `戦略メモ:\n${context.strategyPrompt}` : ''}
${context.worldModelPrompt ? `ワールド知識:\n${context.worldModelPrompt}` : ''}`;
    }
}
