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
const CATEGORY_RESOURCES: Record<SkillCategory, string[]> = {
  query: [], movement: ['locomotion', 'look'], mining: ['locomotion', 'look', 'hand'],
  combat: ['locomotion', 'look', 'hand', 'window'],
  interaction: ['locomotion', 'look', 'hand', 'window'],
  other: ['locomotion', 'look', 'hand', 'window'],
};

const SKILL_CATEGORIES: Record<string, SkillCategory> = {
  'auto-update-state': 'query', 'auto-update-looking-at': 'query', 'auto-detect-block-or-entity': 'query',
  'auto-face-nearest-entity': 'movement', 'auto-face-moved-entity': 'movement', 'auto-face-speaker': 'movement',
  'auto-face-updated-block': 'movement', 'auto-swim': 'movement', 'auto-follow': 'movement',
  'auto-eat': 'interaction', 'auto-shield': 'interaction', 'auto-equip-weapon': 'interaction', 'auto-wear-armor': 'interaction',
  'get-position': 'query', 'get-health': 'query', 'get-bot-status': 'query',
  'get-time-and-weather': 'query', 'list-inventory-items': 'query',
  'get-equipment': 'query', 'list-nearby-entities': 'query',
  'check-inventory-item': 'query', 'get-block-at': 'query',
  'get-block-in-sight': 'query', 'get-blocks-in-area': 'query',
  'find-blocks': 'query', 'recall-places': 'query', 'find-dry-footholds': 'query', 'find-placeable-spot': 'query', 'find-nearest-entity': 'query',
  'check-recipe': 'query', 'check-path-to': 'query',
  'is-block-loaded': 'query',
  'can-dig-block': 'query', 'get-entity-look-direction': 'query',
  'get-advancements': 'query',
  // These reads open a real container window and move the bot's look/hand.
  'check-container': 'interaction', 'check-furnace': 'interaction',
  'get-background-jobs': 'query',

  'move-to': 'movement', 'follow-entity': 'movement', 'flee-from': 'movement', 'leave-water': 'movement',
  'jump': 'movement', 'stop-movement': 'movement', 'look-at': 'movement',
  'enter-portal': 'movement',

  'dig-block-at': 'mining', 'stair-mine': 'mining', 'fill-area': 'mining',
  'mine-block': 'mining', 'build-structure': 'mining', 'dig-shelter': 'mining',

  'attack-nearest': 'combat', 'attack-continuously': 'combat',
  'combat': 'combat', 'swing-arm': 'combat',

  'place-block-at': 'interaction', 'activate-block': 'interaction',
  'use-item': 'interaction', 'use-item-on-block': 'interaction', 'use-item-on-entity': 'interaction', 'build-around-self': 'interaction',
  'craft-one': 'interaction', 'start-smelting': 'interaction',
  'trade-with-villager': 'interaction', 'sleep-in-bed': 'interaction',
  'chat': 'query', 'wait-time': 'query', 'set-movement-pace': 'query', 'accept-threat': 'query',
};
export function skillCategory(skillName: string): SkillCategory { return SKILL_CATEGORIES[skillName] ?? 'other'; }

export class SkillExecutor {
  private activeLocks = new Map<symbol, SkillCategory>();
  private waitQueue: Array<{ category: SkillCategory; priority: number; grant: () => void }> = [];

  private conflicts(a: SkillCategory, b: SkillCategory): boolean {
    if (a === 'query' || b === 'query') return false;
    // Unknown/composite skills must not evade physical ownership. Known query
    // skills remain concurrent. Conflicts are symmetric and include self.
    return a === b || a === 'other' || b === 'other'
      || CATEGORY_RESOURCES[a].some(resource => CATEGORY_RESOURCES[b].includes(resource))
      || CATEGORY_LOCKS[a].includes(b) || CATEGORY_LOCKS[b].includes(a);
  }

  resourcesFor(skillName: string): string[] { return [...CATEGORY_RESOURCES[this.getCategory(skillName)]]; }

  private available(category: SkillCategory): boolean {
    return ![...this.activeLocks.values()].some(active => this.conflicts(category, active));
  }

  getCategory(skillName: string): SkillCategory {
    return skillCategory(skillName);
  }

  canExecute(skillName: string): boolean {
    const category = this.getCategory(skillName);
    if (category === 'query') return true;
    return this.available(category);
  }

  async acquire(skillName: string, signal?: AbortSignal, priority = 0): Promise<() => void> {
    const category = this.getCategory(skillName);

    if (category === 'query') {
      return () => {};
    }

    if (signal?.aborted) throw new Error('Skill acquisition interrupted');
    const own = (): (() => void) => {
      const id = Symbol(skillName);
      this.activeLocks.set(id, category);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.activeLocks.delete(id);
        this.processWaitQueue();
      };
    };
    if (this.available(category) && this.waitQueue.length === 0) return own();
    return new Promise<() => void>((resolve, reject) => {
      const remove = () => {
        const index = this.waitQueue.indexOf(entry);
        if (index >= 0) this.waitQueue.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        remove();
        reject(new Error('Skill acquisition interrupted'));
        this.processWaitQueue();
      };
      const entry = { category, priority, grant: () => { remove(); resolve(own()); } };
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Skill lock acquisition timed out for ${skillName} (category: ${category})`));
        this.processWaitQueue();
      }, ACQUIRE_TIMEOUT_MS);
      this.waitQueue.push(entry);
      this.waitQueue.sort((a, b) => b.priority - a.priority); // stable FIFO within a priority
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private processWaitQueue(): void {
    // Reserve synchronously, before waking the waiter. Do not wake several
    // conflicting waiters and let them race a Set.add in a later microtask.
    for (const entry of [...this.waitQueue]) {
      if (this.available(entry.category)) entry.grant();
      else break; // FIFO for physical actions; queries never enter this queue.
    }
  }

  getStatus(): { activeLocks: string[]; waitQueue: number } {
    return {
      activeLocks: [...this.activeLocks.values()],
      waitQueue: this.waitQueue.length,
    };
  }
}
