/**
 * What to throw away when the pack fills. Run 17 ended with 33 of its 36 slots taken (six stacks of cobblestone, 73 dirt, 38 andesite
 * and the like) and nothing done about it; a full pack drops what is mined next. From TIDY_ABOVE slots used, the plain stone kinds and
 * clutter go first, keeping enough of the building blocks to wall in and to pillar up (KEEP), until TIDY_TO slots are used.
 */
export const TIDY_ABOVE = 30;
const TIDY_TO = 28;
/** How much of each kind is kept: building blocks for a shelter and a pillar, a little dirt. Absent kinds are kept whole. */
const KEEP: Record<string, number> = {
  cobblestone: 64, cobbled_deepslate: 32, dirt: 16, andesite: 0, diorite: 0, granite: 0, tuff: 0, gravel: 0, sand: 0, netherrack: 32,
  leaf_litter: 0, short_grass: 0, wheat_seeds: 0, rotten_flesh: 0, poisonous_potato: 0, spider_eye: 0, calcite: 0, dripstone_block: 0,
  pointed_dripstone: 0, flint: 8, stick: 16,
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
