import { bindRequestMemory, snapshotMemoryEnvelope } from '../../memory/requestMemory.js';
import { bindRequestDiscordConversation } from '../../common/discordConversationPort.js';
import { bindRequestWebConversation } from '../../common/webConversationPort.js';
import { selectToolsForChannel } from '../../../modules/access/toolCatalog.js';
import { minecraftTaskContinuation } from '../../minebot/runtime/minecraftTaskContinuation.js';
/**
 * Shannon Unified Graph — 3ノード簡素化版
 *
 * Flow: ingest → execute(ShannonExecutor) → writeback
 * Emergency: ingest → emergency_fastpath → execute → writeback
 *
 * Execute: ShannonExecutor (Anthropic API 直接) が主パス。
 * FCA はフォールバック。
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('LLM:ShannonGraph');
import { BaseMessage } from '@langchain/core/messages';
import type {
  MinecraftInventoryEntry,
  RequestEnvelope,
  ShannonGraphState,
  ShannonMode,
  ShannonActionPlan,
  TaskTreeState,
} from '@shannon/common';
import { inferInitialMode, envelopeToTaskContext } from './stateBridge.js';
import { actionFormatterNode } from '../../common/adapters/actionFormatter.js';
import { FunctionCallingAgent } from './nodes/FunctionCallingAgent.js';
import { buildFcaState } from './nodes/fcaState.js';
import { loadFcaCompositionExtras } from './nodes/fcaCompositionLoader.js';
import type { ScopedMemoryService } from '../../memory/scopedMemoryService.js';
import { ScopedMemoryService as ScopedMemoryServiceImpl } from '../../memory/scopedMemoryService.js';
import { ModelSelector } from './cognitive/ModelSelector.js';
import { TaskEpisodeMemory } from './cognitive/TaskEpisodeMemory.js';
import type { ExecutionResult } from './types.js';

// ---------------------------------------------------------------------------
// LangGraph Annotation (state schema)
// ---------------------------------------------------------------------------

const replace = <T>(_: T, next: T) => next;
const append = <T>(prev: T[], next: T[]) => [...prev, ...next];

const ShannonState = Annotation.Root({
  // -- input --
  envelope: Annotation<RequestEnvelope>({ reducer: replace, default: () => ({} as RequestEnvelope) }),

  // -- classification (ingest) --
  mode: Annotation<ShannonMode | undefined>({ reducer: replace, default: () => undefined }),
  selectedModel: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),

  // -- output --
  actionPlan: Annotation<ShannonActionPlan | undefined>({ reducer: replace, default: () => undefined }),
  finalAnswer: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  taskTree: Annotation<TaskTreeState | undefined>({ reducer: replace, default: () => undefined }),

  // -- observability --
  trace: Annotation<string[]>({ reducer: append, default: () => [] }),
  warnings: Annotation<string[]>({ reducer: append, default: () => [] }),

  // -- bridge: callbacks passed from MinebotTaskRuntime --
  _legacyMessages: Annotation<BaseMessage[]>({ reducer: replace, default: () => [] }),
  _onToolStarting: Annotation<((toolName: string, args?: Record<string, unknown>) => void) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _onTaskTreeUpdate: Annotation<((taskTree: TaskTreeState) => void) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _onStreamSentence: Annotation<((sentence: string) => Promise<void>) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _onRequestSkillInterrupt: Annotation<(() => void) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _getLiveInventory: Annotation<(() => MinecraftInventoryEntry[]) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _getActiveEffects: Annotation<(() => Array<{ name: string; amplifier: number }>) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _getInventoryDiff: Annotation<(() => string | null) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _getInitialMemory: Annotation<(() => Promise<string | null>) | undefined>({
    reducer: replace, default: () => undefined,
  }),
  _abortSignal: Annotation<AbortSignal | undefined>({
    reducer: replace, default: () => undefined,
  }),

  // -- MAX_ITERATIONS continuation --
  recoveryStatus: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  savedMessages: Annotation<unknown[] | undefined>({ reducer: replace, default: () => undefined }),
  savedTaskNodes: Annotation<unknown[] | undefined>({ reducer: replace, default: () => undefined }),
});

type ShannonStateType = typeof ShannonState.State;

// ---------------------------------------------------------------------------
// Shared services (initialized once at graph build time)
// ---------------------------------------------------------------------------

function resolveScopedMemory(deps?: ShannonGraphDeps): ScopedMemoryService {
  return deps?.scopedMemory ?? ScopedMemoryServiceImpl.getInstance();
}

// ---------------------------------------------------------------------------
// Node implementations
// ---------------------------------------------------------------------------

async function ingestNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const mode = inferInitialMode(state.envelope);
  // Phase 4: ClassifyNode 削除により、ingest でモデル選択を設定
  const selectedModel = ModelSelector.selectInitialModel('mid', false, mode);
  return { mode, selectedModel, trace: ['node:ingest'] };
}

/**
 * 緊急ファストパス: ハードコードされた緊急分類で直接 execute へ。
 */
async function emergencyFastpathNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const selectedModel = ModelSelector.selectInitialModel('high', false, 'minecraft_emergency');
  return {
    mode: 'minecraft_emergency' as ShannonMode,
    selectedModel,
    trace: ['node:emergency_fastpath'],
  };
}

/**
 * execute: Delegates to ShannonExecutor (Minecraft) or the FCA.
 */
function createExecuteNode(
  fca: FunctionCallingAgent,
  scopedMemory: ScopedMemoryService,
  routineManager?: import('../../minebot/routines/RoutineManager.js').RoutineManager,
  routineExecutor?: import('../../minebot/routines/RoutineExecutor.js').RoutineExecutor,
) {
  return async function executeFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
    state._abortSignal?.throwIfAborted();
    const envelope = state.envelope;
    const memoryEnvelope = snapshotMemoryEnvelope(envelope);
    const context = envelopeToTaskContext(envelope);

    const platform = context?.platform ?? envelope.channel ?? 'unknown';
    const goal = envelope.text ?? '';
    const lightweightMemory = platform === 'minecraft' || platform === 'minebot';
    const memoryRecall = await scopedMemory.recall({
      envelope: memoryEnvelope,
      text: goal,
      lightweightMode: lightweightMemory,
    });
    const compositionExtras = await loadFcaCompositionExtras({
      goal,
      platform,
      memoryEnvelope,
      environmentState: (envelope.metadata?.environmentState as string) ?? null,
      serverId: memoryEnvelope.minecraft?.serverId,
      lightweightMemory,
      recall: memoryRecall,
    });

    const fcaState = buildFcaState({
      taskId: envelope.requestId,
      requestEnvelope: memoryEnvelope,
      userMessage: goal || null,
      messages: state._legacyMessages,
      context,
      channelId: envelope.discord?.channelId ?? envelope.conversationId,
      environmentState: (envelope.metadata?.environmentState as string) ?? null,
      isEmergency: envelope.tags.includes('emergency'),
      ...compositionExtras,
      onToolStarting: state._onToolStarting,
      onTaskTreeUpdate: state._onTaskTreeUpdate,
      onStreamSentence: state._onStreamSentence,
      onRequestSkillInterrupt: state._onRequestSkillInterrupt,
      getLiveInventory: state._getLiveInventory,
      getActiveEffects: state._getActiveEffects,
      getInventoryDiff: state._getInventoryDiff,
      getInitialMemory: state._getInitialMemory,
      selectedModel: state.selectedModel,
      classifyMode: state.mode,
      needsTools: state.needsTools,
      needsPlanning: state.needsPlanning,
    });

    const runFcaPath = async (): Promise<Partial<ShannonStateType>> => {
      const startTime = Date.now();
      const agentResult = await fca.run(fcaState, state._abortSignal);
      state._abortSignal?.throwIfAborted();

      try {
        TaskEpisodeMemory.saveEpisodeForRun(
          TaskEpisodeMemory.buildEpisodeFromResult(
            goal, platform, agentResult.taskTree, startTime, 0,
          ),
          memoryEnvelope,
        );
      } catch { /* ignore */ }

      return {
        finalAnswer: agentResult.lastAssistantContent ?? agentResult.taskTree?.strategy ?? undefined,
        taskTree: agentResult.taskTree ?? undefined,
        trace: ['node:execute:fca'],
      };
    };

    // Discord/Web 等は FCA (OpenAI / LangChain Anthropic)。Minebot のみ ShannonExecutor。
    const useShannonExecutor =
      envelope.channel === 'minecraft'
      && Boolean(config.anthropic?.apiKey)
      && process.env.SHANNON_USE_FCA !== 'true';

    // ═══ ShannonExecutor パス (Anthropic API 直接呼出・Minecraft のみ) ═══
    if (useShannonExecutor) {
      try {
        const { ShannonExecutor, skillToAnthropicTool, routineToAnthropicTool } = await import('./ShannonExecutor.js');
        const { PromptBuilder } = await import('./nodes/prompt/PromptBuilder.js');

        // ツール定義を構築 (Anthropic ネイティブ形式)
        const tools: import('@anthropic-ai/sdk').Tool[] = [];

        // task-complete ツール
        tools.push({
          name: 'task-complete',
          description: 'タスクが完了したら呼ぶ。summary にユーザーへの返答を書く。',
          input_schema: {
            type: 'object' as const,
            properties: { summary: { type: 'string', description: 'ユーザーへの返答' } },
            required: ['summary'],
          },
        });

        // search-skills ツール: スキル/ルーチンの説明・引数を検索
        tools.push({
          name: 'search-skills',
          description: 'スキルやルーチンの使い方・引数を検索する。やり方が分からない時、失敗した時に使え。例: search-skills({query:"attack"}) → attack 系スキルの一覧と使い方',
          input_schema: {
            type: 'object' as const,
            properties: { query: { type: 'string', description: '検索キーワード（スキル名の一部や動作の説明）' } },
            required: ['query'],
          },
        });

        // InstantSkills
        const bot = (envelope.metadata as any)?.bot;
        if (bot?.instantSkills?.getSkills) {
          for (const skill of bot.instantSkills.getSkills()) {
            const tool = skillToAnthropicTool(skill);
            if (!tools.some(t => t.name === tool.name)) tools.push(tool);
          }
        }

        if (routineManager) {
          for (const def of routineManager.getAll()) {
            tools.push(routineToAnthropicTool(def.name, def));
          }
          tools.push({
            name: 'manage-routine',
            description: 'ルーチンの管理 (list/get/create/edit/delete)',
            input_schema: {
              type: 'object' as const,
              properties: {
                action: { type: 'string', description: 'list, get, create, edit, delete' },
                name: { type: 'string', description: 'ルーチン名' },
                definition: { type: 'string', description: 'JSON定義' },
              },
              required: ['action'],
            },
          });
        }

        // A fresh context-bearing tool set for this executor invocation.
        const created = fca.createToolsForRun();
        bindRequestMemory(created, memoryEnvelope);
        bindRequestDiscordConversation(created, memoryEnvelope, state._abortSignal);
        bindRequestWebConversation(created, memoryEnvelope, state._abortSignal);
        const runTools = selectToolsForChannel('minecraft', created);
        // FCA 登録済みツールを Anthropic 形式に変換
        for (const tool of runTools) {
          // routine:xxx は既に routine-xxx として追加済み、manage-routine / task-complete も追加済み
          if (tool.name.includes(':')) continue; // Anthropic は ':' を許可しない
          const sanitizedName = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
          if (tools.some(t => t.name === sanitizedName || t.name === tool.name)) continue;
          // Zod スキーマ → JSON Schema 変換 (zodToJsonSchema があればそれを使う)
          let inputSchema: Record<string, unknown> = { type: 'object', properties: {} };
          try {
            if ((tool as any).schema) {
              const { zodToJsonSchema } = await import('zod-to-json-schema');
              const jsonSchema = zodToJsonSchema((tool as any).schema, { target: 'openApi3' });
              inputSchema = { type: 'object', ...jsonSchema } as Record<string, unknown>;
              // $schema フィールドを除去 (Anthropic API が拒否する)
              delete inputSchema['$schema'];
              delete inputSchema['additionalProperties'];
            }
          } catch {
            // zodToJsonSchema が使えない場合はデフォルト
          }
          tools.push({
            name: sanitizedName,
            description: tool.description,
            input_schema: inputSchema as any,
          });
        }

        // システムプロンプト構築
        const promptBuilder = new PromptBuilder();
        if (routineManager) promptBuilder.setRoutineManager(routineManager as any);
        const systemPrompt = promptBuilder.buildSystemPrompt(
          context,
          (envelope.metadata?.environmentState as string) ?? null,
        );

        // LLM ツール用マップ (FCA のツールを直接呼出)
        // sanitize 後の名前でもマッチするように両方登録
        const llmToolMap = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
        for (const tool of runTools) {
          if (['task-complete'].includes(tool.name)) continue;
          if (tool.name.includes(':')) continue; // routine:xxx は ShannonExecutor が直接処理
          const sanitized = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
          const handler = async (input: Record<string, unknown>) => {
            try {
              state._abortSignal?.throwIfAborted();
              return await tool.invoke(input, { signal: state._abortSignal });
            } catch (e) {
              state._abortSignal?.throwIfAborted();
              return `エラー: ${e instanceof Error ? e.message : String(e)}`;
            }
          };
          llmToolMap.set(tool.name, handler);
          if (sanitized !== tool.name) llmToolMap.set(sanitized, handler);
        }

        const { resolveMinebotToolPolicy, filterToolsByMinebotPolicy } = await import(
          '../../minebot/utils/minebotToolPolicy.js'
        );
        const toolPolicy = resolveMinebotToolPolicy(bot, envelope);
        const toolsForRun = filterToolsByMinebotPolicy(tools, toolPolicy);
        if (toolsForRun.length !== tools.length) {
          logger.info(
            `Minebot tool policy "${toolPolicy}": tools ${tools.length} → ${toolsForRun.length}`,
          );
        }

        const executor = new ShannonExecutor({
          instantSkills: bot?.instantSkills,
          bot,
          routineManager,
          routineExecutor,
          llmTools: llmToolMap,
          continuation: minecraftTaskContinuation(envelope.minecraft),
        });

        const previousMessages = (envelope.metadata as any)?.previousMessages as
          import('./ShannonExecutor.js').ShannonExecutorState['previousMessages'];
        const previousTaskNodes = (envelope.metadata as any)?.previousTaskNodes as
          import('@shannon/common').TaskNode[] | undefined;

        const result = await executor.run({
          goal: envelope.text ?? '',
          context,
          systemPrompt,
          tools: toolsForRun,
          tags: envelope.tags,
          onToolStarting: state._onToolStarting,
          onTaskTreeUpdate: state._onTaskTreeUpdate,
          abortSignal: state._abortSignal,
          getHumanFeedback: (envelope.metadata as any)?.getHumanFeedback,
          previousMessages,
          previousTaskNodes,
        });

        return {
          finalAnswer: result.lastContent ?? undefined,
          taskTree: result.taskTree ?? undefined,
          trace: [`node:execute:shannon:${result.toolCallCount}tools/${result.durationMs}ms`],
          recoveryStatus: result.recoveryStatus,
          savedMessages: result.messages,
          savedTaskNodes: result.taskNodes,
        };
      } catch (e) {
        // Cancellation must not start a fallback engine.
        state._abortSignal?.throwIfAborted();
        logger.error(`❌ ShannonExecutor failed, falling back to FCA: ${e}`, e);
      }
    }

    return runFcaPath();
  };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * simplifiedWriteback: format + writeback を統合 (Phase 4)
 */
async function simplifiedWritebackNode(
  state: ShannonStateType,
  scopedMemory: ScopedMemoryService,
): Promise<Partial<ShannonStateType>> {
  state._abortSignal?.throwIfAborted();
  // format
  const formatResult = await actionFormatterNode(state as unknown as ShannonGraphState);
  state._abortSignal?.throwIfAborted();

  // writeback (fire-and-forget)
  const userText = state.envelope.text ?? '';
  const answer = state.finalAnswer ?? '';
  scopedMemory.writeback({
    envelope: state.envelope,
    conversationText: `User: ${userText}\nShannon: ${answer}`,
    exchanges: [
      { role: 'user', content: userText, timestamp: new Date() },
      { role: 'assistant', content: answer, timestamp: new Date() },
    ],
  }).catch(() => {});

  return {
    actionPlan: formatResult.actionPlan,
    trace: ['node:writeback:simplified'],
  };
}

export interface ShannonGraphDeps {
  fca: FunctionCallingAgent;
  scopedMemory?: ScopedMemoryService;
  /** Minecraft ルーチン実行用（任意、なければ従来パス） */
  routineManager?: import('../../minebot/routines/RoutineManager.js').RoutineManager;
  routineExecutor?: import('../../minebot/routines/RoutineExecutor.js').RoutineExecutor;
}

export function buildShannonGraph(deps: ShannonGraphDeps) {
  const scopedMemory = resolveScopedMemory(deps);
  const executeNode = createExecuteNode(deps.fca, scopedMemory, deps.routineManager, deps.routineExecutor);
  const writebackNode = (state: ShannonStateType) => simplifiedWritebackNode(state, scopedMemory);

  const workflow = new StateGraph(ShannonState)
    .addNode('ingest', ingestNode)
    .addNode('emergency_fastpath', emergencyFastpathNode)
    .addNode('execute', executeNode)
    .addNode('writeback', writebackNode)

    .addEdge(START, 'ingest')
    .addConditionalEdges('ingest', (state: ShannonStateType) => {
      if (state.envelope.tags.includes('emergency')) return 'emergency_fastpath';
      return 'execute';
    }, {
      emergency_fastpath: 'emergency_fastpath',
      execute: 'execute',
    })
    .addEdge('emergency_fastpath', 'execute')
    .addEdge('execute', 'writeback')
    .addEdge('writeback', END);

  logger.info('📊 Shannon Graph: 3 nodes (ingest → execute → writeback)', 'cyan');
  return workflow.compile();
}

// ---------------------------------------------------------------------------
// Convenience invoke wrapper
// ---------------------------------------------------------------------------

export type CompiledShannonGraph = ReturnType<typeof buildShannonGraph>;

export async function invokeShannonGraph(
  graph: CompiledShannonGraph,
  envelope: RequestEnvelope,
  legacyMessages?: BaseMessage[],
  options?: {
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    onStreamSentence?: (sentence: string) => Promise<void>;
    onRequestSkillInterrupt?: () => void;
    getLiveInventory?: () => MinecraftInventoryEntry[];
    getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
    getInventoryDiff?: () => string | null;
    getInitialMemory?: () => Promise<string | null>;
    abortSignal?: AbortSignal;
  },
): Promise<ShannonGraphState> {
  options?.abortSignal?.throwIfAborted();
  const result = await graph.invoke({
    envelope,
    _legacyMessages: legacyMessages ?? [],
    _onToolStarting: options?.onToolStarting,
    _onTaskTreeUpdate: options?.onTaskTreeUpdate,
    _onStreamSentence: options?.onStreamSentence,
    _onRequestSkillInterrupt: options?.onRequestSkillInterrupt,
    _getLiveInventory: options?.getLiveInventory,
    _getActiveEffects: options?.getActiveEffects,
    _getInventoryDiff: options?.getInventoryDiff,
    _getInitialMemory: options?.getInitialMemory,
    _abortSignal: options?.abortSignal,
  }, { signal: options?.abortSignal });
  options?.abortSignal?.throwIfAborted();
  return result as unknown as ShannonGraphState;
}
