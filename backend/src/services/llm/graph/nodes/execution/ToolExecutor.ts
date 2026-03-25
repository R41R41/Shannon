import {
    BaseMessage,
    ToolMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { TaskContext, HierarchicalSubTask, TaskTreeState } from '@shannon/common';
import { logger } from '../../../../../utils/logger.js';
import { ExecutionResult } from '../../types.js';
import { TaskTreePublisher } from './TaskTreePublisher.js';

export interface ToolExecutionContext {
    goal: string;
    platform: string | null;
    channelId: string | null;
    taskId: string;
    context: TaskContext | null;
    steps: HierarchicalSubTask[];
    stepCounter: number;
    lastThinkingContent: string | null;
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
}

/**
 * ツール実行ループとエラーハンドリング
 */
export class ToolExecutor {
    private taskTreePublisher: TaskTreePublisher;

    constructor(taskTreePublisher: TaskTreePublisher) {
        this.taskTreePublisher = taskTreePublisher;
    }

    /**
     * ツール呼び出し配列を順次実行し、ToolMessage を messages に追加する
     * @returns 更新された stepCounter
     */
    async executeToolCalls(
        toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
        effectiveToolMap: Map<string, StructuredTool>,
        messages: BaseMessage[],
        execCtx: ToolExecutionContext,
        signal?: AbortSignal,
    ): Promise<{ results: ExecutionResult[]; stepCounter: number }> {
        const iterationResults: ExecutionResult[] = [];
        let { stepCounter } = execCtx;

        for (const toolCall of toolCalls) {
            if (signal?.aborted) throw new Error('Task aborted');

            const isUpdatePlan = toolCall.name === 'update-plan';

            if (!isUpdatePlan) {
                stepCounter++;
                const stepId = `step_${stepCounter}`;
                const step: HierarchicalSubTask = {
                    id: stepId,
                    goal: `${toolCall.name}(${ToolExecutor.summarizeArgs(toolCall.args)})`,
                    status: 'in_progress',
                };
                execCtx.steps.push(step);

                this.taskTreePublisher.publishTaskTree({
                    status: 'in_progress',
                    goal: execCtx.goal,
                    strategy: `${toolCall.name} を実行中...`,
                    currentThinking: execCtx.lastThinkingContent,
                    hierarchicalSubTasks: execCtx.steps,
                    currentSubTaskId: stepId,
                }, execCtx.platform, execCtx.channelId, execCtx.taskId, execCtx.onTaskTreeUpdate);
            }

            if (execCtx.onToolStarting) {
                try { execCtx.onToolStarting(toolCall.name, toolCall.args || {}); } catch { /* fire-and-forget */ }
            }

            const tool = effectiveToolMap.get(toolCall.name);
            if (!tool) {
                const result = this.handleMissingTool(toolCall, execCtx, isUpdatePlan);
                iterationResults.push(result.executionResult);
                messages.push(result.toolMessage);
                continue;
            }

            try {
                const execStart = Date.now();
                logger.info(`  ▶ ${toolCall.name}(${JSON.stringify(toolCall.args).substring(0, 200)})`, 'cyan');

                if (execCtx.context?.platform === 'minecraft' || execCtx.context?.platform === 'minebot') {
                    void this.taskTreePublisher.postDetailedLogToMinebotUi(
                        execCtx.goal, 'tool_call', 'info', toolCall.name,
                        `${toolCall.name} を実行中...`,
                        { toolName: toolCall.name, parameters: toolCall.args },
                    );
                }

                const result = await tool.invoke(toolCall.args);
                const duration = Date.now() - execStart;

                const resultStr =
                    typeof result === 'string'
                        ? result
                        : JSON.stringify(result);
                const failureMeta = ToolExecutor.parseToolFailureMetadata(resultStr);
                logger.success(`  ✓ ${toolCall.name} (${duration}ms): ${resultStr.substring(0, 200)}`);

                if (execCtx.context?.platform === 'minecraft' || execCtx.context?.platform === 'minebot') {
                    void this.taskTreePublisher.postDetailedLogToMinebotUi(
                        execCtx.goal, 'tool_result',
                        failureMeta.isError ? 'error' : 'success',
                        toolCall.name,
                        resultStr.substring(0, 300),
                        { toolName: toolCall.name, parameters: toolCall.args, duration, result: resultStr.substring(0, 200) },
                    );
                }

                const isError = failureMeta.isError;

                if (!isUpdatePlan && execCtx.steps.length > 0) {
                    const lastStep = execCtx.steps[execCtx.steps.length - 1];
                    lastStep.status = isError ? 'error' : 'completed';
                    lastStep.result = ToolExecutor.summarizeResultForUI(resultStr);
                    if (isError) lastStep.failureReason = ToolExecutor.summarizeResultForUI(resultStr);
                }

                iterationResults.push({
                    toolName: toolCall.name,
                    args: toolCall.args || {},
                    success: !isError,
                    message: resultStr,
                    duration,
                    failureType: failureMeta.failureType,
                    recoverable: failureMeta.recoverable,
                    error: isError ? resultStr : undefined,
                });

                messages.push(
                    new ToolMessage({
                        content: resultStr,
                        tool_call_id: toolCall.id || `call_${Date.now()}`,
                    }),
                );
            } catch (error) {
                const errorMsg = `${toolCall.name} 実行エラー: ${error instanceof Error ? error.message : 'Unknown'}`;
                logger.error(`  ✗ ${errorMsg}`);

                if (!isUpdatePlan && execCtx.steps.length > 0) {
                    const lastStep = execCtx.steps[execCtx.steps.length - 1];
                    lastStep.status = 'error';
                    lastStep.failureReason = errorMsg;
                }

                iterationResults.push({
                    toolName: toolCall.name,
                    args: toolCall.args || {},
                    success: false,
                    message: errorMsg,
                    duration: 0,
                    failureType: 'unexpected_error',
                    recoverable: false,
                    error: errorMsg,
                });

                messages.push(
                    new ToolMessage({
                        content: errorMsg,
                        tool_call_id: toolCall.id || `call_${Date.now()}`,
                    }),
                );
            }
        }

        return { results: iterationResults, stepCounter };
    }

    // ── Static utility methods ──

    static parseToolFailureMetadata(result: string): {
        isError: boolean;
        failureType?: string;
        recoverable?: boolean;
    } {
        const failureTypeMatch = result.match(/failure_type=([a-z_]+)/i);
        const recoverableMatch = result.match(/recoverable=(true|false)/i);
        const failureType = failureTypeMatch?.[1];
        const recoverable = recoverableMatch
            ? recoverableMatch[1].toLowerCase() === 'true'
            : undefined;
        const isError = Boolean(
            failureType
            || result.includes('失敗')
            || result.includes('エラー')
            || result.includes('error')
            || result.includes('見つかりません')
        );

        return {
            isError,
            failureType,
            recoverable: recoverable ?? (failureType ? failureType !== 'unexpected_error' && failureType !== 'unsafe' : undefined),
        };
    }

    static pickRecoverableFailure(
        results: ExecutionResult[],
        context: TaskContext | null,
    ): ExecutionResult | null {
        if (context?.platform !== 'minecraft' && context?.platform !== 'minebot') {
            return null;
        }
        const failed = [...results]
            .reverse()
            .find((result) => result.success === false && result.recoverable !== false);
        return failed ?? null;
    }

    static requiresMinecraftRecoveryResponse(
        context: TaskContext | null,
        failure: ExecutionResult | null,
        content: string,
    ): boolean {
        if ((context?.platform !== 'minecraft' && context?.platform !== 'minebot') || !failure) {
            return false;
        }
        return !/[?？]/.test(content);
    }

    /**
     * ツール引数を表示用に要約
     */
    static summarizeArgs(args: Record<string, unknown>): string {
        if (!args || Object.keys(args).length === 0) return '';
        const entries = Object.entries(args);
        if (entries.length <= 2) {
            return entries
                .map(([k, v]) => {
                    const val = typeof v === 'string' ? v.substring(0, 50) : v;
                    return `${k}=${val}`;
                })
                .join(', ');
        }
        return (
            entries
                .slice(0, 2)
                .map(([k, v]) => {
                    const val = typeof v === 'string' ? v.substring(0, 50) : v;
                    return `${k}=${val}`;
                })
                .join(', ') + ', ...'
        );
    }

    /**
     * UI表示用にツール実行結果を短縮
     */
    static summarizeResultForUI(resultStr: string): string {
        let s = resultStr;
        s = s.replace(/^結果:\s*(成功|失敗)\s*詳細:\s*/, (_, status) => `${status}: `);
        s = s.replace(/座標\s*\([^)]*\)/g, '');
        s = s.replace(/\(\s*-?\d+,\s*-?\d+,?\s*-?\d*\)/g, '');
        s = s.replace(/距離\s*[\d.]+m/g, '');
        s = s.replace(/\[failure_type=[^\]]*\]/g, '');
        s = s.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
        s = s.replace(/,\s*$/, '');
        if (s.length > 60) s = s.substring(0, 57) + '...';
        return s;
    }

    // ── private helpers ──

    private handleMissingTool(
        toolCall: { id?: string; name: string; args: Record<string, unknown> },
        execCtx: ToolExecutionContext,
        isUpdatePlan: boolean,
    ): { executionResult: ExecutionResult; toolMessage: ToolMessage } {
        const errorMsg = `ツール "${toolCall.name}" が見つかりません`;
        logger.error(`  ✗ ${errorMsg}`);

        if (!isUpdatePlan && execCtx.steps.length > 0) {
            const lastStep = execCtx.steps[execCtx.steps.length - 1];
            lastStep.status = 'error';
            lastStep.failureReason = errorMsg;
        }

        return {
            executionResult: {
                toolName: toolCall.name,
                args: toolCall.args || {},
                success: false,
                message: errorMsg,
                duration: 0,
                error: errorMsg,
            },
            toolMessage: new ToolMessage({
                content: errorMsg,
                tool_call_id: toolCall.id || `call_${Date.now()}`,
            }),
        };
    }
}
