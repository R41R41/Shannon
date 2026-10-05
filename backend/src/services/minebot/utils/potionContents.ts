/**
 * What a potion is a potion of.
 *
 * Every potion in the pack is the one item, `potion`: a bottle of water and a draught against fire differ only
 * in what the item carries with it, and the client is told that as a number (the place of the potion in the
 * game's own list). The body saw "potion ×1" and could not have said whether drinking it was worth anything
 * (a piglin gives both a bottle of water and fire resistance for gold). The list below is the game's, in its
 * order, for the version the lab runs (1.21.11); the library that names blocks and items has no such list.
 * Checked in the lab against potions given by name: water 0, fire_resistance 11, swiftness 13, healing 24,
 * regeneration 31, strength 34, slow_falling 40.
 */
export const POTIONS: readonly string[] = [
  'water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
  'leaping', 'long_leaping', 'strong_leaping', 'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness',
  'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness', 'turtle_master', 'long_turtle_master',
  'strong_turtle_master', 'water_breathing', 'long_water_breathing', 'healing', 'strong_healing', 'harming',
  'strong_harming', 'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration', 'strong_regeneration',
  'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested',
];

/** Items that carry a potion with them. */
export function carriesPotion(name: string | null | undefined): boolean {
  return !!name && (name === 'potion' || name === 'splash_potion' || name === 'lingering_potion' || name === 'tipped_arrow');
}

/**
 * The potion an item carries, by the game's name for it (`fire_resistance`), `unknown_<n>` for a number past
 * the list (a later version's), or null when the item carries none or says nothing of it.
 */
export function potionIn(item: { name?: string | null; components?: unknown } | null | undefined): string | null {
  if (!item || !carriesPotion(item.name) || !Array.isArray(item.components)) return null;
  for (const component of item.components as Array<{ type?: unknown; data?: any }>) {
    if (component?.type !== 'potion_contents') continue;
    const id = component.data?.potionId ?? component.data?.potion;
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0) return POTIONS[id] ?? `unknown_${id}`;
    if (typeof id === 'string' && id) return id.replace(/^minecraft:/, '');
  }
  return null;
}
