/**
 * スキル依存関係グラフ。
 * LLM がタスク計画を立てる際に、スキル間の前提条件を理解するために使用。
 *
 * requires: このスキルを実行する前に必要なスキル
 * provides: このスキルが実行後に提供する能力/リソース
 * category: スキルのカテゴリ（LLM のプランニング支援用）
 */

export interface SkillDependency {
  requires?: string[];
  provides?: string[];
  category: SkillCategory;
  estimatedDurationSec?: number;
}

export type SkillCategory =
  | 'query'
  | 'movement'
  | 'mining'
  | 'crafting'
  | 'combat'
  | 'farming'
  | 'inventory'
  | 'interaction'
  | 'utility';

export const SKILL_DEPENDENCIES: Record<string, SkillDependency> = {
  // === クエリ系 (前提なし、即座に実行可能) ===
  'get-position': { category: 'query', estimatedDurationSec: 1 },
  'get-health': { category: 'query', estimatedDurationSec: 1 },
  'get-bot-status': { category: 'query', estimatedDurationSec: 1 },
  'get-time-and-weather': { category: 'query', estimatedDurationSec: 1 },
  'list-inventory-items': { category: 'query', estimatedDurationSec: 1 },
  'get-equipment': { category: 'query', estimatedDurationSec: 1 },
  'list-nearby-entities': { category: 'query', estimatedDurationSec: 1 },
  'check-inventory-item': { category: 'query', estimatedDurationSec: 1 },
  'get-block-at': { category: 'query', estimatedDurationSec: 1 },
  'get-block-in-sight': { category: 'query', estimatedDurationSec: 1 },
  'get-blocks-in-area': { category: 'query', estimatedDurationSec: 2 },
  'find-blocks': { category: 'query', estimatedDurationSec: 2 },
  'find-placeable-spot': {
    category: 'query',
    estimatedDurationSec: 2,
    provides: ['placeable-coordinates'],
  },
  'find-nearest-entity': { category: 'query', estimatedDurationSec: 1 },
  'check-recipe': { category: 'query', estimatedDurationSec: 1 },
  'check-path-to': { category: 'query', estimatedDurationSec: 2 },
  'is-block-loaded': { category: 'query', estimatedDurationSec: 1 },
  // 'investigate-terrain': disabled — find-blocks + get-blocks-in-area で代替

  'can-dig-block': { category: 'query', estimatedDurationSec: 1 },
  'get-entity-look-direction': { category: 'query', estimatedDurationSec: 1 },
  'get-advancements': { category: 'query', estimatedDurationSec: 1 },

  // === 移動系 ===
  'move-to': { category: 'movement', estimatedDurationSec: 30, provides: ['at-target'] },
  'follow-entity': { category: 'movement', estimatedDurationSec: 60 },
  'flee-from': { category: 'movement', estimatedDurationSec: 10 },
  'jump': { category: 'movement', estimatedDurationSec: 1 },
  'tower-up': {
    category: 'movement',
    estimatedDurationSec: 10,
    requires: ['list-inventory-items'],
    provides: ['elevated-position'],
  },
  'stop-movement': { category: 'movement', estimatedDurationSec: 1 },
  'look-at': { category: 'movement', estimatedDurationSec: 1 },
  'set-sneak': { category: 'movement', estimatedDurationSec: 1 },
  'set-sprint': { category: 'movement', estimatedDurationSec: 1 },
  'enter-portal': { category: 'movement', estimatedDurationSec: 10, provides: ['in-nether'] },

  // === 採掘系 ===
  'dig-block-at': {
    category: 'mining',
    estimatedDurationSec: 5,
    provides: ['block-mined'],
  },
  'mine-block': {
    category: 'mining',
    estimatedDurationSec: 30,
    provides: ['block-mined'],
  },
  'stair-mine': {
    category: 'mining',
    estimatedDurationSec: 60,
    provides: ['underground-access'],
  },
  'fill-area': { category: 'mining', estimatedDurationSec: 30 },

  // === クラフト系 ===
  'craft-one': {
    category: 'crafting',
    requires: ['list-inventory-items'],
    provides: ['crafted-item'],
    estimatedDurationSec: 3,
  },
  'start-smelting': {
    category: 'crafting',
    requires: ['check-furnace'],
    estimatedDurationSec: 5,
  },
  'check-furnace': { category: 'crafting', estimatedDurationSec: 2 },
  'check-container': { category: 'crafting', estimatedDurationSec: 2 },

  // === 戦闘系 ===
  'attack-nearest': { category: 'combat', estimatedDurationSec: 15 },
  'attack-continuously': { category: 'combat', estimatedDurationSec: 45, provides: ['kills'] },
  'combat': { category: 'combat', estimatedDurationSec: 30 },
  'set-shield': { category: 'combat', estimatedDurationSec: 1 },
  'swing-arm': { category: 'combat', estimatedDurationSec: 1 },

  // === 農業系 ===
  'plant-crop': { category: 'farming', estimatedDurationSec: 5 },
  'harvest-crop': { category: 'farming', estimatedDurationSec: 5 },
  'use-bone-meal': { category: 'farming', estimatedDurationSec: 3 },
  'breed-animal': { category: 'farming', estimatedDurationSec: 5 },
  'fish': { category: 'farming', estimatedDurationSec: 60 },

  // === インベントリ系 ===
  'deposit-to-container': { category: 'inventory', estimatedDurationSec: 3 },
  'withdraw-from-container': { category: 'inventory', estimatedDurationSec: 3 },
  'withdraw-from-furnace': { category: 'inventory', estimatedDurationSec: 3 },
  'drop-item': { category: 'inventory', estimatedDurationSec: 12 },
  'pickup-nearest-item': { category: 'inventory', estimatedDurationSec: 5 },

  // === インタラクション系 ===
  'place-block-at': { category: 'interaction', estimatedDurationSec: 3 },
  'activate-block': { category: 'interaction', estimatedDurationSec: 2 },
  'use-item': { category: 'interaction', estimatedDurationSec: 2 },
  'use-item-on-block': { category: 'interaction', estimatedDurationSec: 2 },
  'trade-with-villager': { category: 'interaction', estimatedDurationSec: 10 },
  'sleep-in-bed': { category: 'interaction', estimatedDurationSec: 10 },
  'chat': { category: 'interaction', estimatedDurationSec: 1 },

  // === ユーティリティ ===
  'wait-time': { category: 'utility', estimatedDurationSec: 10 },
  'find-structure': { category: 'utility', estimatedDurationSec: 30 },
  'switch-constant-skill': { category: 'utility', estimatedDurationSec: 1 },
  'switch-auto-detect-block-or-entity': { category: 'utility', estimatedDurationSec: 1 },
  'switch-auto-shoot-arrow-to-block': { category: 'utility', estimatedDurationSec: 1 },
};

/**
 * 指定スキルの依存関係情報を取得
 */
export function getSkillDependency(skillName: string): SkillDependency | undefined {
  return SKILL_DEPENDENCIES[skillName];
}

/**
 * LLM プランニング用: スキル依存関係のサマリーをテキストで取得
 */
export function getSkillDependencySummary(): string {
  const categories = new Map<SkillCategory, string[]>();
  for (const [name, dep] of Object.entries(SKILL_DEPENDENCIES)) {
    const list = categories.get(dep.category) || [];
    const info = [name];
    if (dep.requires?.length) info.push(`(要: ${dep.requires.join(', ')})`);
    if (dep.estimatedDurationSec) info.push(`~${dep.estimatedDurationSec}s`);
    list.push(info.join(' '));
    categories.set(dep.category, list);
  }

  let summary = '';
  for (const [cat, skills] of categories) {
    summary += `\n【${cat}】\n${skills.map(s => `  - ${s}`).join('\n')}\n`;
  }
  return summary;
}
