/**
 * Shannon Unified Graph
 *
 * Single core graph that handles all channels.
 * 1 identity, 1 core graph, N channel adapters.
 *
 * Flow:
 *   ingest → classify → [emotion ∥ recall] → execute → format → writeback → END
 *
 * Memory: uses ScopedMemoryService directly (no MemoryNode wrapper).
 * Emotion: delegates to EmotionNode.
 * Execution: delegates to FunctionCallingAgent.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('LLM:ShannonGraph');
import { BaseMessage } from '@langchain/core/messages';
import type {
  InternalState,
  RelationshipModel,
  RequestEnvelope,
  ShannonGraphState,
  ShannonMode,
  ShannonSelfModel,
  ShannonActionPlan,
  MemoryItem,
  ToolCallRecord,
  ShannonPlan,
  SelfModProposal,
  StrategyUpdate,
  UserProfileSnapshot,
  WorldModelPattern,
  EmotionType,
  TaskTreeState,
} from '@shannon/common';
import { inferInitialMode, envelopeToTaskContext } from './stateBridge.js';
import { actionFormatterNode } from '../../common/adapters/actionFormatter.js';
import { loadPublicKnowledge } from './publicKnowledge.js';
import { EmotionNode, EmotionState } from './nodes/EmotionNode.js';
import { FunctionCallingAgent } from './nodes/FunctionCallingAgent.js';
import { ClassifyNode } from './nodes/ClassifyNode.js';
import { ScopedMemoryService } from '../../memory/scopedMemoryService.js';
import { ModelSelector } from './cognitive/ModelSelector.js';
import { ParallelExecutor } from './cognitive/ParallelExecutor.js';
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

  // -- classification --
  mode: Annotation<ShannonMode | undefined>({ reducer: replace, default: () => undefined }),
  intent: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  riskLevel: Annotation<'low' | 'mid' | 'high' | undefined>({ reducer: replace, default: () => undefined }),
  needsTools: Annotation<boolean | undefined>({ reducer: replace, default: () => undefined }),
  needsPlanning: Annotation<boolean | undefined>({ reducer: replace, default: () => undefined }),

  // -- emotion --
  emotion: Annotation<EmotionType | undefined>({ reducer: replace, default: () => undefined }),

  // -- memory (scoped recall result) --
  memoryPrompt: Annotation<string>({ reducer: replace, default: () => '' }),
  userProfile: Annotation<UserProfileSnapshot | undefined>({ reducer: replace, default: () => undefined }),
  selfModel: Annotation<ShannonSelfModel | undefined>({ reducer: replace, default: () => undefined }),
  relationshipModel: Annotation<RelationshipModel | undefined>({ reducer: replace, default: () => undefined }),
  strategyUpdates: Annotation<StrategyUpdate[] | undefined>({ reducer: replace, default: () => undefined }),
  internalState: Annotation<InternalState | undefined>({ reducer: replace, default: () => undefined }),
  worldModelPatterns: Annotation<WorldModelPattern[] | undefined>({ reducer: replace, default: () => undefined }),
  relationshipPrompt: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  selfModelPrompt: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  strategyPrompt: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  internalStatePrompt: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  worldModelPrompt: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),

  // -- model selection (RAS) --
  selectedModel: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),

  // -- planning --
  plan: Annotation<ShannonPlan | undefined>({ reducer: replace, default: () => undefined }),
  taskTree: Annotation<TaskTreeState | undefined>({ reducer: replace, default: () => undefined }),
  /** SubTaskPlannerNode が生成したサブタスクプラン */
  subtaskPlan: Annotation<import('./nodes/SubTaskPlannerNode.js').SubTaskPlanEntry[] | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // -- tool execution --
  allowedTools: Annotation<string[] | undefined>({ reducer: replace, default: () => undefined }),
  toolCalls: Annotation<ToolCallRecord[]>({ reducer: append, default: () => [] }),
  retrievedFacts: Annotation<string[]>({ reducer: append, default: () => [] }),

  // -- output --
  actionPlan: Annotation<ShannonActionPlan | undefined>({ reducer: replace, default: () => undefined }),
  finalAnswer: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),

  // -- observability --
  trace: Annotation<string[]>({ reducer: append, default: () => [] }),
  warnings: Annotation<string[]>({ reducer: append, default: () => [] }),

  // -- bridge: messages for FCA (until FCA accepts envelope directly) --
  _legacyMessages: Annotation<BaseMessage[]>({ reducer: replace, default: () => [] }),
  _emotionState: Annotation<EmotionState | undefined>({ reducer: replace, default: () => undefined }),
  _onToolStarting: Annotation<((toolName: string, args?: Record<string, unknown>) => void) | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  _onTaskTreeUpdate: Annotation<((taskTree: TaskTreeState) => void) | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  _onRequestSkillInterrupt: Annotation<(() => void) | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  _getLiveInventory: Annotation<(() => Array<{ name: string; count: number }>) | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  _getActiveEffects: Annotation<(() => Array<{ name: string; amplifier: number }>) | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  _abortSignal: Annotation<AbortSignal | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
});

type ShannonStateType = typeof ShannonState.State;

// ---------------------------------------------------------------------------
// Shared singletons (initialized once at graph build time)
// ---------------------------------------------------------------------------

const classifyNode = new ClassifyNode();
const scopedMemory = ScopedMemoryService.getInstance();

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
 * ingest 後のルーティング:
 * - emergency タグ付き → 直接 execute（classify/emotion/recall スキップ）
 * - それ以外 → classify
 */
function ingestRouter(state: ShannonStateType): string {
  if (state.envelope.tags.includes('emergency')) {
    return 'emergency_fastpath';
  }
  return 'classify';
}

/**
 * 緊急ファストパス: classify/emotion/recall を完全スキップし、
 * ハードコードされた緊急分類で直接 execute へ進む。
 * 効果: -7〜18秒（LLM 分類 + 感情評価 + 記憶検索を全スキップ）
 */
async function emergencyFastpathNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const selectedModel = ModelSelector.selectInitialModel('high', false, 'minecraft_emergency');
  return {
    mode: 'minecraft_emergency' as ShannonMode,
    intent: state.envelope.text?.slice(0, 100) ?? 'emergency',
    riskLevel: 'high',
    needsTools: true,
    needsPlanning: false,
    selectedModel,
    trace: ['node:emergency_fastpath'],
  };
}

async function classifyNodeFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const envelope = state.envelope;

  // 全チャンネル統一: LLM 分類 (gpt-4.1-mini)
  // Minecraft もハードコード正規表現ではなく LLM に判断させることで、
  // 「木を切ってきて」「ダイヤモンド探して」等の多様な表現に対応する
  const result = await classifyNode.invoke(envelope);

  // Minecraft チャンネルでは mode を必要に応じて補正（needsTools は分類器の判断を尊重）
  const isMinecraft = envelope.channel === 'minecraft';
  const mode = (isMinecraft && !result.mode?.startsWith('minecraft') && result.needsTools)
    ? (result.riskLevel === 'high' ? 'minecraft_emergency' : 'minecraft_action') as ShannonMode
    : result.mode as ShannonMode;
  const needsTools = result.needsTools;

  const selectedModel = ModelSelector.selectInitialModel(
    result.riskLevel as 'low' | 'mid' | 'high' | undefined,
    result.needsPlanning,
    mode,
  );
  return {
    mode,
    intent: result.intent,
    riskLevel: result.riskLevel,
    needsTools,
    needsPlanning: result.needsPlanning,
    selectedModel,
    trace: ['node:classify'],
  };
}

/**
 * Phase 2-B: classify 後のルーティング
 * - Minecraft → recall のみ（emotion はスキップ）
 * - その他 → emotion + recall 並列（従来通り）
 */
function classifyRouter(state: ShannonStateType): string[] {
  const channel = state.envelope.channel;
  if (channel === 'minecraft') {
    return ['recall'];
  }
  return ['emotion_step', 'recall'];
}

/**
 * emotion: Delegates to EmotionNode.
 */
function createEmotionNode(emotionNode: EmotionNode) {
  return async function emotionFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
    const result = await emotionNode.invoke({
      userMessage: state.envelope.text ?? undefined,
    });
    const emotionState: EmotionState = { current: result.emotion };
    return {
      emotion: result.emotion ?? undefined,
      _emotionState: emotionState,
      trace: ['node:emotion'],
    };
  };
}

/**
 * recall: Scoped memory retrieval via ScopedMemoryService.
 * No MemoryNode wrapper — queries directly with privacy filter and ranking.
 */
async function recallNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const channel = state.envelope.channel;
  const mode = state.mode;

  // Phase 2-C: Minecraft アクションは軽量 recall（person/self/relationship スキップ: -1〜4秒）
  if (channel === 'minecraft' && (mode === 'minecraft_action' || mode === 'minecraft_emergency')) {
    const result = await scopedMemory.recall({
      envelope: state.envelope,
      text: state.envelope.text ?? '',
      lightweightMode: true,  // person, selfModel, relationship, semantic search をスキップ
    });
    return {
      memoryPrompt: result.formattedPrompt,
      retrievedFacts: result.formattedPrompt ? [result.formattedPrompt] : [],
      strategyUpdates: result.strategyUpdates,
      worldModelPatterns: result.worldModelPatterns,
      strategyPrompt: result.strategyPrompt || undefined,
      worldModelPrompt: result.worldModelPrompt || undefined,
      trace: ['node:recall:lightweight'],
    };
  }

  const result = await scopedMemory.recall({
    envelope: state.envelope,
    text: state.envelope.text ?? '',
  });

  // Web channel: inject public knowledge about Shannon/AiMineLab
  let memoryPrompt = result.formattedPrompt;
  if (channel === 'web') {
    const publicKnowledge = loadPublicKnowledge(state.envelope.text ?? '');
    if (publicKnowledge) {
      memoryPrompt = memoryPrompt
        ? `${memoryPrompt}\n\n${publicKnowledge}`
        : publicKnowledge;
    }
  }

  return {
    memoryPrompt,
    retrievedFacts: memoryPrompt ? [memoryPrompt] : [],
    userProfile: result.userProfile ?? undefined,
    selfModel: result.selfModel ?? undefined,
    relationshipModel: result.relationshipModel ?? undefined,
    strategyUpdates: result.strategyUpdates,
    internalState: result.internalState ?? undefined,
    worldModelPatterns: result.worldModelPatterns,
    relationshipPrompt: result.relationshipPrompt || undefined,
    selfModelPrompt: result.selfModelPrompt || undefined,
    strategyPrompt: result.strategyPrompt || undefined,
    internalStatePrompt: result.internalStatePrompt || undefined,
    worldModelPrompt: result.worldModelPrompt || undefined,
    trace: ['node:recall'],
  };
}

/**
 * recall → execute ルーター: Minecraft + needsPlanning なら subtask_plan 経由
 */
function recallToExecuteRouter(state: ShannonStateType): string {
  const channel = state.envelope.channel;
  if (
    state.needsPlanning &&
    (channel === 'minecraft') &&
    !state.envelope.tags.includes('emergency')
  ) {
    return 'subtask_plan';
  }
  return 'execute';
}

/**
 * subtask_plan: SubTaskPlannerNode で Minecraft タスクをサブタスク分解
 */
function createSubTaskPlanNode(
  routineManager?: import('../../minebot/routines/RoutineManager.js').RoutineManager,
) {
  let planner: import('./nodes/SubTaskPlannerNode.js').SubTaskPlannerNode | null = null;

  return async function subtaskPlanFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
    if (!routineManager) {
      return { trace: ['node:subtask_plan:skip:no_manager'] };
    }

    try {
      if (!planner) {
        const { SubTaskPlannerNode } = await import('./nodes/SubTaskPlannerNode.js');
        planner = new SubTaskPlannerNode();
      }

      const mc = state.envelope.minecraft;
      const result = await planner.plan(
        state.envelope.text ?? '',
        routineManager,
        {
          inventory: mc?.inventory ? JSON.stringify(mc.inventory) : undefined,
          position: mc?.position ? JSON.stringify(mc.position) : undefined,
          strategyPrompt: state.strategyPrompt ?? undefined,
          worldModelPrompt: state.worldModelPrompt ?? undefined,
        },
      );

      if (!result) {
        return { trace: ['node:subtask_plan:fallback'] };
      }

      return {
        subtaskPlan: result.subtasks,
        trace: ['node:subtask_plan:ok'],
      };
    } catch (e) {
      logger.warn(`⚠ SubTaskPlanNode failed: ${e}`);
      return { trace: ['node:subtask_plan:error'] };
    }
  };
}

/**
 * execute: Delegates to SubTaskExecutor (if subtaskPlan exists),
 * ParallelExecutor (3 async loops), or FCA-only mode.
 */
function createExecuteNode(
  fca: FunctionCallingAgent,
  emotionNode?: EmotionNode,
  routineManager?: import('../../minebot/routines/RoutineManager.js').RoutineManager,
  routineExecutor?: import('../../minebot/routines/RoutineExecutor.js').RoutineExecutor,
) {
  const parallelExecutor = emotionNode
    ? new ParallelExecutor({ fca, emotionNode })
    : null;

  return async function executeFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
    const envelope = state.envelope;
    const context = envelopeToTaskContext(envelope);
    const emotionState: EmotionState = state._emotionState ?? { current: state.emotion ?? null };

    // ═══ ShannonExecutor パス (Anthropic API 直接呼出) ═══
    // FCA/LangChain を経由せず、Anthropic SDK で直接実行。
    // フォールバック: SHANNON_USE_FCA=true で従来の FCA/ParallelExecutor に戻す。
    if (config.anthropic?.apiKey && process.env.SHANNON_USE_FCA !== 'true') {
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

        // InstantSkills
        const bot = (envelope.metadata as any)?.bot;
        const instantSkills = bot?.instantSkills ?? fca.getTools()
          .filter((t: any) => !t.name.startsWith('routine:') && !['task-complete', 'update-plan', 'manage-routine'].includes(t.name))
          .map((t: any) => null); // fallback: FCA のツールは使えない

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

        // FCA 登録済みツールを Anthropic 形式に変換
        for (const tool of fca.getTools()) {
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
          emotionState,
          context,
          (envelope.metadata?.environmentState as string) ?? null,
        );

        // LLM ツール用マップ (FCA のツールを直接呼出)
        // sanitize 後の名前でもマッチするように両方登録
        const llmToolMap = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
        for (const tool of fca.getTools()) {
          if (['task-complete'].includes(tool.name)) continue;
          if (tool.name.includes(':')) continue; // routine:xxx は ShannonExecutor が直接処理
          const sanitized = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
          const handler = async (input: Record<string, unknown>) => {
            try {
              return await (tool as any)._call(input);
            } catch (e) {
              return `エラー: ${e instanceof Error ? e.message : String(e)}`;
            }
          };
          llmToolMap.set(tool.name, handler);
          if (sanitized !== tool.name) llmToolMap.set(sanitized, handler);
        }

        const executor = new ShannonExecutor({
          instantSkills: bot?.instantSkills,
          routineManager,
          routineExecutor,
          llmTools: llmToolMap,
        });

        const result = await executor.run({
          goal: envelope.text ?? '',
          context,
          systemPrompt,
          tools,
          onToolStarting: state._onToolStarting,
          onTaskTreeUpdate: state._onTaskTreeUpdate,
          abortSignal: state._abortSignal,
        });

        return {
          finalAnswer: result.lastContent ?? undefined,
          taskTree: result.taskTree ?? undefined,
          trace: [`node:execute:shannon:${result.toolCallCount}tools/${result.durationMs}ms`],
        };
      } catch (e) {
        logger.warn(`⚠ ShannonExecutor failed, falling back to FCA: ${e}`);
      }
    }

    // ═══ FCA/ParallelExecutor フォールバック ═══
    const fcaState = {
      taskId: envelope.requestId,
      userMessage: envelope.text ?? null,
      messages: state._legacyMessages,
      emotionState,
      memoryState: undefined as undefined,
      context,
      channelId: envelope.discord?.channelId ?? envelope.conversationId,
      environmentState: (envelope.metadata?.environmentState as string) ?? null,
      isEmergency: envelope.tags.includes('emergency'),
      memoryPrompt: state.memoryPrompt || undefined,
      relationshipPrompt: state.relationshipPrompt,
      selfModelPrompt: state.selfModelPrompt,
      strategyPrompt: state.strategyPrompt,
      internalStatePrompt: state.internalStatePrompt,
      worldModelPrompt: state.worldModelPrompt,
      onToolStarting: state._onToolStarting,
      onTaskTreeUpdate: state._onTaskTreeUpdate,
      onRequestSkillInterrupt: state._onRequestSkillInterrupt,
      getLiveInventory: state._getLiveInventory,
      getActiveEffects: state._getActiveEffects,
      selectedModel: state.selectedModel,
      classifyMode: state.mode,
      needsTools: state.needsTools,
      needsPlanning: state.needsPlanning,
      onToolsExecuted: (messages: BaseMessage[], results: ExecutionResult[]) => {
        if (emotionNode) {
          emotionNode
            .evaluateAsync(messages, results, emotionState.current)
            .then((e) => { emotionState.current = e; })
            .catch(() => {});
        }
      },
    };

    if (parallelExecutor) {
      // 3並列プロセス: EmotionLoop + MetaCognitionLoop + TaskExecutionLoop
      const result = await parallelExecutor.run(fcaState, state._abortSignal);
      return {
        finalAnswer: result.lastAssistantContent ?? result.taskTree?.strategy ?? undefined,
        taskTree: result.taskTree ?? undefined,
        emotion: result.finalEmotion ?? emotionState.current ?? undefined,
        trace: ['node:execute:parallel'],
      };
    }

    // フォールバック: FCA 単体実行
    const startTime = Date.now();
    const agentResult = await fca.run(fcaState);

    // エピソード記憶の保存（fire-and-forget）
    try {
      const platform = context?.platform ?? 'unknown';
      const goal = envelope.text ?? '';
      const episode = TaskEpisodeMemory.buildEpisodeFromResult(
        goal, platform, agentResult.taskTree, startTime, 0,
      );
      TaskEpisodeMemory.getInstance().saveEpisode(episode).catch(() => {});
    } catch { }

    return {
      finalAnswer: agentResult.lastAssistantContent ?? agentResult.taskTree?.strategy ?? undefined,
      taskTree: agentResult.taskTree ?? undefined,
      emotion: emotionState.current ?? undefined,
      trace: ['node:execute'],
    };
  };
}

async function formatNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const result = await actionFormatterNode(state as unknown as ShannonGraphState);
  return {
    actionPlan: result.actionPlan,
    trace: ['node:format'],
  };
}

/**
 * writeback: Scoped memory writeback via ScopedMemoryService.
 * Fire-and-forget — does not block response.
 */
async function writebackNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
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

  return { trace: ['node:writeback'] };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * simplifiedWriteback: format + writeback を統合 (Phase 4)
 */
async function simplifiedWritebackNode(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  // format
  const formatResult = await actionFormatterNode(state as unknown as ShannonGraphState);

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
  emotionNode: EmotionNode;
  fca: FunctionCallingAgent;
  /** SubTaskPlannerNode + SubTaskExecutor 用（任意、なければ従来パス） */
  routineManager?: import('../../minebot/routines/RoutineManager.js').RoutineManager;
  routineExecutor?: import('../../minebot/routines/RoutineExecutor.js').RoutineExecutor;
}

export function buildShannonGraph(deps: ShannonGraphDeps) {
  // Phase 4: フォールバック — SHANNON_GRAPH_VERSION=full で旧グラフに戻す
  if (process.env.SHANNON_GRAPH_VERSION === 'full') {
    return buildFullGraph(deps);
  }

  // Phase 4: 簡素化グラフ — 3ノード (ingest → execute → writeback)
  // classify, emotion_step, recall, subtask_plan, format を削除。
  // Claude Sonnet が分類・感情・メタ認知を内包。メモリは recall-* ツールでオンデマンド。
  const executeNode = createExecuteNode(deps.fca, deps.emotionNode, deps.routineManager, deps.routineExecutor);

  const workflow = new StateGraph(ShannonState)
    .addNode('ingest', ingestNode)
    .addNode('emergency_fastpath', emergencyFastpathNode)
    .addNode('execute', executeNode)
    .addNode('writeback', simplifiedWritebackNode)

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

  logger.info('📊 Shannon Graph: simplified (3 nodes: ingest → execute → writeback)', 'cyan');
  return workflow.compile();
}

/** フォールバック: 旧8ノードグラフ (SHANNON_GRAPH_VERSION=full) */
function buildFullGraph(deps: ShannonGraphDeps) {
  const executeNode = createExecuteNode(deps.fca, deps.emotionNode, deps.routineManager, deps.routineExecutor);

  const workflow = new StateGraph(ShannonState)
    .addNode('ingest', ingestNode)
    .addNode('emergency_fastpath', emergencyFastpathNode)
    .addNode('classify', classifyNodeFn)
    .addNode('emotion_step', createEmotionNode(deps.emotionNode))
    .addNode('recall', recallNode)
    .addNode('subtask_plan', createSubTaskPlanNode(deps.routineManager))
    .addNode('execute', executeNode)
    .addNode('format', formatNode)
    .addNode('writeback', writebackNode)

    .addEdge(START, 'ingest')
    .addConditionalEdges('ingest', ingestRouter, {
      emergency_fastpath: 'emergency_fastpath',
      classify: 'classify',
    })
    .addEdge('emergency_fastpath', 'execute')
    .addConditionalEdges('classify', classifyRouter, {
      emotion_step: 'emotion_step',
      recall: 'recall',
    })
    .addEdge('emotion_step', 'execute')
    .addConditionalEdges('recall', recallToExecuteRouter, {
      subtask_plan: 'subtask_plan',
      execute: 'execute',
    })
    .addEdge('subtask_plan', 'execute')
    .addEdge('execute', 'format')
    .addEdge('format', 'writeback')
    .addEdge('writeback', END);

  logger.info('📊 Shannon Graph: full (8 nodes, legacy mode)', 'yellow');
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
    onRequestSkillInterrupt?: () => void;
    getLiveInventory?: () => Array<{ name: string; count: number }>;
    getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
    abortSignal?: AbortSignal;
  },
): Promise<ShannonGraphState> {
  const result = await graph.invoke({
    envelope,
    _legacyMessages: legacyMessages ?? [],
    _onToolStarting: options?.onToolStarting,
    _onTaskTreeUpdate: options?.onTaskTreeUpdate,
    _onRequestSkillInterrupt: options?.onRequestSkillInterrupt,
    _getLiveInventory: options?.getLiveInventory,
    _getActiveEffects: options?.getActiveEffects,
    _abortSignal: options?.abortSignal,
  });
  return result as unknown as ShannonGraphState;
}
