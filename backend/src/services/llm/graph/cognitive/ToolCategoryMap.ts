/**
 * ToolCategoryMap — InstantSkill をカテゴリに分類
 *
 * SubTaskExecutor が mini-FCA のツールセットをスコーピングするために使う。
 * 全スキルの 15-20% だけを各サブタスクに渡すことで、トークン使用量を削減。
 */

export type ToolCategory =
    | 'mining'
    | 'crafting'
    | 'smelting'
    | 'navigation'
    | 'combat'
    | 'farming'
    | 'building'
    | 'inventory'
    | 'observation'
    | 'utility';

const CATEGORY_SKILLS: Record<ToolCategory, string[]> = {
    mining: [
        'mine-block', 'dig-block-at', 'stair-mine', 'can-dig-block',
        'find-blocks', 'move-to', 'get-position', 'equip-item',
    ],
    crafting: [
        'craft-one', 'check-recipe', 'check-inventory-item', 'list-inventory-items',
        'find-blocks', 'move-to', 'get-position', 'equip-item',
    ],
    smelting: [
        'start-smelting', 'check-furnace', 'withdraw-from-furnace',
        'find-blocks', 'move-to', 'get-position', 'craft-one',
        'place-block-at', 'check-inventory-item',
    ],
    navigation: [
        'move-to', 'get-position', 'check-path-to', 'find-blocks',
        'find-structure', 'enter-portal', 'look-at', 'jump',
        'stop-movement', 'get-block-at', 'is-block-loaded',
    ],
    combat: [
        'attack-nearest', 'attack-continuously', 'combat', 'shoot-bow',
        'flee-from', 'set-shield', 'equip-item', 'find-nearest-entity',
        'list-nearby-entities', 'move-to', 'get-health', 'get-position',
    ],
    farming: [
        'harvest-crop', 'plant-crop', 'breed-animal', 'use-bone-meal',
        'fish', 'find-blocks', 'move-to', 'get-position',
        'check-inventory-item',
    ],
    building: [
        'place-block-at', 'fill-area', 'dig-block-at', 'get-blocks-in-area',
        'get-block-at', 'move-to', 'get-position', 'find-blocks',
        'check-inventory-item',
    ],
    inventory: [
        'check-inventory-item', 'list-inventory-items', 'equip-item',
        'drop-item', 'deposit-to-container', 'withdraw-from-container',
        'check-container', 'move-to', 'get-position', 'pickup-nearest-item',
    ],
    observation: [
        'get-position', 'get-block-at', 'get-block-in-sight', 'get-blocks-in-area',
        'find-nearest-entity', 'list-nearby-entities',
        'get-bot-status', 'get-health', 'get-time-and-weather', 'get-equipment',
        'get-advancements', 'find-blocks', 'find-structure', 'is-block-loaded',
    ],
    utility: [
        'chat', 'wait-time', 'set-sneak', 'set-sprint', 'sleep-in-bed',
        'activate-block', 'use-item', 'use-item-on-block',
    ],
};

/** 全サブタスクに必ず含むツール */
const ALWAYS_INCLUDED = [
    'task-complete', 'update-plan', 'get-position', 'check-inventory-item',
    'get-bot-status',
];

/**
 * カテゴリに対応するツール名リストを返す。
 * ALWAYS_INCLUDED も含む。
 */
export function getToolsForCategory(category: ToolCategory): string[] {
    const categoryTools = CATEGORY_SKILLS[category] ?? [];
    return [...new Set([...ALWAYS_INCLUDED, ...categoryTools])];
}

/**
 * サブタスクのゴール文字列からカテゴリを推論する。
 * SubTaskPlannerNode が toolCategory を出力するのが主経路。これはフォールバック。
 */
export function inferCategory(goal: string): ToolCategory {
    const g = goal.toLowerCase();

    if (g.match(/掘|採掘|mine|dig|ore|鉱石/)) return 'mining';
    if (g.match(/クラフト|craft|作[るれ]|作成/)) return 'crafting';
    if (g.match(/精錬|smelt|かまど|furnace|製錬/)) return 'smelting';
    if (g.match(/移動|探[すし索]|find|move|go|行[くけ]/)) return 'navigation';
    if (g.match(/攻撃|戦[うい闘]|倒|kill|attack|combat|fight|flee|逃/)) return 'combat';
    if (g.match(/農|plant|harvest|crop|breed|fish|釣|畑/)) return 'farming';
    if (g.match(/建[てつ築]|build|place|fill|設置/)) return 'building';
    if (g.match(/収納|整理|store|deposit|withdraw|chest|チェスト/)) return 'inventory';
    if (g.match(/調[べ査]|観察|investigate|look|check|確認/)) return 'observation';

    return 'utility';
}

/** 全カテゴリの一覧 */
export function getAllCategories(): ToolCategory[] {
    return Object.keys(CATEGORY_SKILLS) as ToolCategory[];
}
