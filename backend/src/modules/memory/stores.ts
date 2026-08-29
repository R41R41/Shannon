/**
 * Which durable store a conversation path may touch.
 * Absence of a store is silence, not a fallback to another owner or channel.
 */
export const MEMORY_STORES = ['scoped_shannon', 'scoped_person_quote', 'legacy_person', 'world_knowledge', 'line_ephemeral', 'radar_owner'] as const;
export type MemoryStore = (typeof MEMORY_STORES)[number];
export const MEMORY_PATHS = ['discord_text', 'minecraft', 'line_chat', 'line_group', 'radar_personal', 'web', 'x', 'youtube', 'scheduler', 'internal'] as const;
export type MemoryPath = (typeof MEMORY_PATHS)[number];

const NONE: readonly MemoryStore[] = Object.freeze([]);
const DISCORD: readonly MemoryStore[] = Object.freeze(['scoped_shannon', 'scoped_person_quote']);
const MINECRAFT: readonly MemoryStore[] = Object.freeze(['world_knowledge']);
const LINE: readonly MemoryStore[] = Object.freeze(['line_ephemeral']);
const RADAR: readonly MemoryStore[] = Object.freeze(['radar_owner']);

const ALLOWED: Readonly<Record<MemoryPath, readonly MemoryStore[]>> = Object.freeze({
  discord_text: DISCORD,
  minecraft: MINECRAFT,
  line_chat: LINE,
  line_group: LINE,
  radar_personal: RADAR,
  web: NONE,
  x: NONE,
  youtube: NONE,
  scheduler: NONE,
  internal: NONE,
});

/** Durable ShannonMemory / scoped person quotes require a reviewed scope. LINE and Radar never share them. */
export function storesForPath(path: MemoryPath): readonly MemoryStore[] {
  return ALLOWED[path];
}

export function pathMayUseStore(path: MemoryPath, store: MemoryStore): boolean {
  return ALLOWED[path].includes(store);
}

/** Old PersonMemory mixed DM, guild and other channels. No path may read or write it. */
export function legacyPersonMemoryAllowed(path: MemoryPath): boolean {
  void path;
  return false;
}
