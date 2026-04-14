/**
 * Shared constants for minebot skills.
 */

/** Blocks that should never be broken by automated actions (crafting stations, storage, etc.). */
export const PROTECTED_UTILITY_BLOCKS = new Set([
  // 収納系
  'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'shulker_box',
  'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
  'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
  'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
  'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
  // かまど系
  'furnace', 'blast_furnace', 'smoker',
  // 作業台・加工系
  'crafting_table', 'smithing_table', 'cartography_table', 'loom', 'stonecutter',
  // エンチャント・修理
  'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'grindstone',
  // 醸造
  'brewing_stand',
  // その他ユーティリティ
  'beacon', 'conduit', 'lectern', 'composter', 'respawn_anchor',
  'bell', 'lodestone',
  // ベッド
  'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
  'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
  'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed',
]);
