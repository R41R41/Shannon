import { resyncInventory } from '../inventorySync.js';
import { freeSlots } from './common.js';

/**
 * Task 193a86b0 (11/10 13:03〜13:11Z): the body's copy of the pack and the server's came apart (slot 17 said stripped_oak_log×3 where the server
 * held oak_log×10; slot 24 went oak_log×11 → oak_planks×5/3/1 and back). For eight minutes every stick, planks and make of the pack's grid failed,
 * and the planks went 5→3→1→0 with nothing made. The pack's resync (`resyncInventory`, run L64) was called by the old craft skill and the place
 * skill only; the act's craft and make did not. Here: the pack is made the server's before a craft, and again before a craft is called failed
 * (the copy may say "not more" of a result the server gave).
 */
export async function syncPack(bot: any): Promise<boolean> {
  try { return await resyncInventory(bot); } catch { return false; }
}

/**
 * Room for `name` in the pack: a free slot, a stack of it that is not full, or (with the recipe and its rounds) an ingredient the craft uses up
 * whole, whose slot is free when the result comes. A full pack takes a craft's result nowhere (13:03:58Z: the first failed planks).
 */
export function roomFor(bot: any, name: string, recipe?: any, times = 1): boolean {
  if (freeSlots(bot) > 0) return true;
  const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>;
  const stack = Number(bot.registry?.itemsByName?.[name]?.stackSize ?? 64);
  if (items.some(entry => entry.name === name && entry.count < stack)) return true;
  for (const entry of recipe?.delta ?? []) {
    if (!(entry?.count < 0)) continue;
    const ingredient = String(bot.registry?.items?.[entry.id]?.name ?? '');
    const held = items.filter(item => item.name === ingredient).reduce((sum, item) => sum + item.count, 0);
    if (ingredient && held > 0 && held <= -entry.count * Math.max(1, times)) return true;
  }
  return false;
}

/** The wood kinds the generic names are made in, in the order a kind is taken when the pack says nothing. */
const KINDS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'];
/** Names a head says of any wood (12:58Z: craft item="planks" was refused twice as 「物の名前ではない」). */
const GENERIC = new Set(['planks', 'plank', 'log', 'logs', 'wood', 'slab', 'stairs', 'fence', 'fence_gate', 'door', 'trapdoor', 'button', 'pressure_plate',
  'sign', 'boat', 'wooden_slab', 'wooden_stairs', 'wooden_door', 'wooden_button', 'wooden_pressure_plate', 'wooden_trapdoor']);
const SINGULAR: Readonly<Record<string, string>> = { plank: 'planks', logs: 'log' };
const WOOD_OF = /^(?:stripped_)?([a-z_]+?)_(?:log|wood|stem|hyphae|planks)$/u;

/**
 * A generic wood name as the kind the pack holds most of (its logs and planks, any form), else oak: `planks` → `oak_planks`. A name the registry
 * knows, or one that is not a generic wood name, is given back as it is.
 */
export function resolveWoodName(bot: any, name: string): string {
  const byName = bot.registry?.itemsByName ?? {};
  if (byName[name]) return name;
  const bare = name.replace(/^minecraft:/u, '').toLowerCase();
  if (!GENERIC.has(bare)) return name;
  const part = SINGULAR[bare] ?? bare.replace(/^wooden_/u, '');
  const held = new Map<string, number>();
  for (const entry of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) {
    const kind = WOOD_OF.exec(entry.name)?.[1];
    if (kind && KINDS.includes(kind)) held.set(kind, (held.get(kind) ?? 0) + entry.count);
  }
  const kinds = [...[...held].sort((a, b) => b[1] - a[1]).map(([kind]) => kind), ...KINDS];
  for (const kind of kinds) {
    const candidate = `${kind}_${part}`;
    if (byName[candidate]) return candidate;
    // Nether wood is a stem, not a log.
    if (part === 'log' && byName[`${kind}_stem`]) return `${kind}_stem`;
  }
  return name;
}
