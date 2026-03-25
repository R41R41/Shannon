/**
 * CodeSemanticIndex — ソースコードの embedding ベースの意味検索。
 *
 * Cursor の SemanticSearch 相当。
 * 初回検索時に backend/src 配下の .ts ファイルを走査し、
 * ファイルパス + 先頭80行を text-embedding-3-small でバッチ embedding。
 * 以降はクエリ embedding との cosine similarity で高速検索。
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { createLogger } from '../../../../../utils/logger.js';

const log = createLogger('SelfImprove:SemanticIndex');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const SUMMARY_LINES = 80;
const MAX_BATCH = 100;
const INDEX_TTL_MS = 30 * 60_000; // 30 分で再インデックス
const TOP_K_DEFAULT = 10;

interface ChunkEntry {
    relPath: string;
    summary: string;
    embedding: number[];
}

let indexCache: ChunkEntry[] = [];
let indexTimestamp = 0;

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

async function collectTsFiles(dir: string, root: string): Promise<string[]> {
    const { execSync } = await import('node:child_process');
    const cmd = `find ${JSON.stringify(dir)} -path '*/node_modules' -prune -o -path '*/dist' -prune -o -path '*/.git' -prune -o \\( -name '*.ts' -o -name '*.tsx' \\) -print 2>/dev/null`;
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 });
    return out.trim().split('\n').filter(Boolean).map(p => relative(root, p).replace(/\\/g, '/'));
}

async function buildSummary(relPath: string, root: string): Promise<string> {
    try {
        const content = await readFile(join(root, relPath), 'utf-8');
        const lines = content.split('\n').slice(0, SUMMARY_LINES);
        return `${relPath}\n${lines.join('\n')}`;
    } catch {
        return relPath;
    }
}

async function batchEmbed(texts: string[]): Promise<number[][]> {
    const OpenAI = (await import('openai')).default;
    const { config } = await import('../../../../../config/env.js');
    const openai = new OpenAI({ apiKey: config.openaiApiKey });

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH);
        const resp = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: batch,
            dimensions: EMBEDDING_DIMENSIONS,
        });
        const sorted = resp.data.sort((a, b) => a.index - b.index);
        results.push(...sorted.map(d => d.embedding));
    }
    return results;
}

async function ensureIndex(): Promise<void> {
    if (indexCache.length > 0 && Date.now() - indexTimestamp < INDEX_TTL_MS) return;

    const root = getBackendRoot();
    const srcDir = join(root, 'src');
    log.info('🔍 SemanticIndex: インデックス構築中...');

    const files = await collectTsFiles(srcDir, root);
    log.info(`📁 ${files.length} ファイルを検出`);

    const summaries = await Promise.all(files.map(f => buildSummary(f, root)));
    const embeddings = await batchEmbed(summaries);

    indexCache = files.map((relPath, i) => ({
        relPath,
        summary: summaries[i].slice(0, 200),
        embedding: embeddings[i],
    }));
    indexTimestamp = Date.now();

    log.info(`✅ SemanticIndex: ${indexCache.length} チャンクをインデックス化`);
}

/**
 * 意味ベースのコード検索。
 * クエリ文を embedding 化し、インデックス済みファイルとの cosine similarity で上位を返す。
 */
export async function semanticSearchCode(
    query: string,
    topK: number = TOP_K_DEFAULT,
): Promise<Array<{ path: string; similarity: number; preview: string }>> {
    await ensureIndex();

    const [queryEmbedding] = await batchEmbed([query]);

    const scored = indexCache.map(entry => ({
        path: entry.relPath,
        similarity: cosineSimilarity(queryEmbedding, entry.embedding),
        preview: entry.summary,
    }));

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
