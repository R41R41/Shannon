import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { TaskTreeState } from '@shannon/common';
import type { DiscordConversationPort } from '../../../../modules/conversation/discordConversation.js';
import type { WebConversationPort } from '../../../../modules/conversation/webConversation.js';
import { logger } from '../../../../utils/logger.js';

const schema = z.object({
  goal: z.string().describe('The main goal of the task'),
  strategy: z.string().describe('The strategy to achieve the goal (one sentence)'),
  subtasks: z
    .array(
      z.object({
        id: z.string().describe('Unique subtask ID (e.g. "st_1")'),
        goal: z.string().describe('What this subtask does (natural language)'),
        status: z.enum(['pending', 'in_progress', 'completed', 'error']).describe('Current status of the subtask'),
        result: z.string().optional().describe('Result when completed'),
        failureReason: z.string().optional().describe('Error reason when failed'),
      }),
    )
    .optional()
    .describe('Hierarchical subtasks (optional, for complex tasks)'),
});

export default class UpdatePlanTool extends StructuredTool<unknown, z.output<typeof schema>, z.input<typeof schema>, string> {
  createForRun(): UpdatePlanTool { return new UpdatePlanTool(); }

  name = 'update-plan';
  description =
    'Update the current task plan. Call this to set or update the goal, strategy, and subtasks. ' +
    'Use at the start of a complex task to outline your approach, and update as subtasks are completed. ' +
    'For simple tasks (greetings, short answers), you can skip this tool.';
  schema = schema;

  private webPort?: WebConversationPort;
  private discordPort?: DiscordConversationPort;
  private taskId: string | null = null;

  setWebConversationPort(port: WebConversationPort): void { this.webPort = port; }
  setDiscordConversationPort(port: DiscordConversationPort): void { this.discordPort = port; }

  public setContext(_channelId: string | null, taskId: string | null, _platform: string | null = null): void {
    this.taskId = taskId;
  }

  private _lastPlan: z.infer<typeof schema> | null = null;
  public get lastPlan() { return this._lastPlan; }

  async _call(data: z.infer<typeof schema>): Promise<string> {
    try {
      this._lastPlan = data;

      const planData: TaskTreeState = {
        goal: data.goal,
        strategy: data.strategy,
        status: 'in_progress',
        hierarchicalSubTasks: data.subtasks || null,
        subTasks: null,
      };

      await this.webPort?.publishPlanning({ planning: planData, taskId: this.taskId || '' });
      await this.discordPort?.publishPlanning({ planning: planData, taskId: this.taskId || '' });

      logger.info(`📋 Plan updated: "${data.goal}" (${data.subtasks?.length || 0} subtasks)`, 'cyan');
      return `計画を更新しました: ${data.goal}`;
    } catch (error) {
      logger.error('update-plan error:', error);
      return `計画の更新に失敗しました: ${error}`;
    }
  }
}
