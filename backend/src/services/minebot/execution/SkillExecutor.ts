/**
 * カテゴリベースの並列スキル実行エンジン。
 * クエリ系スキルは常に即座に実行し、
 * 移動・採掘・戦闘など排他的なスキルはロックで制御する。
 */
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:SkillExecutor');

/** ロック取得の最大待機時間 (ms) — スキル側タイムアウトの補助ガード */
const ACQUIRE_TIMEOUT_MS = 30_000;

export type SkillCategory = 'query' | 'movement' | 'mining' | 'combat' | 'interaction' | 'other';

const CATEGORY_LOCKS: Record<SkillCategory, SkillCategory[]> = {
  query: [],
  movement: ['movement', 'mining'],
  mining: ['movement', 'mining'],
  combat: ['movement', 'mining', 'combat', 'interaction'],
  interaction: ['combat'],
  other: [],
};

const SKILL_CATEGORIES: Record<string, SkillCategory> = {
  'get-position': 'query', 'get-health': 'query', 'get-bot-status': 'query',
  'get-time-and-weather': 'query', 'list-inventory-items': 'query',
  'get-equipment': 'query', 'list-nearby-entities': 'query',
  'check-inventory-item': 'query', 'get-block-at': 'query',
  'get-block-in-sight': 'query', 'get-blocks-in-area': 'query',
  'find-blocks': 'query', 'find-nearest-entity': 'query',
  'check-recipe': 'query', 'check-path-to': 'query',
  'is-block-loaded': 'query', 'investigate-terrain': 'query',
  'can-dig-block': 'query', 'get-entity-look-direction': 'query',
  'get-advancements': 'query', 'check-container': 'query',
  'check-furnace': 'query',

  'move-to': 'movement', 'follow-entity': 'movement', 'flee-from': 'movement',
  'jump': 'movement', 'stop-movement': 'movement', 'look-at': 'movement',
  'enter-portal': 'movement',

  'dig-block-at': 'mining', 'stair-mine': 'mining', 'fill-area': 'mining',

  'attack-nearest': 'combat', 'attack-continuously': 'combat',
  'combat': 'combat', 'swing-arm': 'combat',

  'place-block-at': 'interaction', 'activate-block': 'interaction',
  'use-item': 'interaction', 'use-item-on-block': 'interaction',
  'craft-one': 'interaction', 'start-smelting': 'interaction',
  'trade-with-villager': 'interaction', 'sleep-in-bed': 'interaction',
  'chat': 'other',
};

export class SkillExecutor {
  private activeLocks = new Set<SkillCategory>();
  private waitQueue: Array<{ category: SkillCategory; resolve: () => void }> = [];

  getCategory(skillName: string): SkillCategory {
    return SKILL_CATEGORIES[skillName] || 'other';
  }

  canExecute(skillName: string): boolean {
    const category = this.getCategory(skillName);
    if (category === 'query') return true;
    const conflicts = CATEGORY_LOCKS[category];
    return !conflicts.some((c) => this.activeLocks.has(c));
  }

  async acquire(skillName: string): Promise<() => void> {
    const category = this.getCategory(skillName);

    if (category === 'query') {
      return () => {};
    }

    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

    while (!this.canExecute(skillName)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log.warn(`ロック取得タイムアウト (${ACQUIRE_TIMEOUT_MS}ms): ${category} (${skillName}) — activeLocks: [${[...this.activeLocks].join(', ')}]`);
        throw new Error(`Skill lock acquisition timed out for ${skillName} (category: ${category})`);
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // タイムアウト時に waitQueue から自身を除去して reject
          const idx = this.waitQueue.findIndex((e) => e.resolve === resolve);
          if (idx !== -1) this.waitQueue.splice(idx, 1);
          reject(new Error(`Skill lock acquisition timed out for ${skillName} (category: ${category})`));
        }, remaining);

        this.waitQueue.push({
          category,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    }

    this.activeLocks.add(category);
    log.debug(`ロック取得: ${category} (${skillName})`);

    return () => {
      this.activeLocks.delete(category);
      log.debug(`ロック解放: ${category} (${skillName})`);
      this.processWaitQueue();
    };
  }

  private processWaitQueue(): void {
    const remaining: typeof this.waitQueue = [];
    for (const entry of this.waitQueue) {
      const conflicts = CATEGORY_LOCKS[entry.category];
      if (!conflicts.some((c) => this.activeLocks.has(c))) {
        entry.resolve();
      } else {
        remaining.push(entry);
      }
    }
    this.waitQueue = remaining;
  }

  getStatus(): { activeLocks: string[]; waitQueue: number } {
    return {
      activeLocks: Array.from(this.activeLocks),
      waitQueue: this.waitQueue.length,
    };
  }
}
