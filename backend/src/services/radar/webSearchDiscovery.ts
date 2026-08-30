import { createHash } from 'node:crypto';
import type { RawRadarCandidate } from './radarDiscovery.js';
import { customSearch, type CustomSearchPort } from '../search/customSearch.js';

const OWNER = /^line:[a-f0-9]{64}$/;
/** Public Web discovery for Radar. Search time is labeled explicitly and never represented as publication time evidence. */
export class WebSearchDiscovery {
  constructor(private readonly port: CustomSearchPort, private readonly now = Date.now) {}
  async find(owner: string, query: string, limit: number, signal: AbortSignal): Promise<readonly RawRadarCandidate[]> {
    if (!OWNER.test(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('WEB_DISCOVERY_POLICY_INVALID');
    const fetchedAt = this.now();
    const rows = await customSearch(this.port, query, Math.min(limit, 5), signal);
    return Object.freeze(rows.map(row => Object.freeze({ source: 'web' as const,
      externalId: createHash('sha256').update(row.url).digest('hex'), title: row.title, fact: row.snippet, url: row.url,
      publishedAt: fetchedAt, metadata: Object.freeze(['公開日時不明', 'Web検索で取得']) })));
  }
}
