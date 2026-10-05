/**
 * Blocks a body counts as being in water: water itself, and the blocks the
 * client physics treats the same way (prismarine-physics `waterLike`: plants
 * that only exist under water, bubble columns) or that carry water
 * (waterlogged). Matching only the name "water" made a breathing escape take
 * a seabed of tall seagrass for dry footing and swim a bot down to drown
 * (paid run L12).
 */
const WATER_LIKE = new Set(['water', 'flowing_water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);

export function holdsWater(block: { name?: string; isWaterlogged?: boolean; getProperties?: () => Record<string, unknown> } | null | undefined): boolean {
  if (!block?.name) return false;
  if (WATER_LIKE.has(block.name) || block.isWaterlogged === true) return true;
  try { return block.getProperties?.().waterlogged === true; } catch { return false; }
}
