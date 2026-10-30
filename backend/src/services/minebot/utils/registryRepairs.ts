import { vanillaFoodNutrition } from './foodPoints.js';

/**
 * minecraft-data 1.21.11 gives the 108 tier-gated blocks (ores, obsidian,
 * iron blocks...) the material `incorrect_for_wooden_tool`, whose multiplier
 * table lists only wooden tools. prismarine-block then computes every
 * stone/iron/diamond pickaxe dig as if bare-handed speed 1, and Mineflayer
 * waits that long before finishing the dig: obsidian took 75s instead of
 * 9.4s with a diamond pickaxe. Every block in these tier materials is a
 * pickaxe block, so their speed table is the `mineable/pickaxe` table.
 * Harvest eligibility stays with each block's own harvestTools.
 */
export function repairTierToolMaterials(registry: unknown): string[] {
  const materials = (registry as { materials?: Record<string, Record<string, number>> } | null)?.materials;
  const pickaxe = materials?.['mineable/pickaxe'];
  if (!materials || !pickaxe) return [];
  const repaired: string[] = [];
  for (const name of Object.keys(materials)) {
    if (!name.startsWith('incorrect_for_') || materials[name] === pickaxe) continue;
    materials[name] = pickaxe;
    repaired.push(name);
  }
  return repaired;
}

/**
 * The 1.21.11 food data converts an already absolute saturation as a modifier again:
 * raw pork 1.8 becomes 10.8, cooked pork 12.8 becomes 204.8. Only repair that exact
 * signature for known vanilla foods and this version; custom foods/values stay as reported.
 */
export function repairFoodSaturation(registry: unknown): string[] {
  const data = registry as { version?: { minecraftVersion?: string }; foodsByName?: Record<string, {
    foodPoints?: number; saturation?: number; effectiveQuality?: number; saturationRatio?: number;
  }> } | null;
  if (data?.version?.minecraftVersion !== '1.21.11' || !data.foodsByName) return [];
  const repaired: string[] = [];
  for (const [name, food] of Object.entries(data.foodsByName)) {
    const nutrition = vanillaFoodNutrition(name);
    if (!nutrition || food.foodPoints !== nutrition[0] || typeof food.saturation !== 'number') continue;
    const [hunger, saturation] = nutrition;
    if (Math.abs(food.saturation - saturation) < 1e-4 || Math.abs(food.saturation - saturation * hunger * 2) > 1e-3) continue;
    food.saturation = saturation;
    food.effectiveQuality = hunger + saturation;
    food.saturationRatio = saturation / hunger;
    repaired.push(name);
  }
  return repaired;
}

/** Mineflayer may assign bot.registry after createBot returns; repair it once known. */
export function installRegistryRepairs(bot: { registry?: unknown; on(event: 'login' | 'spawn', listener: () => void): unknown }): void {
  const repair = () => { repairTierToolMaterials(bot.registry); repairFoodSaturation(bot.registry); };
  repair();
  bot.on('login', repair);
  bot.on('spawn', repair);
}

/** Existing probe callers share the same registry installation boundary. */
export const installTierToolMaterialRepair = installRegistryRepairs;
