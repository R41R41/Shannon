import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * task-complete ツール
 *
 * LLM が明示的にタスク完了を宣言するためのツール。
 * FCA の run ループで、このツールが呼ばれたときのみタスクを完了扱いにする。
 * テキストのみの応答（ツール呼び出しなし）では完了にせず、ループを継続する。
 */
export default class TaskCompleteTool extends StructuredTool {
  name = 'task-complete';
  description =
    'Declare the current task as complete. Call this ONLY when the final goal has been fully achieved ' +
    '(e.g., the requested item is in inventory, the information has been delivered, etc.). ' +
    'Do NOT call this after intermediate steps like starting smelting — wait until the end product is ready. ' +
    'CRITICAL: the summary field IS the message the user will see. Write it as a direct reply to the user with the actual content ' +
    '(data, comparison, answer, etc.). Never write a meta-description like "I told the user X" or "I explained Y".';

  schema = z.object({
    summary: z
      .string()
      .describe(
        'The exact text the user will read — write it as a direct reply. ' +
        'Include the actual content (numbers, facts, formatted data). ' +
        'BAD: "Told the user the weather is cloudy." GOOD: "Tomorrow will be cloudy with 80% rain — bring an umbrella!"',
      ),
  });

  async _call(data: z.infer<typeof this.schema>): Promise<string> {
    return `タスク完了: ${data.summary}`;
  }
}
