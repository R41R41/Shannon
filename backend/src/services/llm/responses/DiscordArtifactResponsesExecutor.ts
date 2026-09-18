import { BaseMessage } from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import type { HierarchicalSubTask, TaskTreeState } from '@shannon/common';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { getEventBus } from '../../eventBus/index.js';
import type { FunctionCallingAgentState } from '../graph/nodes/FunctionCallingAgent.js';
import { TaskTreePublisher } from '../graph/nodes/execution/TaskTreePublisher.js';
import { ToolExecutor } from '../graph/nodes/execution/ToolExecutor.js';
import { PromptBuilder } from '../graph/nodes/prompt/PromptBuilder.js';
import { resolveTaskToolPolicy } from '../graph/policies/taskToolPolicy.js';
import {
  OpenAIResponsesError,
  OpenAIResponsesToolLoop,
  parseFunctionArguments,
  type ResponsesFunctionCall,
  type ResponsesFunctionTool,
  type ResponsesToolOutput,
} from './OpenAIResponsesToolLoop.js';

const ROUTE_MAP_GOAL = /(?:地図|マップ|ルート図|移動ルート.{0,12}(?:分かる|わかる|表示|可視化))/iu;

interface ResponsesTerminal {
  status: 'completed' | 'awaiting_user';
  content: string;
  taskTree: TaskTreeState;
}

export interface DiscordArtifactResponsesResult {
  lastAssistantContent: string;
  taskTree: TaskTreeState;
  recoveryStatus: 'idle' | 'awaiting_user';
  responseId: string;
  turns: number;
}

/**
 * First vertical slice of the shared Shannon orchestration core:
 * Discord travel artifacts executed through OpenAI Responses while reusing
 * Shannon's existing tool policy, progress UI, renderers, and delivery queue.
 */
export class DiscordArtifactResponsesExecutor {
  private readonly taskTreePublisher = new TaskTreePublisher(getEventBus());
  private readonly toolExecutor = new ToolExecutor(this.taskTreePublisher);

  constructor(private readonly allTools: StructuredTool[]) {}

  async run(state: FunctionCallingAgentState): Promise<DiscordArtifactResponsesResult> {
    const goal = state.userMessage?.trim() ?? '';
    const platform = state.context?.platform ?? null;
    const allowed = resolveTaskToolPolicy(goal, platform, state.allowedTools) ?? [];
    const tools = this.allTools.filter((tool) => allowed.includes(tool.name));
    if (!goal || platform !== 'discord' || tools.length === 0) {
      throw new OpenAIResponsesError('Discord artifact Responses executor received an unsupported task');
    }

    this.configureContextualTools(tools, state);
    const promptBuilder = new PromptBuilder();
    const instructions = promptBuilder.buildSystemPrompt(
      state.emotionState,
      state.context,
      state.environmentState,
      state.memoryState,
      state.memoryPrompt,
      state.relationshipPrompt,
      state.selfModelPrompt,
      state.strategyPrompt,
      state.internalStatePrompt,
      state.worldModelPrompt,
      state.classifyMode,
      state.needsTools,
    );
    const responseTools = tools.map((tool) => toResponsesTool(tool));
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const successfulToolNames = new Set<string>();
    const steps: HierarchicalSubTask[] = [];
    const messages: BaseMessage[] = [];
    let stepCounter = 0;
    let routePolyline: string | null = null;

    const model = process.env.SHANNON_RESPONSES_MODEL
      || state.selectedModel
      || 'gpt-5.6-terra';
    const loop = new OpenAIResponsesToolLoop(config.openaiApiKey, model);
    logger.info(`🧭 Discord artifact executor: Responses API model=${model}, tools=${tools.length}`, 'cyan');

    const result = await loop.run<ResponsesTerminal>({
      instructions,
      input: goal,
      tools: responseTools,
      signal: state.abortSignal,
      maxTurns: Number(process.env.SHANNON_RESPONSES_MAX_TURNS ?? 12),
      reasoningEffort: normalizeReasoningEffort(process.env.SHANNON_RESPONSES_REASONING ?? 'low'),
      execute: async (calls) => {
        const parsedCalls = calls.map((call) => ({
          id: call.call_id,
          name: call.name,
          args: parseFunctionArguments(call),
        }));
        const execution = await this.toolExecutor.executeToolCalls(
          parsedCalls,
          toolMap,
          messages,
          {
            goal,
            platform,
            channelId: state.channelId,
            taskId: state.taskId,
            context: state.context,
            steps,
            stepCounter,
            lastThinkingContent: null,
            onToolStarting: state.onToolStarting,
            onTaskTreeUpdate: state.onTaskTreeUpdate,
            routePolyline,
          },
          state.abortSignal,
        );
        stepCounter = execution.stepCounter;
        routePolyline = execution.routePolyline;
        execution.results.forEach((item) => {
          if (item.success) successfulToolNames.add(item.toolName);
        });

        const outputs: ResponsesToolOutput[] = calls.map((call, index) => ({
          callId: call.call_id,
          output: limitToolOutput(execution.results[index]?.message ?? 'Tool result unavailable.'),
        }));

        const clarification = execution.results.find(
          (item) => item.toolName === 'ask-user-on-discord'
            && item.success
            && item.message.startsWith('SHANNON_AWAITING_USER '),
        );
        if (clarification) {
          return {
            outputs,
            terminal: this.publishTerminal(
              'awaiting_user',
              'Discordで追加情報を確認しています。回答後に自動で再開します。',
              goal,
              steps,
              state,
            ),
          };
        }

        const created = execution.results.find(
          (item) => item.toolName === 'create-travel-brief' && item.success,
        );
        if (created) {
          const createdIndex = execution.results.indexOf(created);
          const artifact = JSON.parse(created.message) as { routeMapIncluded?: boolean };
          if (ROUTE_MAP_GOAL.test(goal) && !artifact.routeMapIncluded) {
            successfulToolNames.delete('create-travel-brief');
            outputs[createdIndex].output = 'Completion rejected: a route map was explicitly requested but was not embedded. Run compute-route, then create-travel-brief again.';
          } else {
            const delivery = await this.deliverCreatedArtifact(created.message, goal, toolMap, state, steps);
            stepCounter = steps.length;
            if (delivery) {
              successfulToolNames.add('send-artifact-on-discord');
              return { outputs, terminal: delivery };
            }
            outputs[createdIndex].output += '\nAutomatic Discord delivery did not complete. Call send-artifact-on-discord with this artifactId.';
          }
        }

        const completeIndex = parsedCalls.findIndex((call) => call.name === 'task-complete');
        if (completeIndex >= 0) {
          const missing = ['create-travel-brief', 'send-artifact-on-discord']
            .filter((name) => !successfulToolNames.has(name));
          if (missing.length > 0) {
            outputs[completeIndex].output = `Completion rejected. Required tools have not succeeded: ${missing.join(', ')}.`;
          }
        }
        return { outputs };
      },
    });

    if (!result.terminal) {
      throw new OpenAIResponsesError(
        `Responses executor ended before the PDF was delivered: ${result.outputText || 'no final output'}`,
      );
    }
    return {
      lastAssistantContent: result.terminal.content,
      taskTree: result.terminal.taskTree,
      recoveryStatus: result.terminal.status === 'awaiting_user' ? 'awaiting_user' : 'idle',
      responseId: result.responseId,
      turns: result.turns,
    };
  }

  private configureContextualTools(tools: StructuredTool[], state: FunctionCallingAgentState): void {
    for (const tool of tools) {
      const contextual = tool as StructuredTool & {
        setContext?: (...args: unknown[]) => void;
      };
      if (tool.name === 'ask-user-on-discord') {
        contextual.setContext?.(state.context ?? null, state.taskId);
      } else if (tool.name === 'update-plan') {
        contextual.setContext?.(state.channelId, state.taskId);
      }
    }
  }

  private async deliverCreatedArtifact(
    raw: string,
    goal: string,
    toolMap: Map<string, StructuredTool>,
    state: FunctionCallingAgentState,
    steps: HierarchicalSubTask[],
  ): Promise<ResponsesTerminal | null> {
    const artifact = JSON.parse(raw) as {
      artifactId?: string;
      title?: string;
      routeMapIncluded?: boolean;
    };
    const sendTool = toolMap.get('send-artifact-on-discord');
    const channelId = state.context?.discord?.channelId ?? state.channelId;
    const guildId = state.context?.discord?.guildId;
    if (!sendTool || !artifact.artifactId || !channelId || !guildId) return null;

    const deliveryStep: HierarchicalSubTask = {
      id: `step_${steps.length + 1}`,
      goal: `send-artifact-on-discord(artifactId=${artifact.artifactId})`,
      status: 'in_progress',
    };
    steps.push(deliveryStep);
    this.taskTreePublisher.publishTaskTree({
      status: 'in_progress',
      goal,
      strategy: 'PDFをDiscordへ添付しています。',
      hierarchicalSubTasks: steps,
      currentSubTaskId: deliveryStep.id,
    }, 'discord', state.channelId, state.taskId, state.onTaskTreeUpdate);

    const rawDelivery = await sendTool.invoke({
      artifactId: artifact.artifactId,
      message: `## ✅ 旅行資料が完成しました\n「${artifact.title ?? '旅行計画'}」のプレビューとPDFを添付します。`,
      channelId,
      guildId,
      memoryZone: 'discord:general',
    });
    const delivery = typeof rawDelivery === 'string' ? rawDelivery : JSON.stringify(rawDelivery);
    if (ToolExecutor.parseToolFailureMetadata(delivery).isError) {
      deliveryStep.status = 'error';
      deliveryStep.failureReason = delivery;
      deliveryStep.recoverable = true;
      return null;
    }
    deliveryStep.status = 'completed';
    deliveryStep.result = 'PDFとプレビューをDiscordの送信キューへ登録しました。';
    return this.publishTerminal(
      'completed',
      `## ✅ 完了\n「${artifact.title ?? '旅行計画'}」を作成し、PDFとプレビューをDiscordへ添付しました。`,
      goal,
      steps,
      state,
    );
  }

  private publishTerminal(
    status: ResponsesTerminal['status'],
    content: string,
    goal: string,
    steps: HierarchicalSubTask[],
    state: FunctionCallingAgentState,
  ): ResponsesTerminal {
    const taskTree: TaskTreeState = {
      status: status === 'completed' ? 'completed' : 'in_progress',
      goal,
      strategy: content,
      recoveryStatus: status === 'completed' ? 'idle' : 'awaiting_user',
      hierarchicalSubTasks: steps,
      subTasks: null,
    };
    this.taskTreePublisher.publishTaskTree(
      taskTree,
      'discord',
      state.channelId,
      state.taskId,
      state.onTaskTreeUpdate,
    );
    return { status, content, taskTree };
  }
}

function toResponsesTool(tool: StructuredTool): ResponsesFunctionTool {
  const schema = zodToJsonSchema(tool.schema as never, { target: 'openApi3' }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: schema,
    strict: false,
  };
}

function limitToolOutput(value: string): string {
  const limit = 12_000;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...(${value.length - limit} chars omitted)`;
}

function normalizeReasoningEffort(
  value: string,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' {
  return ['none', 'minimal', 'low', 'medium', 'high'].includes(value)
    ? value as 'none' | 'minimal' | 'low' | 'medium' | 'high'
    : 'low';
}
