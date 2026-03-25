/**
 * Shared constants for minebot skills.
 */

/** Blocks that should never be broken by automated actions (crafting stations, storage, etc.). */
export const PROTECTED_UTILITY_BLOCKS = new Set([
  'furnace',
  'blast_furnace',
  'smoker',
  'crafting_table',
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
]);
