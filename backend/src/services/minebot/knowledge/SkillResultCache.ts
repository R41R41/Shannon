/**
 * クエリ系スキルの結果をTTL付きキャッシュする。
 * ボットの位置が大きく変わった場合はキャッシュを無効化する。
 */
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:SkillCache');

interface CacheEntry {
  result: { success: boolean; result: string; duration?: number };
  position: { x: number; y: number; z: number };
  createdAt: number;
  ttlMs: number;
}

const CACHEABLE_SKILLS: Record<string, number> = {
  'find-blocks': 30000,
  'get-blocks-in-area': 20000,
  'list-nearby-entities': 5000,
  'check-recipe': 60000,
  'get-time-and-weather': 10000,
  'is-block-loaded': 15000,
};

const POSITION_INVALIDATION_DISTANCE = 10;

export class SkillResultCache {
  private cache = new Map<string, CacheEntry>();
  private lastCleanup = Date.now();

  private makeKey(skillName: string, args: string[], serverId: string): string {
    return `${serverId}:${skillName}:${args.join(',')}`;
  }

  private distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  isCacheable(skillName: string): boolean {
    return skillName in CACHEABLE_SKILLS;
  }

  get(skillName: string, args: string[], currentPos: { x: number; y: number; z: number }, serverId: string): CacheEntry['result'] | null {
    if (!serverId) return null;
    if (Date.now() - this.lastCleanup > 60000) this.cleanup();

    const key = this.makeKey(skillName, args, serverId);
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    if (this.distance(currentPos, entry.position) > POSITION_INVALIDATION_DISTANCE) {
      this.cache.delete(key);
      return null;
    }

    log.debug(`キャッシュヒット: ${skillName}(${args.join(',')}) [${Math.round((Date.now() - entry.createdAt) / 1000)}s前]`);
    return entry.result;
  }

  set(skillName: string, args: string[], result: CacheEntry['result'], currentPos: { x: number; y: number; z: number }, serverId: string): void {
    if (!serverId) return;
    const ttlMs = CACHEABLE_SKILLS[skillName];
    if (!ttlMs) return;
    const key = this.makeKey(skillName, args, serverId);
    this.cache.set(key, { result, position: currentPos, createdAt: Date.now(), ttlMs });
  }

  invalidateAll(): void {
    this.cache.clear();
    log.debug('キャッシュ全クリア');
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttlMs) this.cache.delete(key);
    }
    this.lastCleanup = now;
  }

  getStats(): { size: number; skills: Record<string, number> } {
    const skills: Record<string, number> = {};
    for (const key of this.cache.keys()) {
      const skill = key.split(':')[0];
      skills[skill] = (skills[skill] || 0) + 1;
    }
    return { size: this.cache.size, skills };
  }
}
