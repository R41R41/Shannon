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

/** Mineflayer may assign bot.registry after createBot returns; repair it once known. */
export function installTierToolMaterialRepair(bot: { registry?: unknown; on(event: 'login' | 'spawn', listener: () => void): unknown }): void {
  const repair = () => { repairTierToolMaterials(bot.registry); };
  repair();
  bot.on('login', repair);
  bot.on('spawn', repair);
}
