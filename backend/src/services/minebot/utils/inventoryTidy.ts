/**
 * What to throw away when the pack fills. Run 17 ended with 33 of its 36 slots taken (six stacks of cobblestone, 73 dirt, 38 andesite
 * and the like) and nothing done about it; a full pack drops what is mined next. From TIDY_ABOVE slots used, the plain stone kinds and
 * clutter go first, keeping enough of the building blocks to wall in and to pillar up (KEEP), until TIDY_TO slots are used.
 */
export const TIDY_ABOVE = 30;
const TIDY_TO = 28;
/**
 * How much of each kind is kept: building blocks for a shelter and a pillar, a little dirt. Absent kinds are kept whole. This is the
 * one table of what may be thrown away (run 20: a 99-level shaft and its tunnels filled the pack with tuff, andesite, diorite and
 * deepslate): a kind not listed is never thrown (tools, weapons, armour, food, buckets, beds, wool, logs, planks, coal, ores, ingots,
 * diamonds, obsidian, flint). Gravel keeps four, for the flint (mine-block's flintFromGravel).
 */
const KEEP: Record<string, number> = {
  cobblestone: 64, cobbled_deepslate: 32, dirt: 16, andesite: 0, diorite: 0, granite: 0, tuff: 0, gravel: 4, sand: 0, netherrack: 32,
  deepslate: 0, coarse_dirt: 0, rooted_dirt: 0, mud: 0, basalt: 0, smooth_basalt: 0,
  leaf_litter: 0, short_grass: 0, wheat_seeds: 0, rotten_flesh: 0, poisonous_potato: 0, spider_eye: 0, calcite: 0, dripstone_block: 0,
  pointed_dripstone: 0, flint: 64, stick: 64,
};
const isSapling = (name: string) => name.endsWith('_sapling') || name.endsWith('_propagule');

interface Stack { name: string; count: number; stackSize?: number }

/** Slots the pack's items fill (the 36 of the pack proper: the armour and the off hand are not in `items`). */
export function slotsUsed(items: Stack[]): number { return items.length; }

/**
 * What to drop, by kind and count, to bring the pack down to TIDY_TO slots: empty when it is at TIDY_ABOVE or fewer. Whole stacks over
 * what is kept, the junk first, then the largest surplus.
 */
export function tidyPlan(items: Stack[]): Array<{ name: string; count: number }> {
  let used = slotsUsed(items);
  if (used <= TIDY_ABOVE) return [];
  const totals = new Map<string, { count: number; stacks: number[] }>();
  for (const item of items) {
    const entry = totals.get(item.name) ?? { count: 0, stacks: [] };
    entry.count += item.count; entry.stacks.push(item.count);
    totals.set(item.name, entry);
  }
  const keepOf = (name: string) => isSapling(name) ? 0 : KEEP[name];
  const surplus = [...totals.entries()]
    .filter(([name]) => keepOf(name) !== undefined)
    .map(([name, entry]) => ({ name, entry, keep: keepOf(name)! }))
    .filter(({ entry, keep }) => entry.count > keep)
    .sort((a, b) => a.keep - b.keep || (b.entry.count - b.keep) - (a.entry.count - a.keep));
  const plan: Array<{ name: string; count: number }> = [];
  for (const { name, entry, keep } of surplus) {
    if (used <= TIDY_TO) break;
    // Whole stacks, smallest first, while what stays is at least `keep`: a slot is freed only by a whole stack going.
    const stacks = [...entry.stacks].sort((a, b) => a - b);
    let left = entry.count, dropped = 0;
    for (const size of stacks) {
      if (used <= TIDY_TO || left - size < keep) break;
      left -= size; dropped += size; used--;
    }
    if (dropped > 0) plan.push({ name, count: dropped });
  }
  return plan;
}

/** Rock a dig on the way brings in, spared when a pack is short of room even after tidyPlan (cobblestone kept to 32 for walls and steps). */
const SPARE_ROCK = ['cobbled_deepslate', 'tuff', 'diorite', 'andesite', 'granite', 'dirt', 'gravel', 'calcite', 'netherrack', 'deepslate', 'stone', 'cobblestone',
  'coarse_dirt', 'rooted_dirt', 'mud', 'basalt', 'smooth_basalt'];
/** What stays of a spare kind: cobblestone for walls and steps, four gravel for a flint, netherrack for bridging. */
const SPARE_KEPT: Record<string, number> = { cobblestone: 32, gravel: 4, netherrack: 32 };

/**
 * The largest heap of spare rock to throw away for room, or null: for a pack with nothing tidyPlan names (every kind under its KEEP),
 * as the obsidian tool does (mb-body's roomForDrops). Never one of `keep` (what is being mined and what it drops).
 */
export function spareRockToDrop(items: Stack[], keep: string[] = []): { name: string; count: number } | null {
  const totals = new Map<string, number>();
  for (const item of items) if (SPARE_ROCK.includes(item.name) && !keep.includes(item.name)) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  const best = [...totals].map(([name, count]) => ({ name, count: count - (SPARE_KEPT[name] ?? 0) }))
    .filter(entry => entry.count > 0).sort((a, b) => b.count - a.count)[0];
  return best ?? null;
}

/**
 * The body's own limit on rock it digs on the way (run 21: the pack was 34/36 with 545 cobblestone a minute after the head's tidy had
 * thrown 423 of it; the head's procedure tidy keeps 128 and runs only inside procedures). Past CLUTTER_SOFT of one kind, with the pack
 * short of room (CLUTTER_FEW_SLOTS free or fewer), or past CLUTTER_HARD at any time, the body throws the kind down to CLUTTER_KEEP
 * (below the head's 128, so the two never fight over the same heap). Kinds the table keeps fewer of (andesite, tuff, dirt...) go down to
 * their own KEEP. Only kinds this module already throws; a kind not listed is never touched.
 */
export const CLUTTER_SOFT = 160;
export const CLUTTER_HARD = 192;
export const CLUTTER_FEW_SLOTS = 6;
const CLUTTER_KEEP: Record<string, number> = { cobblestone: 96, cobbled_deepslate: 96 };
const CLUTTER_KINDS = ['cobblestone', 'cobbled_deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'dirt', 'coarse_dirt', 'rooted_dirt', 'gravel',
  'deepslate', 'netherrack', 'sand', 'mud', 'basalt', 'smooth_basalt', 'calcite'];

/** What to throw to bring the rock heaps down: whole kinds over their limit, largest first. Empty when none is over. */
export function clutterPlan(items: Stack[], freeSlots: number): Array<{ name: string; count: number }> {
  const totals = new Map<string, number>();
  for (const item of items) if (CLUTTER_KINDS.includes(item.name)) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  const plan: Array<{ name: string; count: number }> = [];
  for (const [name, total] of totals) {
    const over = total > CLUTTER_HARD || (freeSlots <= CLUTTER_FEW_SLOTS && total > CLUTTER_SOFT);
    if (!over) continue;
    const keep = CLUTTER_KEEP[name] ?? KEEP[name] ?? 0;
    if (total > keep) plan.push({ name, count: total - keep });
  }
  return plan.sort((a, b) => b.count - a.count);
}

/** Pickaxe tiers by worth (a spare of a lower tier is not made, nor kept, beside a good one of a higher). */
const PICK_TIER: Record<string, number> = { wooden_pickaxe: 0, golden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
/** Uses a higher-tier pickaxe must have left to count as one that makes a lower-tier spare unnecessary. */
export const GOOD_PICKAXE_USES = 50;
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
