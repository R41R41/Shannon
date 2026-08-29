/**
 * SubAgentRoutineExecutor — ルーチンを Haiku サブエージェントで実行
 *
 * RoutineDefinition の instruction (手順書) を独立した Haiku セッションで実行する。
 * メインループ (Sonnet) のコンテキストを汚さず、サブエージェントが自律的に
 * スキルを呼んでタスクを完了する。
 *
 * Claude Code のサブエージェント (Agent tool) と同じパターン。
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TaskTreeState } from '@shannon/common';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
import { skillToAnthropicTool } from '../../llm/graph/ShannonExecutor.js';
import { CONFIG as MINEBOT_CONFIG } from '../config/MinebotConfig.js';
import { canPostMinebotUiFromBot } from '../runtime/minebotUiPost.js';
import type { CustomBot } from '../types/CustomBot.js';
import type { RoutineDefinition, RoutineExecutionResult } from './types.js';

const log = createLogger('Minebot:SubAgent');

const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = process.env.SHANNON_MODEL || 'claude-sonnet-4-20250514';

type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

export class SubAgentRoutineExecutor {
    private client: Anthropic;

    constructor() {
        this.client = new Anthropic({
            apiKey: config.anthropic.apiKey || undefined,
        });
    }

    async execute(
        routine: RoutineDefinition,
        params: Record<string, unknown>,
        options: { abortSignal?: AbortSignal; bot: CustomBot; onTaskTreeUpdate?: (taskTree: TaskTreeState) => void },
    ): Promise<RoutineExecutionResult> {
        const startTime = Date.now();
        const model = routine.model === 'sonnet' ? MODEL_SONNET : MODEL_HAIKU;
        const maxIter = routine.maxIterations ?? 15;

        // 手順書のテンプレート変数を解決（省略された optional パラメータは JSON の default を補完）
        const mergedParams: Record<string, unknown> = { ...params };
        for (const p of routine.params) {
            if (mergedParams[p.name] === undefined && p.default !== undefined) {
                mergedParams[p.name] = p.default;
            }
        }
        let instruction = routine.instruction ?? routine.description;
        for (const [key, value] of Object.entries(mergedParams)) {
            instruction = instruction.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), String(value));
        }

        // ツール定義を構築
        const tools = this.buildTools(routine, options.bot);

        // ボットの現在状態を注入
        const botPos = options.bot.selfState.botPosition;
        const posLine = botPos ? `現在位置: (${Math.floor(botPos.x)}, ${Math.floor(botPos.y)}, ${Math.floor(botPos.z)})` : '';
        const furnaces = options.bot.activeFurnaces?.filter(f => Date.now() - f.startedAt < 600_000) ?? [];
        const furnaceLine = furnaces.length > 0
            ? `精錬中のかまど: ${furnaces.map(f => {
                const secsLeft = Math.max(0, Math.round((f.readyAt - Date.now()) / 1000));
                const st = secsLeft <= 0 ? '完了' : `残り${secsLeft}秒`;
                return `${f.item}x${f.count} @(${f.pos.x},${f.pos.y},${f.pos.z}) ${st}`;
            }).join(', ')}`
            : '';

        const systemPrompt = `あなたは Minecraft ボット「シャノン」のサブエージェントです。
以下の手順に従ってタスクを実行し、完了したら task-complete を呼んでください。
${posLine ? `\n${posLine}` : ''}${furnaceLine ? `\n${furnaceLine}` : ''}

## 手順
${instruction}

## ルール
- ツールの結果をよく見て、状況に応じて柔軟に判断する
- 手順が精錬・クラフト・チェスト取出しに関するときは、着手前に近傍を調べる: find-blocks（chest / barrel / furnace / crafting_table 等）→ 必要な座標へ move-to → check-container または check-furnace。採掘・移動・戦闘のみなら省略してよい
- 精錬を開始したら（start-smelting）、**必ずその場で withdraw-from-furnace で完成品を取り出すまで離れない**
- 同じ失敗を2回繰り返さない。別のアプローチに切り替える
- 完了したら task-complete の summary に**具体的な成果**を書く（入手アイテム数等）
- 失敗して続行不可能な場合も task-complete を呼び、失敗理由を summary に書く`;

        const messages: MessageParam[] = [
            { role: 'user', content: instruction },
        ];

        let lastContent: string | null = null;
        let taskCompleted = false;
        let toolCallCount = 0;

        log.info(`▶ SubAgent "${routine.name}" start (model=${model}, maxIter=${maxIter})`, 'cyan');

        for (let iter = 0; iter < maxIter && !taskCompleted; iter++) {
            if (options.abortSignal?.aborted || options.bot.interruptExecution) {
                log.warn(`⚠ SubAgent "${routine.name}" aborted`);
                break;
            }

            let response: Anthropic.Message;
            try {
                const stream = this.client.messages.stream({
                    model,
                    max_tokens: 4096,
                    system: [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
                    tools: tools.length > 0 ? tools.map((t, i) =>
                        i === tools.length - 1
                            ? { ...t, cache_control: { type: 'ephemeral' as const } }
                            : t
                    ) as any : undefined,
                    messages,
                    temperature: 0.5,
                });
                response = await stream.finalMessage();
            } catch (e) {
                log.error(`❌ SubAgent API error: ${e instanceof Error ? e.message : e}`);
                break;
            }

            const usage = response.usage as any;
            if (usage) {
                const cached = usage.cache_read_input_tokens ?? 0;
                const cacheWrite = usage.cache_creation_input_tokens ?? 0;
                const newInput = usage.input_tokens ?? 0;
                const totalInput = cached + cacheWrite + newInput;
                const cacheRate = totalInput > 0 ? Math.round((cached / totalInput) * 100) : 0;
                const cwPart = cacheWrite > 0 ? `+cw=${cacheWrite}` : '';
                log.info(`  [SubAgent:${routine.name}] 📊 tokens: in=${newInput}${cwPart}+cached=${cached} (${cacheRate}%), out=${usage.output_tokens ?? 0}`, 'cyan');
            }

            const assistantContent = response.content;
            messages.push({ role: 'assistant', content: assistantContent });

            // テキスト
            const textBlocks = assistantContent.filter(b => b.type === 'text');
            if (textBlocks.length > 0) {
                const text = textBlocks.map(b => (b as Anthropic.TextBlock).text).join('');
                log.info(`  [SubAgent:${routine.name}] 💭 ${text.slice(0, 80)}`, 'cyan');
            }

            // ツール呼出
            const toolUseBlocks = assistantContent.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            if (toolUseBlocks.length === 0) continue;

            toolCallCount += toolUseBlocks.length;
            const toolResults: ToolResultBlockParam[] = [];

            for (const toolUse of toolUseBlocks) {
                const toolName = toolUse.name;
                const toolInput = toolUse.input as Record<string, unknown>;

                log.info(`  [SubAgent:${routine.name}] ▶ ${toolName}(${JSON.stringify(toolInput).slice(0, 60)})`, 'cyan');

                let resultText: string;

                try {
                    if (toolName === 'task-complete') {
                        const summary = (toolInput.summary as string) || '';
                        resultText = `タスク完了: ${summary}`;
                        lastContent = summary;
                        taskCompleted = true;
                    } else {
                        // InstantSkill を直接呼出
                        const skill = options.bot.instantSkills?.getSkill(toolName);
                        if (skill) {
                            const args = skill.params.map((p: any) => {
                                const val = toolInput[p.name];
                                if (val === undefined) return p.default;
                                if (p.type === 'number') return Number(val);
                                if (p.type === 'boolean') return val === true || val === 'true';
                                return val;
                            });
                            const skillResult = await skill.run(...args);
                            resultText = `結果: ${skillResult.success ? '成功' : '失敗'} 詳細: ${skillResult.result}`;
                            if (skillResult.failureType) {
                                resultText += ` [failure_type=${skillResult.failureType}]`;
                            }
                        } else {
                            resultText = `不明なスキル: ${toolName}`;
                        }
                    }
                } catch (e) {
                    resultText = `エラー: ${e instanceof Error ? e.message : String(e)}`;
                }

                const truncated = resultText.length > 120 ? resultText.slice(0, 120) + '...' : resultText;
                log.info(`  [SubAgent:${routine.name}] ✓ ${toolName}: ${truncated}`,
                    resultText.includes('失敗') ? 'yellow' : 'green');

                const MAX_TOOL_RESULT_CHARS = 2000;
                const trimmedResult = resultText.length > MAX_TOOL_RESULT_CHARS
                    ? resultText.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(${resultText.length - MAX_TOOL_RESULT_CHARS}文字省略)`
                    : resultText;

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: trimmedResult,
                });
            }

            messages.push({ role: 'user', content: toolResults });

            // タスクツリーをUIに送信
            if (!taskCompleted && options.onTaskTreeUpdate) {
                const subTaskTree: TaskTreeState = {
                    goal: `[SubAgent] ${routine.name}: ${instruction.slice(0, 60)}`,
                    strategy: `サブエージェント実行中 (${iter + 1}/${maxIter}, ${toolCallCount} tools)`,
                    status: 'in_progress',
                    hierarchicalSubTasks: [],
                } as TaskTreeState;
                options.onTaskTreeUpdate(subTaskTree);
                this.postTaskTreeToUiMod(subTaskTree, options.bot);
            }
        }

        const durationMs = Date.now() - startTime;

        log.info(
            `${taskCompleted ? '✔' : '⚠'} SubAgent "${routine.name}": ` +
            `${taskCompleted ? '完了' : '未完了'} (${durationMs}ms, ${toolCallCount} tools)`,
            taskCompleted ? 'green' : 'yellow',
        );

        return {
            success: taskCompleted,
            summary: lastContent ?? `SubAgent "${routine.name}" ${taskCompleted ? '完了' : '未完了 (max iterations)'}`,
            stepsCompleted: toolCallCount,
            stepsTotal: toolCallCount,
            durationMs,
            stepResults: [],
        };
    }

    private postTaskTreeToUiMod(taskTree: TaskTreeState, bot: CustomBot): void {
        if (!canPostMinebotUiFromBot(bot)) return;
        const url = `${MINEBOT_CONFIG.UI_MOD_BASE_URL}/task`;
        try {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(taskTree),
            }).catch(() => { });
        } catch { /* ignore */ }
    }

    private buildTools(routine: RoutineDefinition, bot: CustomBot): Tool[] {
        const tools: Tool[] = [];

        // task-complete は必ず含む
        tools.push({
            name: 'task-complete',
            description: 'タスク完了。summary に具体的な成果を書く。',
            input_schema: {
                type: 'object' as const,
                properties: { summary: { type: 'string', description: '成果の要約' } },
                required: ['summary'],
            },
        });

        // routine.tools で指定されたスキルのみ
        const allowedTools = routine.tools ? new Set(routine.tools) : null;

        if (bot.instantSkills) {
            for (const skill of bot.instantSkills.getSkills()) {
                if (allowedTools && !allowedTools.has(skill.skillName)) continue;
                tools.push(skillToAnthropicTool(skill));
            }
        }

        return tools;
    }
}
