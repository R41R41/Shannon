/**
 * Public Knowledge Loader
 *
 * Loads structured knowledge from public_knowledge.json and provides
 * simple keyword-based retrieval for web channel RAG injection.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface KnowledgeEntry {
  category: string;
  content: string;
  tags: string[];
}

interface KnowledgeData {
  entries: KnowledgeEntry[];
}

let knowledgeCache: KnowledgeData | null = null;

function getKnowledge(): KnowledgeData {
  if (knowledgeCache) return knowledgeCache;

  try {
    const filePath = join(__dirname, '../../../../src/data/public_knowledge.json');
    const raw = readFileSync(filePath, 'utf-8');
    knowledgeCache = JSON.parse(raw) as KnowledgeData;
  } catch {
    knowledgeCache = { entries: [] };
  }

  return knowledgeCache;
}

/**
 * Simple keyword matching to find relevant knowledge entries.
 * Returns a formatted string for injection into memoryPrompt.
 */
export function loadPublicKnowledge(userQuery: string, maxEntries = 6): string {
  const knowledge = getKnowledge();
  if (knowledge.entries.length === 0) return '';

  const query = userQuery.toLowerCase();

  // Score each entry by keyword relevance
  const scored = knowledge.entries.map((entry) => {
    let score = 0;
    const content = entry.content.toLowerCase();
    const tags = entry.tags.join(' ').toLowerCase();

    // Tag matching (high weight)
    for (const tag of entry.tags) {
      if (query.includes(tag.toLowerCase())) score += 3;
    }

    // Content keyword matching
    const queryWords = query.split(/[\s、。？！,.?!]+/).filter((w) => w.length >= 2);
    for (const word of queryWords) {
      if (content.includes(word)) score += 2;
      if (tags.includes(word)) score += 1;
    }

    // Category matching
    if (query.includes('シャノン') || query.includes('shannon')) {
      if (entry.category.includes('shannon')) score += 2;
    }
    if (query.includes('アイマイラボ') || query.includes('aiminelab') || query.includes('ラボ')) {
      if (entry.category.includes('aiminelab')) score += 2;
    }
    if (query.includes('仕組み') || query.includes('アーキテクチャ') || query.includes('技術')) {
      if (entry.category.includes('architecture') || entry.category.includes('tech')) score += 2;
    }
    if (query.includes('メンバー') || query.includes('ライ') || query.includes('グリコ') || query.includes('ヤミー')) {
      if (entry.category.includes('member')) score += 2;
    }
    if (query.includes('感情')) {
      if (entry.tags.includes('emotion') || entry.tags.includes('plutchik')) score += 3;
    }
    if (query.includes('記憶') || query.includes('メモリ')) {
      if (entry.tags.includes('memory')) score += 3;
    }

    // Baseline: always include overview entries with a small score
    if (entry.category === 'about_aiminelab' || entry.category === 'member_shannon') {
      score = Math.max(score, 1);
    }

    return { entry, score };
  });

  // Sort by score and take top entries
  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries);

  if (relevant.length === 0) {
    // Always return at least the basic knowledge
    const basics = knowledge.entries
      .filter((e) => e.category === 'about_aiminelab' || e.category === 'member_shannon' || e.category === 'shannon_personality')
      .slice(0, 3);
    if (basics.length === 0) return '';
    return formatKnowledge(basics);
  }

  return formatKnowledge(relevant.map((s) => s.entry));
}

function formatKnowledge(entries: KnowledgeEntry[]): string {
  const items = entries.map((e) => `- ${e.content}`).join('\n');
  return `## シャノンの知識ベース（公開情報）\n以下はシャノン自身やアイマイラボについての事実です。質問に答える際に参考にしてください。\n${items}`;
}
