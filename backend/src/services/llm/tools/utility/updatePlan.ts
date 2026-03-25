import { StructuredTool } from '@langchain/core/tools';
import { DiscordPlanningInput } from '@shannon/common';
import { z } from 'zod';
import { EventBus } from '../../../eventBus/eventBus.js';
import { getEventBus } from '../../../eventBus/index.js';
import { logger } from '../../../../utils/logger.js';

/**
 * update-plan ツール
 * 
 * LLMが自発的に計画を立てたり更新するためのツール。
 * タスクの目標、戦略、サブタスクを設定し、EventBus経由でUIに通知する。
 * 
 * FunctionCallingAgent のイテレーションループ内で、
 * LLMが「まず計画を立てよう」と判断した時に呼び出す。
 */
export default class UpdatePlanTool extends StructuredTool {
    name = 'update-plan';
    description =
        'Update the current task plan. Call this to set or update the goal, strategy, and subtasks. ' +
        'Use at the start of a complex task to outline your approach, and update as subtasks are completed. ' +
        'For simple tasks (greetings, short answers), you can skip this tool.';

    schema = z.object({
        goal: z.string().describe('The main goal of the task'),
        strategy: z.string().describe('The strategy to achieve the goal (one sentence)'),
        subtasks: z
            .array(
                z.object({
                    id: z.string().describe('Unique subtask ID (e.g. "st_1")'),
                    goal: z.string().describe('What this subtask does (natural language)'),
                    status: z
                        .enum(['pending', 'in_progress', 'completed', 'error'])
                        .describe('Current status of the subtask'),
                    result: z
                        .string()
                        .optional()
                        .describe('Result when completed'),
                    failureReason: z
                        .string()
                        .optional()
                        .describe('Error reason when failed'),
                })
            )
            .optional()
            .describe('Hierarchical subtasks (optional, for complex tasks)'),
    });

    private eventBus: EventBus;

    // 外部から設定されるコンテキスト（channelId等）
    private channelId: string | null = null;
    private taskId: string | null = null;

    constructor() {
        super();
        this.eventBus = getEventBus();
    }

    /**
     * コンテキストを設定（FunctionCallingAgentから呼ばれる）
     */
    public setContext(channelId: string | null, taskId: string | null): void {
        this.channelId = channelId;
        this.taskId = taskId;
    }

    /**
     * 現在の計画状態を取得するためのゲッター
     */
    private _lastPlan: z.infer<typeof this.schema> | null = null;
    public get lastPlan() {
        return this._lastPlan;
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        try {
            this._lastPlan = data;

            const planData = {
                goal: data.goal,
                strategy: data.strategy,
                status: 'in_progress' as const,
                hierarchicalSubTasks: data.subtasks || null,
                subTasks: null,
            };

            // WebUI に通知
            this.eventBus.publish({
                type: 'web:planning',
                memoryZone: 'web',
                data: planData,
                targetMemoryZones: ['web'],
            });

            // Discord に通知（channelIdがある場合）
            if (this.channelId) {
                this.eventBus.publish({
                    type: 'discord:planning',
                    memoryZone: 'web',
                    data: {
                        planning: planData,
                        channelId: this.channelId,
                        taskId: this.taskId || '',
                    } as DiscordPlanningInput,
                });
            }

            const subtaskCount = data.subtasks?.length || 0;
            logger.info(
                `📋 Plan updated: "${data.goal}" (${subtaskCount} subtasks)`,
                'cyan',
            );

            return `計画を更新しました: ${data.goal}`;
        } catch (error) {
            logger.error('update-plan error:', error);
            return `計画の更新に失敗しました: ${error}`;
        }
    }
}
