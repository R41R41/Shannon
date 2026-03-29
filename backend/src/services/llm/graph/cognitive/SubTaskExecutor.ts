/**
 * SubTaskExecutor — プラン済みサブタスクを順次実行する
 *
 * - routine サブタスク → RoutineExecutor 直接呼出 (LLM 0回)
 * - fca サブタスク → FCA.run() with スコープされたツールセット (mini-FCA, max 10回)
 * - 失敗時: routine → fca にフォールバック, 2回以上の fca 失敗 → 全体中断
 * - サブタスク間: インベントリ差分 + 位置 + 1行要約のみ持ち越し
 */

import { HumanMessage } from '@langchain/core/messages';
import { createLogger } from '../../../../utils/logger.js';
import { getToolsForCategory, inferCategory, type ToolCategory } from './ToolCategoryMap.js';
import type { FunctionCallingAgent, FunctionCallingAgentState } from '../nodes/FunctionCallingAgent.js';
import type { SubTaskPlanEntry } from '../nodes/SubTaskPlannerNode.js';
import type { RoutineExecutor as RoutineExecutorType } from '../../../minebot/routines/RoutineExecutor.js';
import type { RoutineManager as RoutineManagerType } from '../../../minebot/routines/RoutineManager.js';
import type { TaskTreeState } from '@shannon/common';

const log = createLogger('LLM:SubTaskExecutor');

const MINI_FCA_MAX_ITERATIONS = 10;
const MAX_FCA_FAILURES = 2;

export interface SubTaskExecutorDeps {
    fca: FunctionCallingAgent;
    routineExecutor: RoutineExecutorType;
    routineManager: RoutineManagerType;
}

export interface SubTaskExecutorResult {
    lastAssistantContent: string | null;
    taskTree: TaskTreeState | null;
    subtasksCompleted: number;
    subtasksTotal: number;
    routineSubtasks: number;
    fcaSubtasks: number;
    aborted: boolean;
}

export class SubTaskExecutor {
    constructor(private deps: SubTaskExecutorDeps) {}

    async execute(
        baseState: FunctionCallingAgentState,
        plan: SubTaskPlanEntry[],
        signal?: AbortSignal,
    ): Promise<SubTaskExecutorResult> {
        const { fca, routineExecutor, routineManager } = this.deps;
        let completed = 0;
        let routineCount = 0;
        let fcaCount = 0;
        let fcaFailures = 0;
        let lastContent: string | null = null;
        const subtaskSummaries: string[] = [];

        log.info(`▶ SubTaskExecutor: ${plan.length} subtasks`, 'cyan');

        const taskTree: TaskTreeState = {
            goal: baseState.userMessage ?? '',
            strategy: plan.map(s => `${s.id}: ${s.goal}`).join(' → '),
            status: 'in_progress',
            hierarchicalSubTasks: plan.map(s => ({
                id: s.id,
                goal: s.goal,
                status: 'pending' as const,
                iterationsSpent: 0,
                result: null,
                failureReason: null,
                children: [],
                createdBy: 'planner',
                createdAt: Date.now(),
            })),
        };

        // UI に初期ツリーを通知
        baseState.onTaskTreeUpdate?.(taskTree);

        for (let i = 0; i < plan.length; i++) {
            if (signal?.aborted) {
                log.warn('⚠ SubTaskExecutor aborted');
                return this.buildResult(lastContent, taskTree, completed, plan.length, routineCount, fcaCount, true);
            }

            const subtask = plan[i];
            const subtaskNode = taskTree.hierarchicalSubTasks?.[i];
            if (subtaskNode) {
                subtaskNode.status = 'in_progress';
                baseState.onTaskTreeUpdate?.(taskTree);
            }

            log.info(`  [${i + 1}/${plan.length}] ${subtask.type}: "${subtask.goal}"`, 'cyan');

            let success = false;
            let result = '';

            if (subtask.type === 'routine' && subtask.routineName) {
                // ─── Routine 実行 (LLM 0回) ───
                const routineDef = routineManager.get(subtask.routineName);
                if (routineDef) {
                    const routineResult = await routineExecutor.execute(
                        routineDef,
                        subtask.routineParams ?? {},
                        { abortSignal: signal },
                    );
                    success = routineResult.success;
                    result = routineResult.summary;
                    routineCount++;

                    if (!success) {
                        log.warn(`  ⚠ Routine "${subtask.routineName}" failed, falling back to FCA`);
                        // フォールバック: FCA で再試行
                        const fcaResult = await this.runMiniFca(
                            fca, baseState, subtask, subtaskSummaries, signal,
                        );
                        success = fcaResult.success;
                        result = fcaResult.content;
                        fcaCount++;
                        if (!success) fcaFailures++;
                    }
                } else {
                    log.warn(`  ⚠ Routine "${subtask.routineName}" not found, using FCA`);
                    const fcaResult = await this.runMiniFca(
                        fca, baseState, subtask, subtaskSummaries, signal,
                    );
                    success = fcaResult.success;
                    result = fcaResult.content;
                    fcaCount++;
                    if (!success) fcaFailures++;
                }
            } else {
                // ─── FCA 実行 (mini-FCA, max 10回) ───
                const fcaResult = await this.runMiniFca(
                    fca, baseState, subtask, subtaskSummaries, signal,
                );
                success = fcaResult.success;
                result = fcaResult.content;
                fcaCount++;
                if (!success) fcaFailures++;
            }

            // サブタスク結果を記録
            if (subtaskNode) {
                subtaskNode.status = success ? 'completed' : 'error';
                subtaskNode.result = result.slice(0, 200);
                if (!success) subtaskNode.failureReason = result.slice(0, 200);
                baseState.onTaskTreeUpdate?.(taskTree);
            }

            if (success) {
                completed++;
                subtaskSummaries.push(`${subtask.goal}: 完了`);
                lastContent = result;
            } else {
                subtaskSummaries.push(`${subtask.goal}: 失敗 - ${result.slice(0, 50)}`);
            }

            // 2回以上の FCA 失敗 → 全体中断
            if (fcaFailures >= MAX_FCA_FAILURES) {
                log.warn(`⚠ SubTaskExecutor: ${fcaFailures} FCA failures, aborting plan`);
                break;
            }
        }

        taskTree.status = completed === plan.length ? 'completed' : 'error';
        baseState.onTaskTreeUpdate?.(taskTree);

        log.info(
            `${completed === plan.length ? '✔' : '⚠'} SubTaskExecutor: ` +
            `${completed}/${plan.length} completed (${routineCount} routines, ${fcaCount} fca)`,
            completed === plan.length ? 'green' : 'yellow',
        );

        return this.buildResult(lastContent, taskTree, completed, plan.length, routineCount, fcaCount, false);
    }

    // ─── Mini-FCA 実行 ───

    private async runMiniFca(
        fca: FunctionCallingAgent,
        baseState: FunctionCallingAgentState,
        subtask: SubTaskPlanEntry,
        previousSummaries: string[],
        signal?: AbortSignal,
    ): Promise<{ success: boolean; content: string }> {
        const category = (subtask.toolCategory as ToolCategory) || inferCategory(subtask.goal);
        const allowedTools = getToolsForCategory(category);

        // 前のサブタスク結果を圧縮してコンテキストに
        const contextSummary = previousSummaries.length > 0
            ? `\n\n前のステップの結果:\n${previousSummaries.slice(-3).join('\n')}`
            : '';

        const miniState: FunctionCallingAgentState = {
            ...baseState,
            userMessage: subtask.goal + contextSummary,
            messages: [], // 新しいコンテキストで開始
            allowedTools,
            maxIterations: MINI_FCA_MAX_ITERATIONS,
            needsPlanning: false,
            // メモリスコーピング: strategy + worldModel のみ
            memoryPrompt: undefined,
            relationshipPrompt: undefined,
            selfModelPrompt: undefined,
            internalStatePrompt: undefined,
            // strategy と worldModel は維持
        };

        try {
            const result = await fca.run(miniState, signal);
            const content = result.lastAssistantContent ?? result.taskTree?.strategy ?? '';
            const success = result.taskTree?.status === 'completed'
                || content.includes('完了')
                || !content.includes('失敗');
            return { success, content };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { success: false, content: msg };
        }
    }

    // ─── ユーティリティ ───

    private buildResult(
        lastContent: string | null,
        taskTree: TaskTreeState,
        completed: number,
        total: number,
        routineCount: number,
        fcaCount: number,
        aborted: boolean,
    ): SubTaskExecutorResult {
        return {
            lastAssistantContent: lastContent,
            taskTree,
            subtasksCompleted: completed,
            subtasksTotal: total,
            routineSubtasks: routineCount,
            fcaSubtasks: fcaCount,
            aborted,
        };
    }
}
