import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

/**
 * The blocks a hand may dig to make its way (`canDig`, contract hands-contract.md and go-contract.md): block ids, or the words
 * `stone` (the stones), `dirt` (the soils), `sand` (sand and gravel) and `wood` (logs, planks, fences of a tree). Whatever is named,
 * these are never dug on the way: bedrock, obsidian, ores, chests, furnaces, beds, doors, spawners, liquids, fire.
 */
const STONES = new Set(['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate', 'blackstone', 'netherrack',
  'end_stone', 'basalt', 'smooth_basalt', 'calcite', 'dripstone_block', 'mossy_cobblestone', 'sandstone', 'red_sandstone', 'terracotta']);
const SOILS = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'mud', 'clay', 'rooted_dirt', 'dirt_path', 'moss_block']);
const SANDS = new Set(['sand', 'red_sand', 'gravel', 'soul_sand', 'soul_soil']);
const WOOD = /^(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(?:log|wood|stem|hyphae|planks|fence|fence_gate|slab|stairs|block)$/u;
/** Never dug on the way, whatever the hand's list says. */
const NEVER = /^(?:bedrock|obsidian|crying_obsidian|reinforced_deepslate|spawner|trial_spawner|vault|barrier|command_block|structure_block|end_portal(?:_frame)?|end_gateway|nether_portal|ancient_debris|lava|water|fire|soul_fire|magma_block|cactus|sweet_berry_bush|wither_rose|tnt|ender_chest|anvil|enchanting_table|beacon)$|_ore$|_bed$|_door$|_shulker_box$|^shulker_box$|_sign$|_banner$|^raw_.*_block$/u;

export function roadDiggable(name: string, words: readonly string[]): boolean {
  if (NEVER.test(name) || PROTECTED_UTILITY_BLOCKS.has(name)) return false;
  for (const word of words) {
    if (word === name) return true;
    if (word === 'stone' && STONES.has(name)) return true;
    if (word === 'dirt' && SOILS.has(name)) return true;
    if (word === 'sand' && SANDS.has(name)) return true;
    if (word === 'wood' && WOOD.test(name)) return true;
  }
  return false;
}
