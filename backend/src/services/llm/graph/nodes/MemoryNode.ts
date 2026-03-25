import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../../../../config/env.js';
import { models } from '../../../../config/models.js';
import { IShannonMemory } from '../../../../models/ShannonMemory.js';
import { createTracedModel } from '../../utils/langfuse.js';
import { TaskContext } from '@shannon/common';
import { IPersonMemory, MemoryPlatform } from '../../../../models/PersonMemory.js';
import {
  PersonMemoryService,
  platformToPrivacyZone,
} from '../../../memory/personMemoryService.js';
import {
  ShannonMemoryService,
  ShannonMemoryInput,
} from '../../../memory/shannonMemoryService.js';
import { EmbeddingService } from '../../../memory/embeddingService.js';
import { IExchange } from '../../../../models/PersonMemory.js';
import {
  resolveMemberByPlatformId,
} from '../../../../config/memberAliases.js';
import { loadPrompt } from '../../config/prompts.js';
import { logger } from '../../../../utils/logger.js';

const SEMANTIC_TOP_K = 5;
const SEMANTIC_RANDOM_N = 2;
const SUMMARIZE_TOKEN_THRESHOLD = 1000;
const AVG_CHARS_PER_TOKEN_JA = 2;

/**
 * MemoryNode に渡す入力
 */
export interface MemoryNodeInput {
  userMessage: string | null;
  context: TaskContext | null;
}

/**
 * MemoryNode の出力 (FunctionCallingAgent に渡す共有状態)
 */
export interface MemoryState {
  person: IPersonMemory | null;
  experiences: IShannonMemory[];
  knowledge: IShannonMemory[];
}

/**
 * postProcess に渡す入力
 */
export interface PostProcessInput {
  context: TaskContext | null;
  /** ユーザーメッセージとシャノンの応答 */
  conversationText: string;
  /** recentExchanges に追加する会話 */
  exchanges: IExchange[];
}

// キーワードパターン (recall-experience をトリガー: キーワード検索)
const EXPERIENCE_PATTERNS = [
  /前に/,
  /あの時/,
  /覚えてる/,
  /思い出/,
  /また.*したい/,
  /前回/,
  /昔/,
  /この前/,
  /初めて/,
];

// 「今日/昨日/最近 何した？」系 (日付ベースで最新の体験を返す)
const RECENT_ACTIVITY_PATTERNS = [
  /今日.*何.*し/,
  /今日.*何してた/,
  /今日.*何した/,
  /今日.*どう/,
  /昨日.*何.*し/,
  /最近.*何.*し/,
  /最近.*どう/,
  /何してた/,
  /何した(の|？|\?|$)/,
  /何やってた/,
  /どうだった/,
  /どうしてた/,
  /何があった/,
];

// キーワードパターン (recall-knowledge をトリガー)
const KNOWLEDGE_PATTERNS = [
  /知ってる？/,
  /知ってますか/,
  /やり方/,
  /方法/,
  /どうやって/,
  /教えて/,
  /仕組み/,
  /って何/,
  /とは？/,
  /なんだっけ/,
];

/**
 * MemoryNode: 記憶ツール呼び出し判断の専用ノード
 *
 * Unified Shannon graph の実行順序:
 * EmotionNode → MemoryNode.preProcess → FunctionCallingAgent → MemoryNode.postProcess
 *
 * preProcess:
 * - recall-person: userId で確実に取得 (常に実行)
 * - recall-experience / recall-knowledge: メッセージ内容からルールベースで判断
 *
 * postProcess:
 * - 会話から体験・知識を抽出して保存 (FCA が save し忘れた分のフォールバック)
 * - 人物特徴の更新 (非同期)
 */
export class MemoryNode {
  private personService: PersonMemoryService;
  private shannonService: ShannonMemoryService;
  private embeddingService: EmbeddingService;
  private model: ChatOpenAI;
  private extractMemoriesPrompt: string | null = null;

  constructor() {
    this.personService = PersonMemoryService.getInstance();
    this.shannonService = ShannonMemoryService.getInstance();
    this.embeddingService = EmbeddingService.getInstance();
    const isGemini = models.contentGeneration.startsWith('gemini');
    const isReasoning = models.contentGeneration.startsWith('gpt-5') || models.contentGeneration.startsWith('o');
    this.model = createTracedModel({
      modelName: models.contentGeneration,
      ...(isReasoning
        ? { modelKwargs: { max_completion_tokens: 4096 } }
        : isGemini
          ? { maxTokens: 8192 }
          : { temperature: 1 }),
      ...(isGemini
        ? {
            timeout: 300000,
            configuration: {
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              apiKey: config.google.geminiApiKey,
            },
            apiKey: config.google.geminiApiKey,
          }
        : { apiKey: config.openaiApiKey }),
    });
  }

  async initialize(): Promise<void> {
    await this.personService.initialize();
    await this.embeddingService.initialize();
    this.extractMemoriesPrompt = await loadPrompt('extract_memories');

    this.scheduleMemoryMaintenance();
  }

  /**
   * 起動時にバックフィル + 24時間毎の consolidation をスケジュール
   */
  private scheduleMemoryMaintenance(): void {
    setTimeout(async () => {
      try {
        const count = await this.shannonService.backfillEmbeddings();
        if (count > 0) {
          await this.embeddingService.loadCache();
        }
      } catch (err) {
        logger.error('❌ MemoryNode backfill エラー:', err);
      }
    }, 10_000);

    const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
      try {
        logger.info('🔄 MemoryNode: 定期 consolidation 開始');
        await this.shannonService.consolidateMemories();
      } catch (err) {
        logger.error('❌ MemoryNode consolidation エラー:', err);
      }
    }, CONSOLIDATION_INTERVAL_MS);
  }

  // ========== preProcess: 会話前 ==========

  /**
   * 会話前に記憶を取得してプロンプト注入用の MemoryState を返す。
   *
   * 1. recall-person: 常に実行
   * 2. Semantic search: 常にユーザーメッセージで embedding 検索 (top-K + random)
   * 3. Regex フォールバック: 「今日何した？」系は日付ベース、パターン一致はキーワード検索
   * 4. 結合・重複排除
   */
  async preProcess(input: MemoryNodeInput): Promise<MemoryState> {
    const state: MemoryState = {
      person: null,
      experiences: [],
      knowledge: [],
    };

    try {
      const { platform, userId, displayName } = this.extractIdentity(input.context);

      // 1. recall-person: 常に実行 (userId ベースで確実)
      if (platform && userId) {
        state.person = await this.personService.getOrCreate(
          platform,
          userId,
          displayName ?? 'Unknown',
        );
        logger.info(`💭 MemoryNode: ${state.person.displayName} の記憶を取得 (traits: ${state.person.traits.length}, interactions: ${state.person.totalInteractions})`);
      }

      if (!input.userMessage) return state;

      // 2. Semantic search: 常に実行
      let semanticResults: IShannonMemory[] = [];
      if (this.embeddingService.cacheSize > 0) {
        try {
          semanticResults = await this.embeddingService.search(
            input.userMessage,
            SEMANTIC_TOP_K,
            SEMANTIC_RANDOM_N,
          );
          if (semanticResults.length > 0) {
            logger.info(`💭 MemoryNode: semantic search で ${semanticResults.length}件を取得`);
          }
        } catch (err) {
          logger.warn(`⚠ MemoryNode semantic search 失敗 (フォールバックへ): ${err}`);
        }
      }

      // 3. Regex フォールバック (semantic で取れなかった場合、または特定パターン)
      let fallbackExperiences: IShannonMemory[] = [];
      let fallbackKnowledge: IShannonMemory[] = [];

      if (isRecentActivityQuestion(input.userMessage)) {
        fallbackExperiences = await this.shannonService.getRecentImportant('experience', 5);
        if (fallbackExperiences.length > 0) {
          logger.info(`💭 MemoryNode: 最近の体験 ${fallbackExperiences.length}件を取得（日付ベース）`);
        }
      } else if (semanticResults.length === 0 && shouldRecallExperience(input.userMessage)) {
        const keywords = extractKeywords(input.userMessage);
        if (keywords) {
          fallbackExperiences = await this.shannonService.searchExperiences(keywords, 3);
        }
      }

      if (semanticResults.length === 0 && shouldRecallKnowledge(input.userMessage)) {
        const keywords = extractKeywords(input.userMessage);
        if (keywords) {
          fallbackKnowledge = await this.shannonService.searchKnowledge(keywords, 3);
        }
      }

      // 4. 結合・重複排除
      const seenIds = new Set<string>();
      const allMemories: IShannonMemory[] = [];
      for (const mem of [...semanticResults, ...fallbackExperiences, ...fallbackKnowledge]) {
        const id = mem._id.toString();
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allMemories.push(mem);
        }
      }

      state.experiences = allMemories.filter((m) => m.category === 'experience');
      state.knowledge = allMemories.filter((m) => m.category === 'knowledge');
    } catch (error) {
      logger.error('❌ MemoryNode preProcess エラー:', error);
    }

    return state;
  }

  // ========== postProcess: 会話後 ==========

  /**
   * 会話後に記憶を抽出・保存し、人物情報を更新する
   */
  async postProcess(input: PostProcessInput): Promise<void> {
    try {
      const { platform, userId, displayName } = this.extractIdentity(input.context);
      const source = platform ?? 'unknown';

      // 1. 会話から体験・知識を抽出して保存
      if (input.conversationText.trim()) {
        this.extractAndSaveMemories(input.conversationText, source).catch(
          (err) => {
            logger.error('❌ MemoryNode 記憶抽出エラー:', err);
          },
        );
      }

      // 2. 人物記憶を更新 (非同期)
      if (platform && userId && input.exchanges.length > 0) {
        this.personService
          .updateAfterConversation(
            platform,
            userId,
            displayName ?? 'Unknown',
            input.exchanges,
          )
          .catch((err) => {
            logger.error('❌ MemoryNode 人物更新エラー:', err);
          });
      }
    } catch (error) {
      logger.error('❌ MemoryNode postProcess エラー:', error);
    }
  }

  /**
   * 会話テキストから体験・知識を抽出して保存
   */
  private async extractAndSaveMemories(
    conversationText: string,
    source: string,
  ): Promise<void> {
    const systemPrompt =
      this.extractMemoriesPrompt ??
      '会話から記憶すべき体験と知識を JSON で抽出してください。';

    const response = await this.model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(conversationText),
    ]);

    const content = response.content.toString().trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.memories || !Array.isArray(parsed.memories)) return;

      for (const memory of parsed.memories) {
        if (!memory.category || !memory.content || !memory.tags) continue;
        if (memory.importance < 4) continue; // 些細なものはスキップ

        const memoryInput: ShannonMemoryInput = {
          category: memory.category,
          content: memory.content,
          feeling: memory.feeling,
          source,
          importance: memory.importance,
          tags: memory.tags,
        };

        const result = await this.shannonService.saveWithDedup(memoryInput);
        if (result.saved) {
          logger.info(`💭 MemoryNode: [${memory.category}] "${memory.content.substring(0, 40)}" を保存`);
        }
      }
    } catch (error) {
      logger.error('❌ MemoryNode extractAndSaveMemories パースエラー:', error);
    }
  }

  // ========== フォーマット ==========

  /**
   * MemoryState をシステムプロンプト注入用の文字列に変換。
   * 記憶が多すぎる場合は LLM で要約する。
   */
  async formatForSystemPrompt(state: MemoryState): Promise<string> {
    const sections: string[] = [];

    if (state.person) {
      sections.push(this.personService.formatForPrompt(state.person));
    }

    let memoryText = this.shannonService.formatForPrompt(
      state.experiences,
      state.knowledge,
    );

    if (memoryText) {
      const estimatedTokens = memoryText.length / AVG_CHARS_PER_TOKEN_JA;
      if (estimatedTokens > SUMMARIZE_TOKEN_THRESHOLD) {
        try {
          memoryText = await this.summarizeMemoryContext(memoryText);
          logger.info(`💭 MemoryNode: 記憶コンテキストを要約 (${Math.round(estimatedTokens)} → ~${Math.round(memoryText.length / AVG_CHARS_PER_TOKEN_JA)} tokens)`);
        } catch (err) {
          logger.warn(`⚠ MemoryNode 記憶要約失敗 (元テキスト使用): ${err}`);
        }
      }
      sections.push(`## ボクの関連する記憶\n${memoryText}`);
    }

    return sections.join('\n\n');
  }

  /**
   * 記憶コンテキストが長すぎる場合に要約する
   */
  private async summarizeMemoryContext(memoryText: string): Promise<string> {
    const { ChatOpenAI } = await import('@langchain/openai');
    const summaryModel = new ChatOpenAI({
      modelName: 'gpt-4.1-mini',
      temperature: 0.3,
      apiKey: config.openaiApiKey,
    });
    const response = await summaryModel.invoke([
      new SystemMessage(
        'シャノン（AI）の長期記憶の一覧が与えられます。' +
        'これを会話で使える簡潔な要約に圧縮してください。' +
        '重要な事実と感情は保持し、冗長な部分を省いてください。' +
        '箇条書き形式で、元のフォーマット（【体験】【知識】）を維持してください。',
      ),
      new HumanMessage(memoryText),
    ]);
    return response.content.toString().trim();
  }

  // ========== ユーティリティ ==========

  /**
   * TaskContext からプラットフォーム情報を抽出
   */
  private extractIdentity(context: TaskContext | null): {
    platform: MemoryPlatform | null;
    userId: string | null;
    displayName: string | null;
  } {
    if (!context) return { platform: null, userId: null, displayName: null };

    if (context.platform === 'discord' && context.discord) {
      return {
        platform: 'discord',
        userId: context.discord.userId ?? null,
        displayName: context.discord.userName ?? null,
      };
    }

    if (context.platform === 'twitter' && context.twitter) {
      return {
        platform: 'twitter',
        userId: context.twitter.authorId ?? context.twitter.authorName ?? null,
        displayName: context.twitter.authorName ?? null,
      };
    }

    if (context.platform === 'youtube' && context.youtube) {
      return {
        platform: 'youtube',
        userId: context.youtube.channelId ?? null,
        displayName: null,
      };
    }

    if (context.platform === 'minebot') {
      return {
        platform: 'minebot',
        userId: (context.metadata?.playerName as string) ?? null,
        displayName: (context.metadata?.playerName as string) ?? null,
      };
    }

    return { platform: null, userId: null, displayName: null };
  }
}

// ========== ヘルパー関数 ==========

function shouldRecallExperience(message: string): boolean {
  return EXPERIENCE_PATTERNS.some((p) => p.test(message));
}

function isRecentActivityQuestion(message: string): boolean {
  return RECENT_ACTIVITY_PATTERNS.some((p) => p.test(message));
}

function shouldRecallKnowledge(message: string): boolean {
  return KNOWLEDGE_PATTERNS.some((p) => p.test(message));
}

/**
 * メッセージからキーワードを抽出 (簡易: 3文字以上の単語を抽出)
 */
function extractKeywords(message: string): string {
  // タイムスタンプとユーザー名を除去
  const cleaned = message.replace(/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\S+:\s*/, '');
  // 短い助詞等を除去、3文字以上を抽出
  const words = cleaned
    .split(/[\s、。？！,.\?!]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 5);
  return words.join(' ');
}
