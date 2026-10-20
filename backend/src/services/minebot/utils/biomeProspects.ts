import { biomesAround, type BiomeArea, type PlaceMemoryState } from '../../../modules/minecraftLearning/places.js';

/**
 * Where the farm animals (sheep, cows, pigs, chickens) spawn, by biome, as the game's spawn lists have them: on grass, in plains, forests,
 * taiga, savanna, meadows and swamps; not on snow, sand, terracotta or water. Run 19 (2026-10-20) went from badlands to snowy plains to a
 * frozen ocean and saw no sheep in thirty minutes, while a village 171 m off (sheep, beds, food) was never gone to.
 */
const FARM_GOOD = /^(plains|sunflower_plains|meadow|forest|flower_forest|birch_forest|old_growth_birch_forest|dark_forest|taiga|old_growth_pine_taiga|old_growth_spruce_taiga|savanna|savanna_plateau|windswept_savanna|windswept_hills|windswept_forest|windswept_gravelly_hills|cherry_grove|swamp|jungle|sparse_jungle)$/;
const FARM_POOR = /^(snowy_plains|ice_spikes|desert|badlands|eroded_badlands|wooded_badlands|.*ocean|beach|snowy_beach|stony_shore|river|frozen_river|deep_dark|dripstone_caves|lush_caves|mushroom_fields|stony_peaks|jagged_peaks|frozen_peaks|snowy_slopes)$/;
/** Rabbits keep to snow, sand and the colder woods. */
const RABBIT_GOOD = /^(desert|snowy_plains|snowy_taiga|ice_spikes|grove|snowy_slopes|taiga|old_growth_pine_taiga|old_growth_spruce_taiga|flower_forest|meadow|cherry_grove)$/;

export type Prospect = 'good' | 'poor' | 'unknown';

/** Whether a biome is one the kind is found in. */
export function animalProspect(kind: string, biome: string): Prospect {
  if (kind === 'rabbit') return RABBIT_GOOD.test(biome) ? 'good' : 'unknown';
  if (kind === 'mooshroom') return biome === 'mushroom_fields' ? 'good' : 'poor';
  return FARM_GOOD.test(biome) ? 'good' : FARM_POOR.test(biome) ? 'poor' : 'unknown';
}

const KIND_WORD: Record<string, string> = { sheep: '羊', cow: '牛', pig: '豚', chicken: '鶏', rabbit: '兎', food_animals: '食料になる動物' };

/**
 * The prospect of finding the kind, said with a search that found none: which of the biomes passed are poor for it, the nearest remembered
 * biome that is good for it, and a remembered village (sheep, beds, food). Empty when there is nothing to say.
 */
export function prospectNote(kind: string, kinds: string[], passed: string[], memory: { state?: PlaceMemoryState; recall?(kind?: string, limit?: number): Array<{ distance: number; direction: string; position: { x: number; y: number; z: number } }> } | undefined,
  at: { x: number; y: number; z: number }, dimension: string): string {
  const word = KIND_WORD[kind] ?? kind;
  const judge = (biome: string) => kinds.map(name => animalProspect(name, biome)).includes('good') ? 'good'
    : kinds.every(name => animalProspect(name, biome) === 'poor') ? 'poor' : 'unknown';
  const seen = [...new Set(passed)];
  const poor = seen.filter(biome => judge(biome) === 'poor');
  const parts: string[] = [];
  if (seen.length) parts.push(`通ったバイオーム: ${seen.join('・')}`);
  if (poor.length) parts.push(`${poor.join('・')}には${word}がほとんど出ない`);
  let areas: BiomeArea[] = [];
  try { areas = memory?.state ? biomesAround(memory.state, at, dimension, 64) : []; } catch { areas = []; }
  const good = areas.find(area => !area.here && judge(area.biome) === 'good');
  if (good) parts.push(`${word}の出る ${good.biome} は記憶では${good.direction} ${good.distance}m`);
  try {
    const village = memory?.recall?.('village', 1)?.[0];
    if (village) parts.push(`村（羊・ベッド・食べ物がある見込み）は${village.direction} ${village.distance}m (${village.position.x},${village.position.y},${village.position.z})`);
  } catch { /* the memory is optional */ }
  return parts.join('。');
}
