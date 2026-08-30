import { BaseMessage } from '@langchain/core/messages';
import { StructuredTool } from '@langchain/core/tools';
import {
  MemoryZone,
  SkillInfo,
} from '@shannon/common';
import OpenAI from 'openai';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { classifyError, formatErrorForLog } from '../../errors/index.js';
import { logToWeb } from '../runtime/logging.js';
import { registerLlmInbound } from '../runtime/llmInboundRegistry.js';
import { registerSkillListHandler } from '../runtime/skillListRegistry.js';
import { getWebNotificationHub } from '../web/webNotificationHub.js';
import { VoicepeakClient } from '../voicepeak/client.js';
import { loadPrompt } from './config/prompts.js';
import { RealtimeAPIService } from './agents/realtimeApiAgent.js';
import { buildShannonGraph, invokeShannonGraph, CompiledShannonGraph } from './graph/shannonGraph.js';
import { initializeNodes } from './graph/nodeFactory.js';
import { FunctionCallingAgent } from './graph/nodes/FunctionCallingAgent.js';
import { RequestExecutionCoordinator } from './graph/requestExecutionCoordinator.js';
import { runCoordinatedGraph } from './graph/coordinatedGraphInvocation.js';
import type { RequestEnvelope, ShannonGraphState } from '@shannon/common';
import { getActionDispatcher } from '../common/adapters/index.js';
import { getTracedOpenAI } from './utils/langfuse.js';
import { logger } from '../../utils/logger.js';
import { VoiceProcessor } from './voice/VoiceProcessor.js';
import { AgentOrchestrator } from './agents/AgentOrchestrator.js';
import { EventRouter } from './routing/EventRouter.js';
import { snapshotMemoryEnvelope } from '../memory/requestMemory.js';
import { getIdentityBindingLookup } from '../runtime/identityBindingGateway.js';
import { applyDiscordIdentityMemoryGate, applyWebIdentityMemoryGate } from '../identity/identityMemoryGate.js';
import { config } from '../../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class LLMService {
  private static instance: LLMService;
  private realtimeApi: RealtimeAPIService;
  private tools: StructuredTool[] = [];
  private isDevMode: boolean;
  private voicepeakClient: VoicepeakClient;
  private openaiClient: OpenAI;
  private groqClient: OpenAI;
  private voiceCharacterPrompt: string = '';
  private shannonGraph: CompiledShannonGraph | null = null;
  private unifiedFca: FunctionCallingAgent | null = null;
  private initializationPromise: Promise<void> | null = null;
  private executionCoordinator = RequestExecutionCoordinator.getInstance();

  private voiceProcessor!: VoiceProcessor;
  private agentOrchestrator!: AgentOrchestrator;
  private eventRouter!: EventRouter;
  private routineManager: import('../minebot/routines/RoutineManager.js').RoutineManager | null = null;

  constructor(isDevMode: boolean) {
    this.isDevMode = isDevMode;
    this.realtimeApi = RealtimeAPIService.getInstance();
    this.voicepeakClient = VoicepeakClient.getInstance();
    this.openaiClient = getTracedOpenAI(new OpenAI({ apiKey: config.openaiApiKey }));
    this.groqClient = getTracedOpenAI(new OpenAI({
      apiKey: config.groq.apiKey || config.openaiApiKey,
      baseURL: config.groq.apiKey ? 'https://api.groq.com/openai/v1' : undefined,
    }));

    // Bind invokeGraph so extracted modules can call back into the graph
    const boundInvokeGraph = this.invokeGraph.bind(this);

    this.voiceProcessor = new VoiceProcessor({
      openaiClient: this.openaiClient,
      groqClient: this.groqClient,
      voicepeakClient: this.voicepeakClient,
      voiceCharacterPrompt: this.voiceCharacterPrompt,
      invokeGraph: boundInvokeGraph,
      config: { groqApiKey: config.groq.apiKey },
    });

    this.agentOrchestrator = new AgentOrchestrator({
      isDevMode: this.isDevMode,
      invokeGraph: boundInvokeGraph,
    });

    this.eventRouter = new EventRouter({
      isDevMode: this.isDevMode,
      realtimeApi: this.realtimeApi,
      agentOrchestrator: this.agentOrchestrator,
      voiceProcessor: this.voiceProcessor,
      invokeGraph: boundInvokeGraph,
    });

    registerLlmInbound(this.eventRouter);
    registerSkillListHandler(() => { void this.processGetSkills(); });
    this.setupRealtimeAPICallback();
  }

  public static getInstance(isDevMode: boolean): LLMService {
    if (!LLMService.instance) {
      LLMService.instance = new LLMService(isDevMode);
    }
    return LLMService.instance;
  }

  public async initialize() {
    if (this.shannonGraph && this.unifiedFca) {
      return;
    }
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = (async () => {
      // プロンプトホットリロードを有効化
      const { enablePromptHotReload } = await import('./config/prompts.js');
      enablePromptHotReload();

      // Initialize nodes and build unified Shannon graph
      const { emotionNode, fca } = await initializeNodes();
      this.unifiedFca = fca;
      (this as any)._emotionNode = emotionNode;
      this.shannonGraph = buildShannonGraph({ emotionNode, fca });

      // Initialize all agents via orchestrator
      await this.agentOrchestrator.initializeAgents();

      try {
        this.voiceCharacterPrompt = await loadPrompt('base_voice');
        this.voiceProcessor.setVoiceCharacterPrompt(this.voiceCharacterPrompt);
      } catch {
        logger.warn('[LLM] Failed to load base_voice prompt, voice will use default character');
      }

      logger.info('LLM Service initialized', 'cyan');
    })();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private setupRealtimeAPICallback() {
    this.eventRouter.setupRealtimeAPICallback();
  }

  private async getTools() {
    const toolsDir = join(__dirname, './tools');
    const toolFiles = readdirSync(toolsDir).filter(
      (file) => file.endsWith('.js') && !file.includes('.js.map')
    );

    this.tools = [];

    for (const file of toolFiles) {
      if (file === 'index.ts' || file === 'index.js') continue;
      try {
        const toolPath = join(toolsDir, file);
        const toolModule = await import(pathToFileURL(toolPath).href);
        const ToolClass = toolModule.default;
        // ツールが既に読み込まれているかチェック
        if (this.tools.find((tool) => tool.name === ToolClass.name)) continue;
        if (ToolClass?.prototype?.constructor) {
          this.tools.push(new ToolClass());
        }
      } catch (error) {
        logger.error(`ツール読み込みエラー: ${file}`, error);
      }
    }
  }

  private async processGetSkills() {
    if (this.tools.length === 0) {
      await this.getTools();
    }

    const skills = this.tools.map((tool) => {
      return {
        name: tool.name.toString(),
        description: tool.description.toString(),
        parameters: Object.entries(
          (tool.schema as z.ZodObject<z.ZodRawShape>).shape
        ).map(([name, value]) => ({
          name,
          description: (value as z.ZodTypeAny)._def.description,
        })),
      };
    });
    const uniqueSkills = skills.filter(
      (skill, index, self) =>
        index === self.findIndex((t) => t.name === skill.name)
    );
    getWebNotificationHub().emitSkill(uniqueSkills as SkillInfo[]);
  }

  /**
   * Core graph invocation — the single entry point for all channels.
   *
   * All channel handlers build a RequestEnvelope via their ChannelAdapter,
   * then call this method. No more manual TaskContext construction.
   */
  async invokeGraph(
    envelope: RequestEnvelope,
    legacyMessages?: BaseMessage[],
    options?: {
      onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
      onTaskTreeUpdate?: (taskTree: import('@shannon/common').TaskTreeState) => void;
      onStreamSentence?: (sentence: string) => Promise<void>;
      onRequestSkillInterrupt?: () => void;
      getLiveInventory?: () => import('@shannon/common').MinecraftInventoryEntry[];
      getActiveEffects?: () => Array<{ name: string; amplifier: number }>;
      getInventoryDiff?: () => string | null;
      getInitialMemory?: () => Promise<string | null>;
      abortSignal?: AbortSignal;
    },
  ): Promise<ShannonGraphState> {
    let activeEnvelope = envelope;
    const lookup = getIdentityBindingLookup();
    const projectId = config.webAuth.firebaseProjectId;
    if (lookup && projectId) {
      if (activeEnvelope.channel === 'discord') {
        activeEnvelope = await applyDiscordIdentityMemoryGate(activeEnvelope, projectId, lookup);
      } else if (activeEnvelope.channel === 'web') {
        activeEnvelope = await applyWebIdentityMemoryGate(activeEnvelope, projectId, lookup);
      }
    }
    const dispatchEnvelope = activeEnvelope.channel === 'discord' ? snapshotMemoryEnvelope(activeEnvelope) : activeEnvelope;
    await this.initialize();
    if (!this.shannonGraph) {
      throw new Error('Shannon graph not initialized');
    }

    try {
      return await runCoordinatedGraph(
        this.executionCoordinator, activeEnvelope,
        signal => invokeShannonGraph(this.shannonGraph!, activeEnvelope, legacyMessages, { ...options, abortSignal: signal }),
        (result, signal) => this.dispatchActionPlan(dispatchEnvelope, result, signal),
        options?.abortSignal,
      );
    } catch (error) {
      const zone = envelope.metadata?.legacyMemoryZone ?? envelope.channel;
      const sErr = classifyError(error, 'llm');
      logger.error(`Graph invocation error [${zone}]: ${formatErrorForLog(sErr)}`);
      void logToWeb(zone as MemoryZone, 'red', `Error: ${sErr.message}`, true);
      throw sErr;
    }
  }

  private async dispatchActionPlan(
    envelope: RequestEnvelope,
    result: ShannonGraphState,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!result.actionPlan) return;
    const dispatcher = getActionDispatcher(envelope.channel);
    if (!dispatcher) return;
    await dispatcher.dispatch(envelope, result.actionPlan, { signal });
  }

  public async registerMinebotTools(bot: import('../minebot/types.js').CustomBot): Promise<void> {
    await this.initialize();
    if (!this.unifiedFca) return;
    const { InstantSkillTool } = await import('../minebot/skills/InstantSkillTool.js');
    const tools = bot.instantSkills
      .getSkills()
      .filter((skill) => skill.isToolForLLM)
      .map((skill) => new InstantSkillTool(skill, bot));
    this.unifiedFca.addTools(tools);
  }

  public async registerSingleMinebotTool(
    skill: import('../minebot/types.js').InstantSkill,
    bot: import('../minebot/types.js').CustomBot,
  ): Promise<void> {
    await this.initialize();
    if (!this.unifiedFca) return;
    if (!skill.isToolForLLM) return;
    const { InstantSkillTool } = await import('../minebot/skills/InstantSkillTool.js');
    const tool = new InstantSkillTool(skill, bot);
    this.unifiedFca.addTools([tool]);
  }

  /**
   * Routine (System 1) ツールを FCA に登録
   * ルーチン JSON を読み込み、ラッパーツール + manage-routine ツールを追加する。
   */
  public async registerRoutineTools(bot: import('../minebot/types.js').CustomBot): Promise<void> {
    await this.initialize();
    if (!this.unifiedFca) return;

    try {
      const { join } = await import('path');
      const { RoutineManager } = await import('../minebot/routines/RoutineManager.js');
      const { RoutineExecutor } = await import('../minebot/routines/RoutineExecutor.js');
      const { RoutineWrapperTool } = await import('../minebot/routines/RoutineWrapperTool.js');
      const { ManageRoutineTool } = await import('./tools/utility/manageRoutine.js');

      // saves/ はプロジェクトルート基準（dist/ からの相対ではない）
      // cwd がルート or backend/ のどちらでも動くように
      const cwd = process.cwd();
      const routinesDir = cwd.endsWith('backend')
        ? join(cwd, 'saves/minecraft/routines')
        : join(cwd, 'backend/saves/minecraft/routines');
      const manager = new RoutineManager(routinesDir);
      await manager.loadAll();
      this.routineManager = manager;

      const executor = new RoutineExecutor(bot.instantSkills, bot);

      // 各ルーチンをラッパーツールとして登録
      const wrapperTools: StructuredTool[] = manager.getAll().map(
        (def) => new RoutineWrapperTool(def.name, manager, executor),
      );

      // manage-routine ツール（シャノンがルーチンを CRUD する）
      const manageTool = new ManageRoutineTool(manager, executor);
      manageTool.setOnToolRegistered((tool) => {
        if (this.unifiedFca) this.unifiedFca.addTools([tool]);
      });

      this.unifiedFca.addTools([...wrapperTools, manageTool]);

      // FCA と PromptBuilder にルーチン参照を注入（循環参照回避）
      this.unifiedFca.setRoutineManager(manager);

      // Shannon Graph を再構築（SubTaskPlanner + SubTaskExecutor をルーチン依存付きで組込み）
      const { initializeNodes } = await import('./graph/nodeFactory.js');
      // emotionNode は再初期化不要 — 既存 FCA の PromptBuilder から取得不可なので
      // buildShannonGraph に routineManager/routineExecutor を渡して再構築
      this.shannonGraph = buildShannonGraph({
        emotionNode: (this as any)._emotionNode,
        fca: this.unifiedFca,
        routineManager: manager,
        routineExecutor: executor,
      });

      // RoutineRecorder: パターン検知→自動ルーチン生成
      const { RoutineRecorder } = await import('../minebot/routines/RoutineRecorder.js');
      const recorder = RoutineRecorder.init(manager, executor);
      recorder.setOnRoutineCreated((tool) => {
        if (this.unifiedFca) this.unifiedFca.addTools([tool]);
      });

      logger.info(`🔄 Routine tools registered: ${wrapperTools.length} routines + manage-routine + recorder`);
    } catch (e) {
      logger.warn(`⚠ Failed to register routine tools: ${e}`);
    }
  }

  /** RoutineManager への参照（PromptBuilder・FCA から利用） */
  public getRoutineManager(): import('../minebot/routines/RoutineManager.js').RoutineManager | null {
    return this.routineManager;
  }
}
