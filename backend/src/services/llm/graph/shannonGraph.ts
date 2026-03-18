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
import { CraftPlan, runCraftPreflight } from './nodes/CraftPreflightNode.js';

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

  // -- craft preflight (deterministic pre-computation for Minecraft crafting) --
  craftPlan: Annotation<CraftPlan | undefined>({ reducer: replace, default: () => undefined }),

  // -- planning --
  plan: Annotation<ShannonPlan | undefined>({ reducer: replace, default: () => undefined }),
  taskTree: Annotation<TaskTreeState | undefined>({ reducer: replace, default: () => undefined }),

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
  return { mode, trace: ['node:ingest'] };
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

  // Minecraft チャンネルではデフォルトを上書き
  const isMinecraft = envelope.channel === 'minecraft';
  const mode = (isMinecraft && !result.mode?.startsWith('minecraft'))
    ? (result.riskLevel === 'high' ? 'minecraft_emergency' : 'minecraft_action') as ShannonMode
    : result.mode as ShannonMode;
  const needsTools = isMinecraft ? true : result.needsTools;

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
 * CraftPreflight ノード: Minecraft クラフトタスクの決定論的前処理。
 * LLM を使わず、レシピ解決・インベントリ突合・インフラ検索をコードで事前計算する。
 */
async function craftPreflightNodeFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
  const mc = state.envelope.minecraft;
  const plan = runCraftPreflight({
    channel: state.envelope.channel,
    text: state.envelope.text,
    inventory: mc?.inventory,
    nearbyInfrastructure: mc?.nearbyInfrastructure,
    nearbyResources: mc?.nearbyResources,
  });
  return {
    craftPlan: plan,
    trace: ['node:craft_preflight'],
  };
}

/**
 * Phase 2-B: classify 後のルーティング
 * - Minecraft → recall + craft_preflight 並列（emotion はスキップ）
 * - その他 → emotion + recall 並列（従来通り）
 */
function classifyRouter(state: ShannonStateType): string[] {
  const channel = state.envelope.channel;
  if (channel === 'minecraft') {
    // emotion をスキップし recall + craft_preflight を並列実行
    return ['recall', 'craft_preflight'];
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
 * execute: Delegates to ParallelExecutor (3 async loops: Emotion + MetaCognition + TaskExecution).
 * Falls back to FCA-only mode if emotionNode is not provided.
 */
function createExecuteNode(fca: FunctionCallingAgent, emotionNode?: EmotionNode) {
  const parallelExecutor = emotionNode
    ? new ParallelExecutor({ fca, emotionNode })
    : null;

  return async function executeFn(state: ShannonStateType): Promise<Partial<ShannonStateType>> {
    const envelope = state.envelope;
    const context = envelopeToTaskContext(envelope);
    const emotionState: EmotionState = state._emotionState ?? { current: state.emotion ?? null };

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
      selectedModel: state.selectedModel,
      classifyMode: state.mode,
      needsTools: state.needsTools,
      needsPlanning: state.needsPlanning,
      craftPlan: state.craftPlan,
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

export interface ShannonGraphDeps {
  emotionNode: EmotionNode;
  fca: FunctionCallingAgent;
}

export function buildShannonGraph(deps: ShannonGraphDeps) {
  const workflow = new StateGraph(ShannonState)
    .addNode('ingest', ingestNode)
    .addNode('emergency_fastpath', emergencyFastpathNode)
    .addNode('classify', classifyNodeFn)
    .addNode('emotion_step', createEmotionNode(deps.emotionNode))
    .addNode('recall', recallNode)
    .addNode('craft_preflight', craftPreflightNodeFn)
    .addNode('execute', createExecuteNode(deps.fca, deps.emotionNode))
    .addNode('format', formatNode)
    .addNode('writeback', writebackNode)

    // Phase 1-A: ingest → 緊急なら fastpath、通常なら classify
    .addEdge(START, 'ingest')
    .addConditionalEdges('ingest', ingestRouter, {
      emergency_fastpath: 'emergency_fastpath',
      classify: 'classify',
    })
    // emergency_fastpath → 直接 execute（classify/emotion/recall スキップ）
    .addEdge('emergency_fastpath', 'execute')
    // Phase 2-B: classify → Minecraft は recall のみ、他は emotion+recall 並列
    .addConditionalEdges('classify', classifyRouter, {
      emotion_step: 'emotion_step',
      recall: 'recall',
      craft_preflight: 'craft_preflight',
    })
    .addEdge('emotion_step', 'execute')
    .addEdge('recall', 'execute')
    .addEdge('craft_preflight', 'execute')
    .addEdge('execute', 'format')
    .addEdge('format', 'writeback')
    .addEdge('writeback', END);

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
    abortSignal?: AbortSignal;
  },
): Promise<ShannonGraphState> {
  const result = await graph.invoke({
    envelope,
    _legacyMessages: legacyMessages ?? [],
    _onToolStarting: options?.onToolStarting,
    _onTaskTreeUpdate: options?.onTaskTreeUpdate,
    _onRequestSkillInterrupt: options?.onRequestSkillInterrupt,
    _abortSignal: options?.abortSignal,
  });
  return result as unknown as ShannonGraphState;
}
