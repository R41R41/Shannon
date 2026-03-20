/**
 * MinecraftGoalExecutor — ゴール駆動型 Minecraft 自律エージェント。
 *
 * 「鉄のツルハシを作れ」のような自然言語ゴールを受け取り、
 * ボットの InstantSkill 群をツールとして LLM に公開し、
 * ReAct ループで計画→実行→観測→適応を繰り返してゴールを達成する。
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../../../config/env.js';
import { createLogger } from '../../../../../utils/logger.js';
import type { CustomBot, InstantSkill } from '../../../../minebot/types.js';
import type { Precheck } from './types.js';

const log = createLogger('GoalExecutor');

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;
const DEFAULT_MAX_ITER = 60;

// UI / メタスキルで除外するもの
const EXCLUDED_SKILL_PREFIXES = ['display-'];

// ── 型定義 ──

type Tool = Anthropic.Tool;
type MessageParam = Anthropic.MessageParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

export interface GoalSuccessCriterion {
    type: 'inventory_has' | 'nearby_block' | 'health_above';
    item?: string;
    minCount?: number;
    block?: string;
    maxDistance?: number;
    min?: number;
}

export interface GoalExecutionResult {
    success: boolean;
    goal: string;
    iterations: number;
    skillCalls: Array<{ skill: string; args: Record<string, unknown>; result: string }>;
    finalInventory: string[];
    errorMessage?: string;
    durationMs: number;
}

// ── メインクラス ──

export class MinecraftGoalExecutor {
    private client: Anthropic;

    constructor(private bot: CustomBot) {
        this.client = new Anthropic({ apiKey: config.anthropic.apiKey || undefined });
    }

    async execute(
        goal: string,
        successCriteria: GoalSuccessCriterion[],
        maxIterations = DEFAULT_MAX_ITER,
    ): Promise<GoalExecutionResult> {
        const startTime = Date.now();
        const tools = this.buildTools();
        const system = this.buildSystemPrompt();
        const skillCalls: GoalExecutionResult['skillCalls'] = [];

        const initialObs = this.observe();

        const messages: MessageParam[] = [
            {
                role: 'user',
                content: [
                    `## ゴール\n${goal}`,
                    `## 成功条件\n${successCriteria.map(c => this.describeCriterion(c)).join('\n')}`,
                    `## 現在の状態\n${initialObs}`,
                    'まず計画を立て、1ステップずつ実行してください。',
                ].join('\n\n'),
            },
        ];

        log.info(`🎯 ゴール実行開始: "${goal}" (最大${maxIterations}iter)`);

        let finished = false;
        let goalComplete = false;
        let iterations = 0;

        for (let iter = 0; iter < maxIterations && !finished; iter++) {
            iterations = iter + 1;

            try {
                const response = await this.client.messages.create({
                    model: MODEL,
                    max_tokens: MAX_TOKENS,
                    system,
                    tools,
                    messages,
                    temperature: 0.1,
                });

                messages.push({ role: 'assistant', content: response.content });

                // エージェントの思考をログ
                for (const block of response.content) {
                    if (block.type === 'text' && block.text.trim()) {
                        const preview = block.text.split('\n').slice(0, 4).join('\n');
                        log.info(`💭 [${iter}] ${preview.slice(0, 300)}`);
                    }
                }

                const toolUses = response.content.filter(
                    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
                );

                if (toolUses.length === 0) {
                    // ツール呼び出しなし → 達成判定
                    const check = this.checkCriteria(successCriteria);
                    if (check.allMet) {
                        goalComplete = true;
                        finished = true;
                        log.info(`✅ [${iter}] ゴール達成（ツール終了後の判定）`);
                    } else if (iter > 3) {
                        finished = true;
                        log.warn(`⚠️ [${iter}] エージェントがツールを使わず停止。未達成: ${check.unmet.join(', ')}`);
                    }
                    continue;
                }

                // ツール実行
                const toolResults: ToolResultBlockParam[] = [];

                for (const tu of toolUses) {
                    const input = tu.input as Record<string, unknown>;

                    if (tu.name === 'think') {
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: tu.id,
                            content: 'OK',
                        });
                        continue;
                    }

                    if (tu.name === 'goal_complete') {
                        const check = this.checkCriteria(successCriteria);
                        if (check.allMet) {
                            goalComplete = true;
                            finished = true;
                            log.info(`✅ [${iter}] エージェントがゴール達成を宣言 → 条件充足確認`);
                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: tu.id,
                                content: 'ゴール達成確認済み。お疲れさまでした。',
                            });
                        } else {
                            log.warn(`⚠️ [${iter}] エージェントが達成宣言したが条件未充足: ${check.unmet.join(', ')}`);
                            toolResults.push({
                                type: 'tool_result',
                                tool_use_id: tu.id,
                                content: `まだ達成条件が満たされていません: ${check.unmet.join(', ')}\n続行してください。`,
                            });
                        }
                        continue;
                    }

                    if (tu.name === 'goal_impossible') {
                        finished = true;
                        log.error(`⛔ [${iter}] エージェントがゴール不可能と判断: ${input.reason ?? ''}`);
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: tu.id,
                            content: '了解。ゴール実行を中断します。',
                        });
                        continue;
                    }

                    if (tu.name === 'observe') {
                        const obs = this.observe();
                        log.info(`👁️ [${iter}] observe`);
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: tu.id,
                            content: obs,
                        });
                        continue;
                    }

                    // 通常スキル実行
                    const result = await this.executeSkill(tu.name, input);
                    skillCalls.push({ skill: tu.name, args: input, result: result.slice(0, 500) });
                    log.info(`🎮 [${iter}] ${tu.name}(${this.summarizeArgs(input)}): ${result.slice(0, 200)}`);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tu.id,
                        content: result,
                    });
                }

                messages.push({ role: 'user', content: toolResults });

            } catch (err: any) {
                log.error(`GoalExecutor iter ${iter} エラー: ${err.message}`);
                messages.push({
                    role: 'user',
                    content: `システムエラー: ${err.message}\n続行するか goal_impossible を呼んでください。`,
                });
            }
        }

        if (!finished) {
            const check = this.checkCriteria(successCriteria);
            goalComplete = check.allMet;
            log.warn(`⏱️ 最大イテレーション (${maxIterations}) に到達。達成=${goalComplete}`);
        }

        const inventory = this.bot.inventory.items().map(i => `${i.name} x${i.count}`);
        const result: GoalExecutionResult = {
            success: goalComplete,
            goal,
            iterations,
            skillCalls,
            finalInventory: inventory,
            durationMs: Date.now() - startTime,
        };
        if (!goalComplete) {
            const check = this.checkCriteria(successCriteria);
            result.errorMessage = `未達成: ${check.unmet.join(', ')}`;
        }

        log.info(
            `🎯 ゴール実行完了: ${goalComplete ? '✅達成' : '❌未達成'} ` +
            `(${iterations}iter, ${skillCalls.length}スキル呼出, ${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
        );

        return result;
    }

    // ── ツール定義構築 ──

    private buildTools(): Tool[] {
        const tools: Tool[] = [];

        // 全 InstantSkill をツールとして公開
        const allSkills = (this.bot.instantSkills as any).skills as InstantSkill[];
        for (const skill of allSkills) {
            if (EXCLUDED_SKILL_PREFIXES.some(p => skill.skillName.startsWith(p))) continue;

            const properties: Record<string, object> = {};
            const required: string[] = [];

            for (const param of skill.params ?? []) {
                properties[param.name] = {
                    type: this.paramTypeToJsonSchema(param.type),
                    description: param.description,
                };
                if (param.required) required.push(param.name);
            }

            tools.push({
                name: skill.skillName,
                description: skill.description,
                input_schema: {
                    type: 'object' as const,
                    properties,
                    ...(required.length > 0 ? { required } : {}),
                },
            });
        }

        // 観測ツール
        tools.push({
            name: 'observe',
            description: '現在のボット状態を一括取得する（位置、体力、空腹度、インベントリ、周囲のブロック）',
            input_schema: { type: 'object' as const, properties: {} },
        });

        // 計画用ツール
        tools.push({
            name: 'think',
            description: '行動前に思考・計画を整理する。引数に考えを書く。実際には何も実行されない。',
            input_schema: {
                type: 'object' as const,
                properties: {
                    thought: { type: 'string', description: '思考内容' },
                },
                required: ['thought'],
            },
        });

        // ゴール制御
        tools.push({
            name: 'goal_complete',
            description: 'ゴールを達成したと判断した時に呼ぶ。成功条件が自動的に検証される。',
            input_schema: {
                type: 'object' as const,
                properties: {
                    summary: { type: 'string', description: '達成までの簡潔な要約' },
                },
            },
        });

        tools.push({
            name: 'goal_impossible',
            description: 'ゴール達成が不可能と判断した時に呼ぶ。',
            input_schema: {
                type: 'object' as const,
                properties: {
                    reason: { type: 'string', description: '不可能な理由' },
                },
                required: ['reason'],
            },
        });

        return tools;
    }

    private paramTypeToJsonSchema(type: string): string {
        switch (type) {
            case 'string': return 'string';
            case 'number': return 'number';
            case 'boolean': return 'boolean';
            default: return 'string';
        }
    }

    // ── スキル実行 ──

    private async executeSkill(
        skillName: string,
        namedArgs: Record<string, unknown>,
    ): Promise<string> {
        const skill = this.bot.instantSkills.getSkill(skillName);
        if (!skill) return JSON.stringify({ success: false, result: `スキル未登録: ${skillName}` });

        // namedArgs → positional args（params の定義順で変換）
        const positionalArgs: unknown[] = [];
        for (const param of skill.params ?? []) {
            const val = namedArgs[param.name];
            positionalArgs.push(val !== undefined ? val : (param.default ?? undefined));
        }

        try {
            const result = await skill.run(...positionalArgs as any);
            return JSON.stringify(result);
        } catch (err: any) {
            return JSON.stringify({ success: false, result: `実行エラー: ${err.message}` });
        }
    }

    // ── 観測 ──

    private observe(): string {
        const pos = this.bot.entity.position;
        const health = this.bot.health ?? 20;
        const food = this.bot.food ?? 20;
        const items = this.bot.inventory.items();

        const inventoryStr = items.length === 0
            ? '(空)'
            : items.map(i => `${i.name} x${i.count}`).join(', ');

        const lines = [
            `位置: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`,
            `体力: ${health}/20, 空腹: ${food}/20`,
            `インベントリ: ${inventoryStr}`,
        ];

        // 足元のブロック
        try {
            const below = this.bot.blockAt(pos.offset(0, -1, 0));
            if (below) lines.push(`足元: ${below.name}`);
        } catch { /* ignore */ }

        return lines.join('\n');
    }

    // ── 成功条件チェック ──

    private checkCriteria(criteria: GoalSuccessCriterion[]): { allMet: boolean; unmet: string[] } {
        const unmet: string[] = [];

        for (const c of criteria) {
            switch (c.type) {
                case 'inventory_has': {
                    const items = this.bot.inventory?.items() ?? [];
                    const count = items
                        .filter(i => i.name === c.item)
                        .reduce((sum, i) => sum + i.count, 0);
                    if (count < (c.minCount ?? 1)) {
                        unmet.push(`${c.item} が不足 (必要: ${c.minCount ?? 1}, 所持: ${count})`);
                    }
                    break;
                }
                case 'nearby_block': {
                    try {
                        const blockId = (this.bot as any).registry?.blocksByName?.[c.block!]?.id;
                        if (blockId == null) {
                            unmet.push(`ブロック名不明: ${c.block}`);
                            break;
                        }
                        const found = this.bot.findBlocks({
                            matching: blockId,
                            maxDistance: c.maxDistance ?? 16,
                            count: 1,
                        });
                        if (found.length === 0) {
                            unmet.push(`${c.block} が付近にない`);
                        }
                    } catch {
                        unmet.push(`nearby_block チェック失敗: ${c.block}`);
                    }
                    break;
                }
                case 'health_above': {
                    const health = this.bot.health ?? 20;
                    if (health < (c.min ?? 1)) {
                        unmet.push(`HP不足 (必要: ${c.min}, 現在: ${health})`);
                    }
                    break;
                }
            }
        }

        return { allMet: unmet.length === 0, unmet };
    }

    private describeCriterion(c: GoalSuccessCriterion): string {
        switch (c.type) {
            case 'inventory_has':
                return `- インベントリに ${c.item} を ${c.minCount ?? 1} 個以上持っている`;
            case 'nearby_block':
                return `- 付近に ${c.block} がある`;
            case 'health_above':
                return `- 体力が ${c.min} 以上`;
            default:
                return `- ${JSON.stringify(c)}`;
        }
    }

    // ── システムプロンプト ──

    private buildSystemPrompt(): string {
        return `あなたは Minecraft の自律エージェントです。
与えられたゴールを達成するために、利用可能なスキルを使って行動してください。

## 行動原則

1. 最初に observe で現在の状態を確認する
2. think でゴール達成に必要なステップを計画する
3. 各ステップを順番に実行し、スキルの返り値を確認して次の行動を決める
4. 失敗した場合は原因を分析し、代替手段を試す
5. 全ての成功条件を満たしたら goal_complete を呼ぶ

## Minecraft の知識

- 木（oak_log 等）→ 板材（oak_planks: 1原木→4板材）→ 棒（stick: 2板材→4棒）
- 作業台（crafting_table: 4板材）→ 3x3 レシピが必要なアイテムのクラフトに使う
- 木のツルハシ（wooden_pickaxe: 3板材+2棒、作業台必要）→ 石の採掘が可能に
- 石のツルハシ（stone_pickaxe: 3丸石+2棒、作業台必要）→ 鉄鉱石の採掘が可能に
- かまど（furnace: 8丸石、作業台必要）→ 鉱石の精錬に使う
- 鉄インゴット（iron_ingot）: 鉄鉱石（raw_iron / iron_ore）をかまどで精錬
- 鉄のツルハシ（iron_pickaxe: 3鉄インゴット+2棒、作業台必要）
- 精錬には燃料（oak_planks, coal, charcoal など）が必要。板材も燃料になる
- ブロックの設置は place-block-at を使う。自分の近くの平らな場所に設置すること
- かまどの精錬は start-smelting → wait-time で待つ → check-furnace で確認 → withdraw-from-furnace で取り出す
- レシピが分からなければ check-recipe で確認できる

## スキル使用のコツ

- mine-block: blockName と count を指定。近くのブロックを自動で探して採掘する
- craft-one: itemName を指定。作業台が必要なレシピは近くに作業台を設置してから。count で複数個作れる
- place-block-at: 設置するブロック名と座標を指定。自分の位置から5m以内
- start-smelting: かまどが設置された状態で、材料名(inputItemName)と燃料名(fuelItemName)を指定
- check-furnace: 精錬の進捗を確認。smeltedItem があれば完了
- withdraw-from-furnace: slot を 'output' に指定して精錬結果を取り出す
- move-to: 移動が必要なとき。x, y, z を指定
- observe: 現在のインベントリ・位置・体力を一括確認

## 重要な注意

- スキルが失敗したら返り値をよく読んで原因を特定すること
- 座標を指定する場合、observe で自分の位置を確認してから近くの座標を指定すること
- 1つのスキルが終わるまで次のスキルを呼ばないこと（並列呼び出し禁止）
- 精錬は時間がかかるので wait-time で適切に待つこと（10-15秒程度）`;
    }

    // ── ユーティリティ ──

    private summarizeArgs(args: Record<string, unknown>): string {
        return Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ')
            .slice(0, 100);
    }
}
