import {
  ShannonMemory,
  IShannonMemory,
  MemoryCategory,
} from '../../models/ShannonMemory.js';
import { EmbeddingService } from './embeddingService.js';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/** 容量制限 */
const MAX_EXPERIENCES = 500;
const MAX_KNOWLEDGE = 300;
const MAX_AUTONOMY_MEMORIES = 200;
const PROTECTED_IMPORTANCE = 8;
/** 保護記憶のカテゴリ毎上限 */
const MAX_PROTECTED_PER_CATEGORY = 50;
/** Eviction バッチサイズ */
const EVICTION_BATCH_SIZE = 10;
/** Eviction 開始閾値 (上限の90%) */
const EVICTION_TRIGGER_RATIO = 0.9;

/** 体験の重複判定: 24時間以内のみ重複チェック */
const EXPERIENCE_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** jaccard 類似度の閾値 */
const EXPERIENCE_JACCARD_THRESHOLD = 0.5;
const KNOWLEDGE_JACCARD_THRESHOLD = 0.6;

/** Consolidation: 対象日数 */
const CONSOLIDATION_AGE_DAYS = 30;
/** Consolidation: 対象 importance 上限 */
const CONSOLIDATION_MAX_IMPORTANCE = 6;
/** Consolidation: embedding 類似度閾値 (クラスタ化) */
const CONSOLIDATION_SIMILARITY_THRESHOLD = 0.7;

const CATEGORY_LIMITS: Record<MemoryCategory, number> = {
  experience: MAX_EXPERIENCES,
  knowledge: MAX_KNOWLEDGE,
  self_model: MAX_AUTONOMY_MEMORIES,
  strategy_update: MAX_AUTONOMY_MEMORIES,
  internal_state_snapshot: MAX_AUTONOMY_MEMORIES,
  world_pattern: MAX_AUTONOMY_MEMORIES,
};

export interface ShannonMemoryInput {
  category: MemoryCategory;
  content: string;
  feeling?: string;
  context?: string;
  source: string;
  importance: number;
  tags: string[];
}

export interface SaveResult {
  saved: boolean;
  message: string;
}

/**
 * ShannonMemoryService
 *
 * シャノン自身の長期記憶（体験・知識）の保存・検索
 * - 重複チェック付き保存 (体験: 時間ベース、知識: jaccard)
 * - 容量制限と自動削除
 * - 全文検索 + タグ検索
 */
export class ShannonMemoryService {
  private static instance: ShannonMemoryService;

  private constructor() {}

  public static getInstance(): ShannonMemoryService {
    if (!ShannonMemoryService.instance) {
      ShannonMemoryService.instance = new ShannonMemoryService();
    }
    return ShannonMemoryService.instance;
  }

  // ========== 保存 ==========

  /**
   * 重複チェック + 容量制限付き保存
   */
  async saveWithDedup(data: ShannonMemoryInput): Promise<SaveResult> {
    if (data.category === 'experience') {
      return this.saveExperienceWithDedup(data);
    }
    if (data.category === 'knowledge') {
      return this.saveKnowledgeWithDedup(data);
    }
    return this.createWithEviction(data);
  }

  /**
   * 体験の保存 (24時間以内 + タグ類似で重複判定)
   */
  private async saveExperienceWithDedup(
    data: ShannonMemoryInput,
  ): Promise<SaveResult> {
    if (data.tags.length > 0) {
      const candidates = await ShannonMemory.find({
        category: 'experience',
        tags: { $in: data.tags },
        createdAt: {
          $gte: new Date(Date.now() - EXPERIENCE_DEDUP_WINDOW_MS),
        },
      })
        .sort({ createdAt: -1 })
        .limit(5);

      for (const existing of candidates) {
        const similarity = jaccardSimilarity(existing.tags, data.tags);
        if (similarity >= EXPERIENCE_JACCARD_THRESHOLD) {
          // 24時間以内 + タグ類似 → 重複
          if (data.feeling && data.feeling !== existing.feeling) {
            existing.feeling = data.feeling;
            await existing.save();
            return { saved: true, message: '感想を更新したよ' };
          }
          return { saved: false, message: 'もう覚えてるよ！' };
        }
      }
    }

    return this.createWithEviction(data);
  }

  /**
   * 知識の保存 (タグ jaccard で重複判定、時間制限なし)
   */
  private async saveKnowledgeWithDedup(
    data: ShannonMemoryInput,
  ): Promise<SaveResult> {
    if (data.tags.length > 0) {
      const candidates = await ShannonMemory.find({
        category: 'knowledge',
        tags: { $in: data.tags },
      })
        .sort({ createdAt: -1 })
        .limit(10);

      for (const existing of candidates) {
        if (
          jaccardSimilarity(existing.tags, data.tags) >=
          KNOWLEDGE_JACCARD_THRESHOLD
        ) {
          return { saved: false, message: 'もう知ってるよ！' };
        }
      }
    }

    return this.createWithEviction(data);
  }

  /**
   * 容量制限チェック + 作成 + embedding 生成
   */
  private async createWithEviction(
    data: ShannonMemoryInput,
  ): Promise<SaveResult> {
    await this.evictIfNeeded(data.category);

    let embedding: number[] | undefined;
    try {
      const embeddingService = EmbeddingService.getInstance();
      const textForEmbedding = data.feeling
        ? `${data.content} → ${data.feeling}`
        : data.content;
      embedding = await embeddingService.generateEmbedding(textForEmbedding);
    } catch (err) {
      logger.warn(`⚠ embedding 生成失敗 (保存は続行): ${err}`);
    }

    const doc = await ShannonMemory.create({
      ...data,
      embedding,
      createdAt: new Date(),
    });

    if (embedding) {
      const embeddingService = EmbeddingService.getInstance();
      embeddingService.updateCache(doc._id, embedding, data.category, data.content, data.importance);
    }

    return { saved: true, message: '覚えた！' };
  }

  // ========== 検索 ==========

  /**
   * 体験をキーワード検索
   */
  async searchExperiences(
    query: string,
    limit: number = 5,
  ): Promise<IShannonMemory[]> {
    return this.search('experience', query, limit);
  }

  /**
   * 知識をキーワード検索
   */
  async searchKnowledge(
    query: string,
    limit: number = 5,
  ): Promise<IShannonMemory[]> {
    return this.search('knowledge', query, limit);
  }

  /**
   * カテゴリ + キーワードで検索
   * タグ一致 → 全文検索 の順で試行
   */
  private async search(
    category: MemoryCategory,
    query: string,
    limit: number,
  ): Promise<IShannonMemory[]> {
    const keywords = query
      .split(/[\s,、。]+/)
      .filter((k) => k.length > 0);

    if (keywords.length === 0) {
      // キーワードなし: 重要度 + 日時で最新を返す
      return ShannonMemory.find({ category })
        .sort({ importance: -1, createdAt: -1 })
        .limit(limit)
        .lean();
    }

    // 1. タグ一致で検索
    const tagResults = await ShannonMemory.find({
      category,
      tags: { $in: keywords },
    })
      .sort({ importance: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    if (tagResults.length >= limit) {
      return tagResults;
    }

    // 2. 全文検索で補完
    try {
      const textResults = await ShannonMemory.find(
        {
          category,
          $text: { $search: keywords.join(' ') },
        },
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .lean();

      // タグ結果と全文結果をマージ (重複除去)
      const seen = new Set(tagResults.map((r) => r._id.toString()));
      const merged = [...tagResults];
      for (const r of textResults) {
        if (!seen.has(r._id.toString())) {
          merged.push(r);
          if (merged.length >= limit) break;
        }
      }
      return merged;
    } catch {
      // text index がまだ作られていない場合はタグ結果のみ返す
      return tagResults;
    }
  }

  /**
   * 直近 + 重要な記憶を取得 (MemoryNode preProcess 用)
   */
  async getRecentImportant(
    category: MemoryCategory,
    limit: number = 5,
  ): Promise<IShannonMemory[]> {
    return ShannonMemory.find({
      category,
      importance: { $gte: 5 },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  // ========== 容量制限 ==========

  /**
   * 容量制限チェック。閾値超過時はバッチ削除。
   * 保護記憶 (importance >= 8) が上限を超えた場合も最古を削除。
   */
  private async evictIfNeeded(category: MemoryCategory): Promise<void> {
    const maxLimit = CATEGORY_LIMITS[category] ?? MAX_AUTONOMY_MEMORIES;
    const count = await ShannonMemory.countDocuments({ category });
    const triggerAt = Math.floor(maxLimit * EVICTION_TRIGGER_RATIO);

    if (count < triggerAt) return;

    const embeddingService = EmbeddingService.getInstance();
    const toEvict = Math.min(EVICTION_BATCH_SIZE, count - triggerAt + EVICTION_BATCH_SIZE);

    const evicted = await ShannonMemory.find(
      { category, importance: { $lt: PROTECTED_IMPORTANCE } },
    )
      .sort({ importance: 1, createdAt: 1 })
      .limit(toEvict)
      .lean();

    if (evicted.length > 0) {
      const ids = evicted.map((e) => e._id);
      await ShannonMemory.deleteMany({ _id: { $in: ids } });
      for (const e of evicted) {
        embeddingService.removeFromCache(e._id.toString());
      }
      logger.info(`🗑 ShannonMemory eviction [${category}]: ${evicted.length}件削除`);
    }

    const protectedCount = await ShannonMemory.countDocuments({
      category,
      importance: { $gte: PROTECTED_IMPORTANCE },
    });
    if (protectedCount > MAX_PROTECTED_PER_CATEGORY) {
      const excess = protectedCount - MAX_PROTECTED_PER_CATEGORY;
      const oldProtected = await ShannonMemory.find({
        category,
        importance: { $gte: PROTECTED_IMPORTANCE },
      })
        .sort({ createdAt: 1 })
        .limit(excess)
        .lean();
      if (oldProtected.length > 0) {
        const ids = oldProtected.map((e) => e._id);
        await ShannonMemory.deleteMany({ _id: { $in: ids } });
        for (const e of oldProtected) {
          embeddingService.removeFromCache(e._id.toString());
        }
        logger.info(`🗑 ShannonMemory protected eviction [${category}]: ${oldProtected.length}件削除 (上限${MAX_PROTECTED_PER_CATEGORY}超過)`);
      }
    }
  }

  // ========== フォーマット ==========

  /**
   * 記憶をプロンプト注入用の文字列に変換
   */
  formatForPrompt(
    experiences: IShannonMemory[],
    knowledge: IShannonMemory[],
  ): string {
    const lines: string[] = [];

    if (experiences.length > 0) {
      lines.push('【体験】');
      for (const exp of experiences) {
        const date = exp.createdAt.toLocaleDateString('ja-JP', {
          month: 'numeric',
          day: 'numeric',
        });
        const feeling = exp.feeling ? ` → ${exp.feeling}` : '';
        lines.push(`- [${date}] ${exp.content}${feeling}`);
      }
    }

    if (knowledge.length > 0) {
      lines.push('【知識】');
      for (const k of knowledge) {
        lines.push(`- ${k.content}`);
      }
    }

    return lines.join('\n');
  }
  // ========== Consolidation (記憶の要約統合) ==========

  /**
   * 古い低重要度の記憶を embedding 類似度でクラスタ化し、LLM で要約統合する。
   * 定期実行 or 手動呼び出し。
   */
  async consolidateMemories(): Promise<{ clustersProcessed: number; memoriesRemoved: number }> {
    const cutoff = new Date(Date.now() - CONSOLIDATION_AGE_DAYS * 24 * 60 * 60 * 1000);
    const embeddingService = EmbeddingService.getInstance();

    let totalClusters = 0;
    let totalRemoved = 0;

    for (const category of ['experience', 'knowledge'] as MemoryCategory[]) {
      const candidates = await ShannonMemory.find({
        category,
        importance: { $lte: CONSOLIDATION_MAX_IMPORTANCE },
        createdAt: { $lt: cutoff },
        embedding: { $exists: true, $ne: [] },
      })
        .select('+embedding')
        .sort({ createdAt: 1 })
        .lean();

      if (candidates.length < 3) continue;

      const clusters = this.clusterBySimilarity(candidates, CONSOLIDATION_SIMILARITY_THRESHOLD);

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;

        const maxImportance = Math.max(...cluster.map((m) => m.importance));
        const contentList = cluster.map((m) => {
          const feeling = m.feeling ? ` → ${m.feeling}` : '';
          return `- ${m.content}${feeling}`;
        });

        const { ChatOpenAI } = await import('@langchain/openai');
        const { SystemMessage, HumanMessage } = await import('@langchain/core/messages');
        const model = new ChatOpenAI({
          modelName: 'gpt-4.1-mini',
          temperature: 0.3,
          apiKey: config.openaiApiKey,
        });

        const response = await model.invoke([
          new SystemMessage(
            'あなたはシャノン（AI）の記憶管理アシスタントです。複数の関連する記憶を1つの簡潔な要約に統合してください。' +
            '体験(experience)の場合は「何が起きたか」と「どう感じたか」を含めてください。' +
            '知識(knowledge)の場合は事実を簡潔にまとめてください。' +
            '出力は統合後の記憶テキスト1文のみ。前置き不要。',
          ),
          new HumanMessage(`カテゴリ: ${category}\n\n統合対象:\n${contentList.join('\n')}`),
        ]);

        const summarizedContent = response.content.toString().trim();
        if (!summarizedContent) continue;

        const allTags = [...new Set(cluster.flatMap((m) => m.tags))].slice(0, 5);

        let newEmbedding: number[] | undefined;
        try {
          newEmbedding = await embeddingService.generateEmbedding(summarizedContent);
        } catch { /* proceed without embedding */ }

        const newDoc = await ShannonMemory.create({
          category,
          content: summarizedContent,
          feeling: category === 'experience'
            ? cluster.map((m) => m.feeling).filter(Boolean).join('、') || undefined
            : undefined,
          source: 'consolidation',
          importance: maxImportance,
          tags: allTags,
          embedding: newEmbedding,
          createdAt: new Date(),
        });

        if (newEmbedding) {
          embeddingService.updateCache(newDoc._id, newEmbedding, category, summarizedContent, maxImportance);
        }

        const oldIds = cluster.map((m) => m._id);
        await ShannonMemory.deleteMany({ _id: { $in: oldIds } });
        for (const m of cluster) {
          embeddingService.removeFromCache(m._id.toString());
        }

        totalClusters++;
        totalRemoved += cluster.length - 1;
        logger.info(`🔄 Consolidation [${category}]: ${cluster.length}件 → 1件 "${summarizedContent.substring(0, 50)}"`);
      }
    }

    if (totalClusters > 0) {
      logger.info(`🔄 Consolidation 完了: ${totalClusters}クラスタ処理, ${totalRemoved}件削減`);
    }
    return { clustersProcessed: totalClusters, memoriesRemoved: totalRemoved };
  }

  /**
   * embedding 類似度でメモリをクラスタ化
   */
  private clusterBySimilarity(
    memories: IShannonMemory[],
    threshold: number,
  ): IShannonMemory[][] {
    const assigned = new Set<string>();
    const clusters: IShannonMemory[][] = [];

    for (let i = 0; i < memories.length; i++) {
      const id = memories[i]._id.toString();
      if (assigned.has(id)) continue;

      const cluster: IShannonMemory[] = [memories[i]];
      assigned.add(id);

      for (let j = i + 1; j < memories.length; j++) {
        const jId = memories[j]._id.toString();
        if (assigned.has(jId)) continue;
        if (!memories[i].embedding || !memories[j].embedding) continue;

        const sim = cosineSim(memories[i].embedding!, memories[j].embedding!);
        if (sim >= threshold) {
          cluster.push(memories[j]);
          assigned.add(jId);
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  // ========== Backfill ==========

  /**
   * embedding が未生成の記憶にバックフィルする
   */
  async backfillEmbeddings(batchSize: number = 20): Promise<number> {
    const embeddingService = EmbeddingService.getInstance();

    const unembedded = await ShannonMemory.find({
      $or: [{ embedding: { $exists: false } }, { embedding: [] }, { embedding: null }],
    }).lean();

    if (unembedded.length === 0) {
      logger.info('🧠 Backfill: 全記憶に embedding 済み');
      return 0;
    }

    logger.info(`🧠 Backfill 開始: ${unembedded.length}件`);
    let processed = 0;

    for (let i = 0; i < unembedded.length; i += batchSize) {
      const batch = unembedded.slice(i, i + batchSize);
      const texts = batch.map((m) =>
        m.feeling ? `${m.content} → ${m.feeling}` : m.content,
      );

      try {
        const embeddings = await embeddingService.generateEmbeddings(texts);
        for (let j = 0; j < batch.length; j++) {
          await ShannonMemory.updateOne(
            { _id: batch[j]._id },
            { $set: { embedding: embeddings[j] } },
          );
          embeddingService.updateCache(
            batch[j]._id,
            embeddings[j],
            batch[j].category,
            batch[j].content,
            batch[j].importance,
          );
        }
        processed += batch.length;
        logger.info(`🧠 Backfill: ${processed}/${unembedded.length} 完了`);
      } catch (err) {
        logger.error(`❌ Backfill バッチエラー (offset ${i}):`, err);
      }
    }

    return processed;
  }
}

// ========== ユーティリティ ==========

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Jaccard 類似度
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
