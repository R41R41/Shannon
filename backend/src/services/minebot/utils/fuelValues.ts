/**
 * How many items one piece of a fuel smelts (the game's burn time over 200 ticks, an item's cooking time): coal 1600 ticks is 8 items, a plank
 * 300 ticks is 1.5. For smelt, which says whether the fuel it was given covers the load before it puts the load in. A fuel not listed counts
 * as 1 (the least a fuel ever gives of the ones that are worth carrying), so a shortfall is never missed for a name the table does not know.
 */
const ITEMS_PER_FUEL: Array<[RegExp, number]> = [
  [/^lava_bucket$/u, 100],
  [/^coal_block$/u, 80],
  [/^dried_kelp_block$/u, 20],
  [/^blaze_rod$/u, 12],
  [/^(coal|charcoal)$/u, 8],
  [/^(bamboo_mosaic|bamboo_block|stripped_bamboo_block)$/u, 1.5],
  [/_boat$|_chest_boat$/u, 6],
  [/^(bamboo)$/u, 0.25],
  [/^(stick|scaffolding)$/u, 0.5],
  [/_(log|wood|stem|hyphae)$|_planks$|_fence$|_fence_gate$|_stairs$|_pressure_plate$|^(crafting_table|chest|trapped_chest|barrel|bookshelf|jukebox|note_block|loom|composter|lectern|cartography_table|fletching_table|smithing_table)$/u, 1.5],
  [/_slab$/u, 0.75],
  [/_door$|_trapdoor$|_sign$|_hanging_sign$|^wooden_(sword|pickaxe|axe|shovel|hoe)$|^(bow|crossbow|fishing_rod|ladder|bowl)$/u, 1],
  [/_wool$|_banner$|^wooden_button$/u, 0.5],
  [/_carpet$/u, 0.33],
  [/_sapling$/u, 0.5],
];

export function itemsPerFuel(name: string): number {
  for (const [pattern, items] of ITEMS_PER_FUEL) if (pattern.test(name)) return items;
  return 1;
}

/** How many of this fuel it takes to smelt `items` inputs (rounded up). */
export function fuelFor(name: string, items: number): number {
  return Math.max(1, Math.ceil(items / itemsPerFuel(name) - 1e-9));
}
