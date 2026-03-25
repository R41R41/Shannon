import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { PromptType } from '@shannon/common';
import { models } from '../../../config/models.js';
import { loadPrompt } from '../config/prompts.js';
import { createTracedModel } from '../utils/langfuse.js';
import { MemoryNode } from '../graph/nodes/MemoryNode.js';
import { logger } from '../../../utils/logger.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ReviewResult {
  approved: boolean;
  issues: string[];
  viewer_perception: string;
  suggestion: string;
}

export interface ToolLoopOptions {
  /** Maximum number of iterations (LLM calls) before giving up. Default: 10 */
  maxIterations?: number;
  /** Maximum number of non-submit tool calls. Default: 8 */
  maxToolCalls?: number;
  /** The tool name(s) that signal completion and whose output is returned.
   *  When the LLM calls one of these, the loop stops and returns the raw
   *  JSON string from the tool. */
  submitToolNames?: string[];
  /** Label used in log messages (e.g. "[AboutToday]"). Default: "[Agent]" */
  logLabel?: string;
  /** Maximum length of tool result content pushed into the message list.
   *  Default: 6000 */
  maxResultLength?: number;
  /** If true, when the LLM produces a plain text response (no tool calls),
   *  return it as-is. Otherwise return null. Default: true */
  returnPlainText?: boolean;
}

export interface ReviewOptions {
  /** Model to use for review. Default: models.autoTweet */
  modelName?: string;
  /** Log label. Default: "[Agent]" */
  logLabel?: string;
}

// ---------------------------------------------------------------------------
// BaseAgent
// ---------------------------------------------------------------------------

export abstract class BaseAgent {
  protected systemPrompt: string;
  protected tools: StructuredTool[];
  protected toolMap: Map<string, StructuredTool>;
  protected memoryNode: MemoryNode | null = null;

  protected constructor(systemPrompt: string, tools: StructuredTool[] = []) {
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
  }

  // =========================================================================
  // Static helpers
  // =========================================================================

  /**
   * Load a prompt by name (thin wrapper around `loadPrompt` with a mandatory
   * existence check). Throws if the prompt file is missing / empty.
   */
  static async loadPrompt(name: PromptType): Promise<string> {
    const text = await loadPrompt(name);
    if (!text) throw new Error(`Failed to load prompt: ${name}`);
    return text;
  }

  // =========================================================================
  // Tool loop  (Function-Calling Agent pattern)
  // =========================================================================

  /**
   * Run the standard FCA (Function-Calling Agent) loop:
   *   1. Invoke the model with tools bound
   *   2. If the model calls a submit tool, return its output
   *   3. Otherwise execute the requested tools and feed results back
   *   4. Repeat until maxIterations
   *
   * Returns the raw string output of the submit tool, or the plain text
   * response, or null if the loop ends without either.
   */
  protected async runToolLoop(
    messages: BaseMessage[],
    toolsToUse: StructuredTool[],
    model: ChatOpenAI,
    opts: ToolLoopOptions = {},
  ): Promise<string | null> {
    const {
      maxIterations = 10,
      maxToolCalls = 8,
      submitToolNames = [],
      logLabel = '[Agent]',
      maxResultLength = 6000,
      returnPlainText = true,
    } = opts;

    const localToolMap = new Map(toolsToUse.map((t) => [t.name, t]));
    const modelWithTools = model.bindTools(toolsToUse);
    const submitSet = new Set(submitToolNames);

    let toolCallCount = 0;

    for (let i = 0; i < maxIterations; i++) {
      let response: AIMessage;
      try {
        response = (await modelWithTools.invoke(messages)) as AIMessage;
      } catch (e: unknown) {
        logger.error(`${logLabel} LLM呼び出しエラー: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      messages.push(response);

      const toolCalls = response.tool_calls || [];

      // No tool calls -> return plain text or null
      if (toolCalls.length === 0) {
        if (!returnPlainText) return null;
        const text =
          typeof response.content === 'string'
            ? response.content.trim()
            : '';
        return text || null;
      }

      for (const tc of toolCalls) {
        // --- Submit tool ---
        if (submitSet.has(tc.name)) {
          const tool = localToolMap.get(tc.name);
          if (!tool) return null;
          try {
            const result = await tool.invoke(tc.args);
            return typeof result === 'string' ? result : JSON.stringify(result);
          } catch {
            return null;
          }
        }

        // --- Rate-limit ---
        if (toolCallCount >= maxToolCalls) {
          const hint = submitToolNames.length > 0
            ? `ツール呼び出し上限に達しました。${submitToolNames[0]} で結果を提出してください。`
            : 'ツール呼び出し上限に達しました。最終回答をテキストで返してください。';
          messages.push(
            new ToolMessage({
              content: hint,
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
          continue;
        }

        // --- Unknown tool ---
        const tool = localToolMap.get(tc.name);
        if (!tool) {
          messages.push(
            new ToolMessage({
              content: `ツール "${tc.name}" は存在しません`,
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
          continue;
        }

        // --- Execute tool ---
        try {
          logger.debug(
            `${logLabel} Tool: ${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`,
          );
          const result = await tool.invoke(tc.args);
          const resultStr =
            typeof result === 'string' ? result : JSON.stringify(result);
          messages.push(
            new ToolMessage({
              content: resultStr.slice(0, maxResultLength),
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
          toolCallCount++;
        } catch (e: unknown) {
          messages.push(
            new ToolMessage({
              content: `ツール実行エラー: ${e instanceof Error ? e.message : String(e)}`,
              tool_call_id: tc.id || `call_${Date.now()}`,
            }),
          );
        }
      }
    }

    logger.warn(`${logLabel} イテレーション上限到達`);
    return null;
  }

  // =========================================================================
  // Review helper
  // =========================================================================

  /**
   * Run a review pass: send the draft to a review model with a review prompt,
   * parse the JSON result, and return a ReviewResult.
   *
   * On any error the default is to approve (fail-open).
   */
  protected async review(
    draft: string,
    reviewPrompt: string,
    humanPrefix: string,
    opts: ReviewOptions = {},
  ): Promise<ReviewResult> {
    const {
      modelName = models.autoTweet,
      logLabel = '[Agent]',
    } = opts;

    const model = createTracedModel({ modelName, temperature: 0 });

    const messages = [
      new SystemMessage(reviewPrompt),
      new HumanMessage(
        `${humanPrefix}\n\n${draft}`,
      ),
    ];

    try {
      const response = await model.invoke(messages);
      const text =
        typeof response.content === 'string' ? response.content.trim() : '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`${logLabel} レビューJSON解析失敗: ${text.slice(0, 200)}`);
        return { approved: true, issues: [], viewer_perception: '', suggestion: '' };
      }

      const parsed = JSON.parse(jsonMatch[0]) as ReviewResult;
      return {
        approved: parsed.approved ?? true,
        issues: parsed.issues ?? [],
        viewer_perception: parsed.viewer_perception ?? '',
        suggestion: parsed.suggestion ?? '',
      };
    } catch (e: unknown) {
      logger.error(`${logLabel} レビューエラー: ${e instanceof Error ? e.message : String(e)}`);
      return { approved: true, issues: [], viewer_perception: '', suggestion: '' };
    }
  }
}
