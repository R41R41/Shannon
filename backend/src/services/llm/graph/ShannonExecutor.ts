/**
 * ShannonExecutor — Anthropic API 直接呼出による実行エンジン
 *
 * FCA (FunctionCallingAgent, 1200行) を置き換える ~200行の実装。
 * LangChain を使わず @anthropic-ai/sdk を直接使用。
 *
 * Claude Code と同じアーキテクチャ:
 *   System prompt + tools → Claude Opus → tool_use → execute → tool_result → loop
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG as MINEBOT_CONFIG } from '../../minebot/config/MinebotConfig.js';
import type { TaskContext, TaskTreeState } from '@shannon/common';
import type { InstantSkills } from '../../minebot/types/collections.js';
import type { RoutineManager } from '../../minebot/routines/RoutineManager.js';
import type { RoutineExecutor } from '../../minebot/routines/RoutineExecutor.js';

const log = createLogger('LLM:ShannonExecutor');

type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

// ─── 型定義 ───

export interface ShannonExecutorDeps {
    instantSkills?: InstantSkills;
    routineManager?: RoutineManager;
    routineExecutor?: RoutineExecutor;
    /** LLM ツール (recall-*, save-*, task-complete, etc.) */
    llmTools?: Map<string, (input: Record<string, unknown>) => Promise<string>>;
}

export interface ShannonExecutorState {
    goal: string;
    context: TaskContext | null;
    systemPrompt: string;
    tools: Tool[];
    /** Minecraft: スキル実行中フラグ管理用 */
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    abortSignal?: AbortSignal;
    /** タスク実行中のユーザーフィードバックを取得するコールバック */
    getHumanFeedback?: () => string | null;
}

export interface ShannonExecutorResult {
    lastContent: string | null;
    taskTree: TaskTreeState | null;
    iterations: number;
    toolCallCount: number;
    durationMs: number;
    thinkingLog: string[];
}

// ─── 定数 ───

const MODEL_SONNET = process.env.SHANNON_MODEL || 'claude-sonnet-4-20250514';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 16384;
const MAX_ITERATIONS = 25;
const MAX_CONSECUTIVE_TEXT = 3;

/** 軽量タスク判定: Haiku で十分なタスクか */
function isLightweightTask(goal: string): boolean {
    const g = goal.toLowerCase();
    // 挨拶・雑談・質問系
    if (g.length < 30 && /こんにち|おはよ|こんばん|やあ|ねえ|hello|hi\b/.test(g)) return true;
    if (/何してる|元気|調子|天気|時間/.test(g)) return true;
    return false;
}

// ─── メイン ───

export class ShannonExecutor {
    private client: Anthropic;

    /** 直前のタスクの結果サマリ（次のタスクにコンテキストとして引き継ぐ） */
    private static lastTaskSummary: string | null = null;
    private static lastTaskGoal: string | null = null;

    constructor(private deps: ShannonExecutorDeps) {
        this.client = new Anthropic({
            apiKey: config.anthropic.apiKey || undefined,
        });
    }

    async run(state: ShannonExecutorState): Promise<ShannonExecutorResult> {
        const startTime = Date.now();
        const messages: MessageParam[] = [];

        // 前タスクのコンテキストを引き継ぐ
        if (ShannonExecutor.lastTaskSummary && ShannonExecutor.lastTaskGoal) {
            messages.push({
                role: 'user',
                content: `【前のタスクの結果】\nゴール: ${ShannonExecutor.lastTaskGoal}\n結果: ${ShannonExecutor.lastTaskSummary}\n\n---\n以下が新しいタスクです:`,
            });
            messages.push({ role: 'assistant', content: 'はい、前のタスクの結果を踏まえて新しいタスクに取り組みます。' });
        }

        messages.push({ role: 'user', content: state.goal });

        let lastContent: string | null = null;
        let taskCompleted = false;
        let taskTree: TaskTreeState | null = null;
        let consecutiveTextOnly = 0;
        let totalToolCalls = 0;
        const thinkingLog: string[] = [];
        const stepHistory: Array<{ id: string; goal: string; status: string; result: string | null }> = [];

        // 軽量タスクは Haiku、それ以外は Sonnet
        const model = isLightweightTask(state.goal) ? MODEL_HAIKU : MODEL_SONNET;
        log.info(`▶ ShannonExecutor: "${state.goal.slice(0, 60)}..." (model=${model}, taskTreeCb=${!!state.onTaskTreeUpdate})`, 'cyan');

        for (let iter = 0; iter < MAX_ITERATIONS && !taskCompleted; iter++) {
            if (state.abortSignal?.aborted) {
                log.warn('⚠ ShannonExecutor aborted');
                break;
            }

            // ユーザーからのリアルタイムフィードバックをチェック
            const feedback = state.getHumanFeedback?.();
            if (feedback) {
                log.info(`💬 ユーザーフィードバック受信: "${feedback.slice(0, 60)}"`, 'cyan');
                messages.push({
                    role: 'user',
                    content: `【ユーザーからのリアルタイムフィードバック】${feedback}\nこのフィードバックを考慮して、現在のタスクを続行してください。`,
                });
            }

            const llmStart = Date.now();

            let response: Anthropic.Message;
            try {
                // Prompt caching: system prompt + tools を cache_control でキャッシュ
                // 2回目以降のイテレーションで入力コスト90%削減
                const cachedTools = state.tools.map((t, i) =>
                    i === state.tools.length - 1
                        ? { ...t, cache_control: { type: 'ephemeral' as const } }
                        : t,
                );

                const stream = this.client.messages.stream({
                    model,
                    max_tokens: MAX_TOKENS,
                    system: [
                        { type: 'text' as const, text: state.systemPrompt, cache_control: { type: 'ephemeral' as const } },
                    ],
                    tools: cachedTools as any,
                    messages,
                    temperature: 1,
                });
                response = await stream.finalMessage();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.error(`❌ API error: ${msg}`, e);
                break;
            }

            const llmMs = Date.now() - llmStart;

            // usage ログ（キャッシュ効果を確認）
            const usage = response.usage as any;
            if (usage) {
                const cached = usage.cache_read_input_tokens ?? 0;
                const total = usage.input_tokens ?? 0;
                const cacheRate = total > 0 ? Math.round((cached / total) * 100) : 0;
                log.info(`  📊 tokens: in=${total} (cached=${cached}, ${cacheRate}%), out=${usage.output_tokens ?? 0}`, 'cyan');
            }

            // アシスタント応答を記録
            const assistantContent = response.content;
            messages.push({ role: 'assistant', content: assistantContent });

            // thinking ブロックを収集
            for (const block of assistantContent) {
                if (block.type === 'thinking') {
                    thinkingLog.push((block as any).thinking);
                }
            }

            // テキストブロックを収集
            const textBlocks = assistantContent.filter(b => b.type === 'text');
            const textContent = textBlocks.map(b => (b as Anthropic.TextBlock).text).join('\n');
            if (textContent) {
                lastContent = textContent;
                log.info(`💭 思考: ${textContent.slice(0, 100)}...`);
            }

            // ツール呼出しブロックを収集
            const toolUseBlocks = assistantContent.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            log.info(`⏱ LLM応答: ${llmMs}ms (iteration ${iter + 1}, tools: ${toolUseBlocks.length})`, 'cyan');

            if (toolUseBlocks.length === 0) {
                consecutiveTextOnly++;
                if (consecutiveTextOnly >= MAX_CONSECUTIVE_TEXT) {
                    log.warn(`⚠ テキストのみ ${MAX_CONSECUTIVE_TEXT}回連続 → 終了`);
                    break;
                }
                // ツール呼出しを促す
                messages.push({
                    role: 'user',
                    content: 'ツール呼び出しがありません。task-complete で完了するか、次のツールを呼んでください。',
                });
                continue;
            }

            consecutiveTextOnly = 0;
            totalToolCalls += toolUseBlocks.length;

            // ── ツール実行 ──
            const toolResults: ToolResultBlockParam[] = [];

            for (const toolUse of toolUseBlocks) {
                const toolName = toolUse.name;
                const toolInput = toolUse.input as Record<string, unknown>;

                state.onToolStarting?.(toolName, toolInput);
                log.info(`  ▶ ${toolName}(${JSON.stringify(toolInput).slice(0, 80)})`, 'cyan');

                let resultText: string;

                try {
                    // task-complete 特殊処理
                    if (toolName === 'task-complete') {
                        const summary = (toolInput.summary as string) || '';
                        resultText = `タスク完了: ${summary}`;
                        lastContent = summary;
                        taskCompleted = true;
                        // 次タスクへのコンテキスト引継ぎ用に保存
                        ShannonExecutor.lastTaskGoal = state.goal;
                        ShannonExecutor.lastTaskSummary = summary.slice(0, 500);
                        taskTree = {
                            goal: state.goal,
                            strategy: summary,
                            status: 'completed',
                            hierarchicalSubTasks: [],
                        } as TaskTreeState;
                        state.onTaskTreeUpdate?.(taskTree);
                        this.postTaskTreeToUiMod(taskTree);
                    }
                    // ルーチン (API名: routine-xxx, 内部名: routine:xxx)
                    else if (toolName.startsWith('routine-') && this.deps.routineManager && this.deps.routineExecutor) {
                        const routineName = toolName.replace('routine-', '');
                        const def = this.deps.routineManager.get(routineName);
                        if (def) {
                            const result = await this.deps.routineExecutor.execute(def, toolInput, {
                                abortSignal: state.abortSignal,
                            });
                            resultText = result.summary;
                            this.deps.routineManager.updateStats(routineName, result.success, result.durationMs).catch(() => {});
                        } else {
                            resultText = `ルーチン "${routineName}" が見つかりません`;
                        }
                    }
                    // InstantSkill
                    else if (this.deps.instantSkills?.getSkill(toolName)) {
                        const skill = this.deps.instantSkills.getSkill(toolName)!;
                        const args = skill.params.map(p => {
                            const val = toolInput[p.name];
                            if (val === undefined) return p.default;
                            if (p.type === 'number') return Number(val);
                            if (p.type === 'boolean') return val === true || val === 'true';
                            return val;
                        });
                        const skillResult = await skill.run(...args);
                        const status = skillResult.success ? '成功' : '失敗';
                        resultText = `結果: ${status} 詳細: ${skillResult.result}`;
                        if (skillResult.failureType) {
                            resultText += ` [failure_type=${skillResult.failureType} recoverable=${skillResult.recoverable ?? true}]`;
                        }
                    }
                    // LLM ツール (recall-*, save-*, manage-routine, etc.)
                    else if (this.deps.llmTools?.has(toolName)) {
                        resultText = await this.deps.llmTools.get(toolName)!(toolInput);
                    }
                    // 不明なツール
                    else {
                        resultText = `不明なツール: ${toolName}`;
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    resultText = `エラー: ${msg}`;
                }

                const truncated = resultText.length > 150
                    ? resultText.slice(0, 150) + '...'
                    : resultText;
                log.info(`  ✓ ${toolName}: ${truncated}`, resultText.includes('失敗') ? 'yellow' : 'green');

                // ステップ履歴に追加
                stepHistory.push({
                    id: `step_${stepHistory.length + 1}`,
                    goal: `${toolName}(${JSON.stringify(toolInput).slice(0, 50)})`,
                    status: resultText.includes('失敗') || resultText.includes('エラー') ? 'error' : 'completed',
                    result: resultText.slice(0, 200),
                });

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: resultText,
                });
            }

            // ツール結果をバッチで追加
            messages.push({ role: 'user', content: toolResults });

            // タスクツリー更新 (毎イテレーション UI Mod に送信)
            if (!taskCompleted) {
                const thinking = textContent ? textContent.slice(0, 100) : undefined;
                taskTree = {
                    goal: state.goal,
                    strategy: thinking || `実行中... (${iter + 1}/${MAX_ITERATIONS})`,
                    status: 'in_progress',
                    currentThinking: thinking,
                    hierarchicalSubTasks: stepHistory.map(s => ({
                        id: s.id,
                        goal: s.goal,
                        status: s.status as any,
                        iterationsSpent: 1,
                        result: s.result,
                        failureReason: s.status === 'error' ? s.result : null,
                        children: [],
                        createdBy: 'shannon-executor',
                        createdAt: Date.now(),
                    })),
                } as TaskTreeState;
                state.onTaskTreeUpdate?.(taskTree);
                this.postTaskTreeToUiMod(taskTree);
            }
        }

        const durationMs = Date.now() - startTime;

        if (!taskCompleted) {
            if (state.abortSignal?.aborted) {
                // 緊急割込みで中断 — 次タスクで復帰できるようにコンテキスト保存
                const progress = stepHistory.slice(-3).map(s => `${s.goal}: ${s.status}`).join(', ');
                ShannonExecutor.lastTaskGoal = state.goal;
                ShannonExecutor.lastTaskSummary = `【中断】緊急割込みにより中断。進捗: ${progress}。このタスクの続きを実行する必要がある`;
                log.info(`💾 中断タスク保存: "${state.goal.slice(0, 40)}..." → 次タスクで復帰可能`);
            } else {
                log.warn(`⚠ MAX_ITERATIONS (${MAX_ITERATIONS}) に到達`);
            }
            taskTree = {
                goal: state.goal,
                strategy: state.abortSignal?.aborted ? '緊急割込みにより中断' : '最大イテレーション数に到達',
                status: 'error',
                hierarchicalSubTasks: [],
            } as TaskTreeState;
        }

        log.info(
            `${taskCompleted ? '✔' : '⚠'} ShannonExecutor: ` +
            `${taskCompleted ? '完了' : '未完了'} ` +
            `(${durationMs}ms, ${totalToolCalls} tools)`,
            taskCompleted ? 'green' : 'yellow',
        );

        return {
            lastContent,
            taskTree,
            iterations: MAX_ITERATIONS,
            toolCallCount: totalToolCalls,
            durationMs,
            thinkingLog,
        };
    }

    /** UI Mod の /task エンドポイントにタスクツリーを直接送信 */
    private postTaskTreeToUiMod(taskTree: TaskTreeState): void {
        try {
            fetch(`${MINEBOT_CONFIG.UI_MOD_BASE_URL}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(taskTree),
            }).catch(() => {});
        } catch {}
    }
}

// ─── ユーティリティ: スキルをAnthropicツール定義に変換 ───

export function skillToAnthropicTool(skill: { skillName: string; description: string; params: Array<{ name: string; type: string; description: string; required?: boolean; default?: unknown }> }): Tool {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const p of skill.params) {
        properties[p.name] = {
            type: p.type === 'Vec3' ? 'object' : p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
            description: p.description || p.name,
        };
        if (p.required) required.push(p.name);
    }

    return {
        name: skill.skillName,
        description: skill.description,
        input_schema: {
            type: 'object' as const,
            properties,
            required: required.length > 0 ? required : undefined,
        },
    };
}

/** routine:name の ':' を Anthropic 互換の '-' に変換 */
export function sanitizeToolName(name: string): string {
    return name.replace(/:/g, '-');
}

export function routineToAnthropicTool(name: string, def: { description: string; params: Array<{ name: string; type: string; description: string; required?: boolean; default?: unknown }> }): Tool {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const p of def.params) {
        properties[p.name] = {
            type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
            description: p.description || p.name,
        };
        if (p.required) required.push(p.name);
    }

    return {
        name: `routine-${name}`,
        description: `[Routine] ${def.description}. LLM呼出なしで高速実行。`,
        input_schema: {
            type: 'object' as const,
            properties,
            required: required.length > 0 ? required : undefined,
        },
    };
}
