import { BaseMessage, ToolMessage } from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import type { RequestEnvelope, TaskContext, HierarchicalSubTask, TaskTreeState } from '@shannon/common';
import { logger } from '../../../../../utils/logger.js';
import { ExecutionResult } from '../../types.js';
import { TaskTreePublisher } from './TaskTreePublisher.js';

export interface ToolExecutionContext {
    goal: string;
    platform: string | null;
    channelId: string | null;
    taskId: string;
    context: TaskContext | null;
    envelope?: RequestEnvelope;
    signal?: AbortSignal;
    steps: HierarchicalSubTask[];
    stepCounter: number;
    lastThinkingContent: string | null;
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    /** A route calculated in an earlier FCA iteration. */
    routePolyline?: string | null;
}

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
type ToolOutcome = { executionResult: ExecutionResult; toolMessage: ToolMessage };

export function extractEncodedRoutePolyline(rawResult: string): string | null {
    try {
        const parsed = JSON.parse(rawResult) as {
            polyline?: { encodedPolyline?: unknown };
            routes?: Array<{ polyline?: { encodedPolyline?: unknown } }>;
        };
        const value = parsed.polyline?.encodedPolyline
            ?? parsed.routes?.[0]?.polyline?.encodedPolyline;
        return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

export function attachRouteMapToTravelBrief(
    toolCall: ToolCall,
    encodedPolyline: string | null,
): ToolCall {
    if (toolCall.name !== 'create-travel-brief' || !encodedPolyline) return toolCall;
    const current = toolCall.args?.routeMap;
    if (
        current
        && typeof current === 'object'
        && typeof (current as { encodedPolyline?: unknown }).encodedPolyline === 'string'
    ) {
        return toolCall;
    }
    return {
        ...toolCall,
        args: {
            ...toolCall.args,
            routeMap: {
                encodedPolyline,
                caption: 'Google Routes APIで算出した移動ルート',
            },
        },
    };
}

/** Executes tool calls while preserving model call order in the message history. */
export class ToolExecutor {
    private static readonly PARALLEL_SAFE_TOOLS = new Set([
        'google-search', 'fetch-url', 'search-by-wikipedia', 'search-weather',
        'wolframalpha', 'describe-image', 'describe-notion-image',
        'get-discord-recent-messages', 'get-discord-images',
        'get-youtube-video-content-from-url', 'get-notion-page-content-from-url',
        'search-places', 'compute-route',
    ]);
    private static readonly MAX_PARALLEL_TOOLS = Math.max(
        1,
        Math.min(8, Number(process.env.SHANNON_TOOL_CONCURRENCY ?? 4) || 4),
    );

    constructor(private readonly taskTreePublisher: TaskTreePublisher) {}

    /**
     * Consecutive read-only calls may run concurrently. Mutating/unknown tools form
     * barriers and execute sequentially. ToolMessages are appended in call order.
     */
    async executeToolCalls(
        toolCalls: ToolCall[],
        effectiveToolMap: Map<string, StructuredTool>,
        messages: BaseMessage[],
        execCtx: ToolExecutionContext,
        signal?: AbortSignal,
    ): Promise<{ results: ExecutionResult[]; stepCounter: number; routePolyline: string | null }> {
        const results: ExecutionResult[] = [];
        let { stepCounter } = execCtx;
        let routePolyline = execCtx.routePolyline ?? null;
        let cursor = 0;

        while (cursor < toolCalls.length) {
            if (signal?.aborted) throw new Error('Task aborted');
            const isParallelGroup = ToolExecutor.PARALLEL_SAFE_TOOLS.has(toolCalls[cursor].name);
            let groupEnd = cursor + 1;
            if (isParallelGroup) {
                while (groupEnd < toolCalls.length && ToolExecutor.PARALLEL_SAFE_TOOLS.has(toolCalls[groupEnd].name)) {
                    groupEnd++;
                }
            }

            for (let start = cursor; start < groupEnd; start += ToolExecutor.MAX_PARALLEL_TOOLS) {
                const batch = toolCalls
                    .slice(start, Math.min(groupEnd, start + ToolExecutor.MAX_PARALLEL_TOOLS))
                    .map((toolCall) => attachRouteMapToTravelBrief(toolCall, routePolyline));
                const prepared = batch.map((toolCall) => {
                    const isUpdatePlan = toolCall.name === 'update-plan';
                    let step: HierarchicalSubTask | null = null;
                    if (!isUpdatePlan) {
                        stepCounter++;
                        step = {
                            id: `step_${stepCounter}`,
                            goal: `${toolCall.name}(${ToolExecutor.summarizeArgs(toolCall.args)})`,
                            status: 'in_progress',
                        };
                        execCtx.steps.push(step);
                    }
                    try { execCtx.onToolStarting?.(toolCall.name, toolCall.args || {}); } catch { /* UI callback */ }
                    return { toolCall, tool: effectiveToolMap.get(toolCall.name), step };
                });

                const labels = prepared.map(({ toolCall }) => toolCall.name).join('、');
                this.taskTreePublisher.publishTaskTree({
                    status: 'in_progress',
                    goal: execCtx.goal,
                    strategy: prepared.length > 1 ? `${prepared.length}件を並列実行中: ${labels}` : `${labels} を実行中...`,
                    currentThinking: execCtx.lastThinkingContent,
                    hierarchicalSubTasks: execCtx.steps,
                    currentSubTaskId: stepId,
                }, {
                    platform: execCtx.platform,
                    channelId: execCtx.channelId,
                    taskId: execCtx.taskId,
                    envelope: execCtx.envelope,
                    signal: execCtx.signal,
                    onTaskTreeUpdate: execCtx.onTaskTreeUpdate,
                });
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
                        execCtx.envelope,
                    );
                }

                const result = await tool.invoke(toolCall.args, { signal });
                signal?.throwIfAborted();
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
                        execCtx.envelope,
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
                signal?.throwIfAborted();
                const errorMsg = `${toolCall.name} 実行エラー: ${error instanceof Error ? error.message : 'Unknown'}`;
                logger.error(`  ✗ ${errorMsg}`);

                if (!isUpdatePlan && execCtx.steps.length > 0) {
                    const lastStep = execCtx.steps[execCtx.steps.length - 1];
                    lastStep.status = 'error';
                    lastStep.failureReason = errorMsg;
                }
            }
            cursor = groupEnd;
        }

        return { results, stepCounter, routePolyline };
    }

    private async executeOne(
        toolCall: ToolCall,
        tool: StructuredTool | undefined,
        step: HierarchicalSubTask | null,
        execCtx: ToolExecutionContext,
        signal?: AbortSignal,
    ): Promise<ToolOutcome> {
        if (signal?.aborted) throw new Error('Task aborted');
        if (!tool) return this.handleMissingTool(toolCall, step);

        const startedAt = Date.now();
        try {
            logger.info(`  ▶ ${toolCall.name}(${JSON.stringify(toolCall.args).substring(0, 200)})`, 'cyan');
            if (execCtx.context?.platform === 'minecraft' || execCtx.context?.platform === 'minebot') {
                void this.taskTreePublisher.postDetailedLogToMinebotUi(
                    execCtx.goal, 'tool_call', 'info', toolCall.name, `${toolCall.name} を実行中...`,
                    { toolName: toolCall.name, parameters: toolCall.args },
                );
            }
            const result = await tool.invoke(toolCall.args);
            const duration = Date.now() - startedAt;
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const failureMeta = ToolExecutor.parseToolFailureMetadata(resultStr);
            const isError = failureMeta.isError;
            logger.success(`  ✓ ${toolCall.name} (${duration}ms): ${resultStr.substring(0, 200)}`);
            if (execCtx.context?.platform === 'minecraft' || execCtx.context?.platform === 'minebot') {
                void this.taskTreePublisher.postDetailedLogToMinebotUi(
                    execCtx.goal, 'tool_result', isError ? 'error' : 'success', toolCall.name,
                    resultStr.substring(0, 300),
                    { toolName: toolCall.name, parameters: toolCall.args, duration, result: resultStr.substring(0, 200) },
                );
            }
            if (step) {
                step.status = isError ? 'error' : 'completed';
                step.result = ToolExecutor.summarizeResultForUI(resultStr);
                if (isError) {
                    step.failureReason = ToolExecutor.summarizeResultForUI(resultStr);
                    step.recoverable = failureMeta.recoverable;
                }
            }
            return {
                executionResult: {
                    toolName: toolCall.name, args: toolCall.args || {}, success: !isError,
                    message: resultStr, duration, failureType: failureMeta.failureType,
                    recoverable: failureMeta.recoverable, error: isError ? resultStr : undefined,
                },
                toolMessage: new ToolMessage({ content: resultStr, tool_call_id: toolCall.id || `call_${Date.now()}` }),
            };
        } catch (error) {
            const rawMessage = error instanceof Error ? error.message : 'Unknown';
            const invalidArguments = /tool input did not match expected schema|invalid.*argument/i.test(rawMessage);
            const failureType = invalidArguments ? 'invalid_arguments' : 'unexpected_error';
            const recoverable = invalidArguments;
            const errorMsg = `${toolCall.name} 実行エラー: ${rawMessage}`
                + ` [failure_type=${failureType} recoverable=${recoverable}]`;
            logger.error(`  ✗ ${errorMsg}`);
            if (step) {
                step.status = 'error';
                step.failureReason = invalidArguments
                    ? '入力形式を自動調整して再試行します。'
                    : ToolExecutor.summarizeResultForUI(errorMsg);
                step.recoverable = recoverable;
            }
            return {
                executionResult: {
                    toolName: toolCall.name, args: toolCall.args || {}, success: false,
                    message: errorMsg, duration: Date.now() - startedAt,
                    failureType, recoverable, error: errorMsg,
                },
                toolMessage: new ToolMessage({ content: errorMsg, tool_call_id: toolCall.id || `call_${Date.now()}` }),
            };
        }
    }

    static parseToolFailureMetadata(result: string): {
        isError: boolean;
        failureType?: string;
        recoverable?: boolean;
    } {
        const failureTypeMatch = result.match(/failure_type=([a-z_]+)/i);
        const recoverableMatch = result.match(/recoverable=(true|false)/i);
        const failureType = failureTypeMatch?.[1];
        const recoverable = recoverableMatch ? recoverableMatch[1].toLowerCase() === 'true' : undefined;
        const isError = Boolean(
            failureType || result.includes('失敗') || result.includes('エラー')
            || /\b(?:error|failed|failure)\b/i.test(result) || result.includes('見つかりません'),
        );
        return {
            isError,
            failureType,
            recoverable: recoverable ?? (failureType ? failureType !== 'unexpected_error' && failureType !== 'unsafe' : undefined),
        };
    }

    static pickRecoverableFailure(results: ExecutionResult[], context: TaskContext | null): ExecutionResult | null {
        if (context?.platform !== 'minecraft' && context?.platform !== 'minebot') return null;
        return [...results].reverse().find((result) => result.success === false && result.recoverable !== false) ?? null;
    }

    static requiresMinecraftRecoveryResponse(
        context: TaskContext | null,
        failure: ExecutionResult | null,
        content: string,
    ): boolean {
        if ((context?.platform !== 'minecraft' && context?.platform !== 'minebot') || !failure) return false;
        return !/[?？]/.test(content);
    }

    static summarizeArgs(args: Record<string, unknown>): string {
        if (!args || Object.keys(args).length === 0) return '';
        const entries = Object.entries(args);
        const summary = entries.slice(0, 2).map(([key, value]) => {
            const shown = typeof value === 'string' ? value.substring(0, 50) : value;
            return `${key}=${shown}`;
        }).join(', ');
        return entries.length > 2 ? `${summary}, ...` : summary;
    }

    static summarizeResultForUI(resultStr: string): string {
        let summary = resultStr;
        summary = summary.replace(/^結果:\s*(成功|失敗)\s*詳細:\s*/, (_, status) => `${status}: `);
        summary = summary.replace(/座標\s*\([^)]*\)/g, '');
        summary = summary.replace(/\(\s*-?\d+,\s*-?\d+,?\s*-?\d*\)/g, '');
        summary = summary.replace(/距離\s*[\d.]+m/g, '');
        summary = summary.replace(/\[failure_type=[^\]]*\]/g, '');
        summary = summary.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim().replace(/,\s*$/, '');
        return summary.length > 60 ? `${summary.substring(0, 57)}...` : summary;
    }

    private handleMissingTool(toolCall: ToolCall, step: HierarchicalSubTask | null): ToolOutcome {
        const errorMsg = `ツール "${toolCall.name}" が見つかりません`;
        logger.error(`  ✗ ${errorMsg}`);
        if (step) {
            step.status = 'error';
            step.failureReason = errorMsg;
            step.recoverable = false;
        }
        return {
            executionResult: {
                toolName: toolCall.name, args: toolCall.args || {}, success: false,
                message: errorMsg, duration: 0, error: errorMsg,
            },
            toolMessage: new ToolMessage({
                content: errorMsg,
                tool_call_id: toolCall.id || `call_${Date.now()}`,
            }),
        };
    }
}
