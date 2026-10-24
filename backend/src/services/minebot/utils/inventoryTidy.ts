/**
 * What may be thrown away, said when the pack is full (the body throws nothing away by itself, design mb-llm-centric: what goes is the
 * planner's). Run 20: a 99-level shaft and its tunnels filled the pack with tuff, andesite, diorite and deepslate.
 *
 * How much of each kind is worth keeping: building blocks for a shelter and a pillar, a little dirt. A kind not listed is never counted as
 * throwable (tools, weapons, armour, food, buckets, beds, wool, logs, planks, coal, ores, ingots, diamonds, obsidian, flint).
 */
const KEEP: Record<string, number> = {
  cobblestone: 64, cobbled_deepslate: 32, dirt: 16, andesite: 0, diorite: 0, granite: 0, tuff: 0, gravel: 4, sand: 0, netherrack: 32,
  deepslate: 0, coarse_dirt: 0, rooted_dirt: 0, mud: 0, basalt: 0, smooth_basalt: 0,
  leaf_litter: 0, short_grass: 0, wheat_seeds: 0, rotten_flesh: 0, poisonous_potato: 0, spider_eye: 0, calcite: 0, dripstone_block: 0,
  pointed_dripstone: 0, flint: 64, stick: 64,
};
const isSapling = (name: string) => name.endsWith('_sapling') || name.endsWith('_propagule');

interface Stack { name: string; count: number; stackSize?: number }

/** Rock a dig on the way brings in (counted as throwable). */
const SPARE_ROCK = ['cobbled_deepslate', 'tuff', 'diorite', 'andesite', 'granite', 'dirt', 'gravel', 'calcite', 'netherrack', 'deepslate', 'stone', 'cobblestone',
  'coarse_dirt', 'rooted_dirt', 'mud', 'basalt', 'smooth_basalt'];
/** Pickaxe tiers by worth (a spare of a lower tier is not made, nor kept, beside a good one of a higher). */
const PICK_TIER: Record<string, number> = { wooden_pickaxe: 0, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
/** Uses a higher-tier pickaxe must have left to count as one that makes a lower-tier spare unnecessary. */
const GOOD_PICKAXE_USES = 50;
interface Tool extends Stack { maxDurability?: number; durabilityUsed?: number }
const usesOf = (item: Tool) => item.maxDurability && item.maxDurability > 0 ? Math.max(0, item.maxDurability - (item.durabilityUsed ?? 0)) : Infinity;

/**
 * How many pickaxes of this kind may be carried: the one in use and one spare (two), and a single one when a pickaxe of a higher tier with
 * at least GOOD_PICKAXE_USES left is carried too (run 21 carried five stone pickaxes beside an iron one, each made as a "spare").
 */
export function pickaxeAllowance(items: Tool[], name: string): number {
  const tier = PICK_TIER[name];
  if (tier === undefined) return Infinity;
  const better = items.some(item => (PICK_TIER[item.name] ?? -1) > tier && usesOf(item) >= GOOD_PICKAXE_USES);
  return better ? 1 : 2;
}

/** Spare pickaxes over the allowance: the count to throw, by kind. The most worn go first (drop-item chooses by durability). */
export function surplusPickaxes(items: Tool[]): Array<{ name: string; count: number }> {
  const plan: Array<{ name: string; count: number }> = [];
  for (const name of Object.keys(PICK_TIER)) {
    const carried = items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    const over = carried - pickaxeAllowance(items, name);
    if (over > 0) plan.push({ name, count: over });
  }
  return plan;
}

/** Whether a kind is one this module would ever throw away (listed in the tables above); everything else is kept. */
export function isThrowable(name: string): boolean {
  // A kind kept to a whole stack or more (sticks, flint) is as good as never thrown: a stack goes only when what stays is the keep.
  return isSapling(name) || (name in KEEP && KEEP[name] < 64) || SPARE_ROCK.includes(name);
}

/**
 * What fills a pack, said for a refusal: the biggest heaps by name, and how many slots hold something that may be thrown. The planner
 * is told why no room can be made (run 20: "one free slot" with no word of what was in the way).
 */
export function describePack(items: Stack[], asked: string[] = []): string {
  const totals = new Map<string, { count: number; slots: number }>();
  for (const item of items) {
    const entry = totals.get(item.name) ?? { count: 0, slots: 0 };
    entry.count += item.count; entry.slots++;
    totals.set(item.name, entry);
  }
  const heaps = [...totals].sort((a, b) => b[1].slots - a[1].slots || b[1].count - a[1].count).slice(0, 5)
    .map(([name, entry]) => `${name}×${entry.count}`);
  const throwable = [...totals].filter(([name]) => isThrowable(name) && !asked.includes(name)).reduce((sum, [, entry]) => sum + entry.slots, 0);
  const kept = [...totals].filter(([name]) => !isThrowable(name) || asked.includes(name));
  return `いま${items.length}/36マスが埋まっています（多い物: ${heaps.join('・')}）。捨てても良い石・土・ごみは${throwable}マス分`
    + `、捨てられない物（道具・食料・鉱石・燃料・掘る物など）は${kept.reduce((sum, [, entry]) => sum + entry.slots, 0)}マス分です`;
}
