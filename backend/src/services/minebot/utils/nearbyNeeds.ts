import { Vec3 } from 'vec3';
import type { NearbyNeed } from '../cognition/types.js';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { scanLoadedBlocks } from './loadedBlockScan.js';
import { bedWool, descentKit, isPreparedFood, sheepWool } from './nightGate.js';
import { wasUnreachable } from './unreachableTargets.js';

/**
 * What an unmet need wants that lies near the body, said in every observation (`state.world.nearbyNeeds`), apart from the places
 * remembered (rememberedPlaces, ten kinds): run 18 made 49 decisions and never once had the iron ore in its own surroundings before it
 * (the owner, 2026-10-20). Only the needs not met yet, judged from what the body carries:
 *
 * - bed: no bed (carried or set): a bed already standing (an igloo's, a village's), from the places seen, within BED_RANGE; dig it
 *   (dig-block-at) and it is carried. Run 19: an igloo's bed 13 m away at D10, never taken in 30 minutes, and no sheep at all.
 * - bed_wool: no bed (carried or set): sheep, of the colour most wool is carried of (any colour with none), not shorn.
 * - food: fewer than FOOD_ENOUGH portions of cooked food: the animals that are food.
 * - iron: less iron at hand than what is still to be made needs (`ironStillNeeded`): iron ore. Run 19 dug about 55 for about 33:
 *   the ore in a furnace and what was made of it were not counted, and each load into a furnace brought the ore back as a need.
 * - fuel: fewer than FUEL_ENOUGH coal (charcoal counts, a coal block is nine): coal ore. Run 19 burnt logs with coal 12 m away.
 * - wood: fewer than WOOD_ENOUGH planks (a log is four): logs.
 *
 * Each with where it is and how far. `canReach` is false only for a block mine-block failed to reach lately (why: failed_recently):
 * whether an animal behind a hill or a fence can be walked to is not known from here, and a buried ore is got at by digging to it.
 * `exposed: false` says it is out of sight (an animal no straight line from the eyes reaches; an ore with no face open to the air).
 * Nearest first, those that can be got at ahead of those that cannot; PER_NEED of each. `id` names the same thing from one reading to
 * the next (the entity, or the block's cell), so a change of the list is told as events (`need.appeared` / `need.gone`,
 * integration/commonFca/bodyEvents). Whether to go for one is the API's (its arbiter and planner, session mb-arch).
 */
const RANGE = 24;
const PER_NEED = 2;
const MAX_NEEDS = 12;
const FOOD_ENOUGH = 6;
const WOOD_ENOUGH = 12;
/** A smelt of eight takes one coal: about thirty iron and a few meals. */
const FUEL_ENOUGH = 8;
/** A standing bed is worth a walk this far (the places seen reach further than the loaded blocks). */
const BED_RANGE = 96;
/** Read again after this long, or when the body has moved this far: the observation is taken far more often than this. */
const CACHE_MS = 3_000;
const CACHE_MOVE = 4;
const RAY_STEP = 0.25;

const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];
const COAL_ORES = ['coal_ore', 'deepslate_coal_ore'];
/**
 * What the iron is for, in the order it is made (the milestones: an iron pickaxe and a bucket, then the whole iron armour, and a spare
 * pickaxe), with the iron each takes and what counts as having it already (a better one does).
 */
const IRON_PLAN: ReadonlyArray<{ iron: number; have: (name: string) => boolean; wanted?: number }> = [
  { iron: 3, have: name => /^(iron|diamond|netherite)_pickaxe$/u.test(name), wanted: 2 },
  { iron: 3, have: name => name === 'bucket' || name.endsWith('_bucket') },
  { iron: 5, have: name => /^(iron|diamond|netherite)_helmet$/u.test(name) },
  { iron: 8, have: name => /^(iron|diamond|netherite)_chestplate$/u.test(name) },
  { iron: 7, have: name => /^(iron|diamond|netherite)_leggings$/u.test(name) },
  { iron: 4, have: name => /^(iron|diamond|netherite)_boots$/u.test(name) },
];

/**
 * The iron still to get: what the things not made yet take (`IRON_PLAN`; two pickaxes, the second a spare), less the iron at hand:
 * ingots, raw iron and ore carried (a block is nine), and what is in a furnace now (`activeFurnaces`, its input until withdrawn).
 * What was made is counted by having it, worn or carried.
 */
export function ironStillNeeded(carried: ReadonlyArray<{ name: string; count: number }>, furnaces: ReadonlyArray<{ item?: string; count?: number }> = []): number {
  const owned = (test: (name: string) => boolean) => carried.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
  const wanted = IRON_PLAN.reduce((sum, part) => sum + part.iron * Math.max(0, (part.wanted ?? 1) - owned(part.have)), 0);
  const loose = owned(name => name === 'iron_ingot' || name === 'raw_iron' || IRON_ORES.includes(name))
    + 9 * owned(name => name === 'iron_block' || name === 'raw_iron_block')
    + furnaces.filter(furnace => /raw_iron|iron_ore/u.test(String(furnace.item ?? ''))).reduce((sum, furnace) => sum + (furnace.count ?? 0), 0);
  return Math.max(0, wanted - loose);
}
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

interface NeedsBody {
  entity?: { position: Vec3 };
  entities?: Record<string, { id?: number; name?: string; position?: Vec3; metadata?: unknown[]; height?: number } | undefined>;
  inventory?: { items?(): Array<{ name: string; count: number }>; slots?: Array<{ name?: string; count?: number } | null | undefined> };
  registry?: any;
  world?: any;
  activeFurnaces?: Array<{ item?: string; count?: number }>;
  placeMemory?: { recall?(kind?: string, limit?: number): Array<{ position: { x: number; y: number; z: number }; distance: number; keep?: string }> };
  blockAt?(position: Vec3, extra?: boolean): { name?: string; boundingBox?: string } | null;
}

const cache = new WeakMap<object, { at: number; from: Vec3; needs: NearbyNeed[] }>();

export function nearbyNeeds(bot: NeedsBody, now = Date.now()): NearbyNeed[] {
  const at = bot.entity?.position;
  if (!at || typeof (at as Partial<Vec3>).distanceTo !== 'function') return [];
  // Kept on the body itself, whatever handle of it is passed in (see unreachableTargets).
  const key = nativeActionHost(bot as object);
  const cached = cache.get(key);
  let needs: NearbyNeed[];
  if (cached && now - cached.at < CACHE_MS && cached.from.distanceTo(at) < CACHE_MOVE) needs = cached.needs;
  else {
    // A failed reading is not cached and not hidden: the caller (the observation, the body events) skips it, rather than every need
    // seeming gone for the next three seconds.
    needs = readNeeds(bot, at, now);
    cache.set(key, { at: now, from: at.clone(), needs });
  }
  return needs.map(need => ({ ...need, position: { ...need.position } }));
}

function readNeeds(bot: NeedsBody, at: Vec3, now: number): NearbyNeed[] {
  const items = (() => { try { return bot.inventory?.items?.() ?? []; } catch { return []; } })();
  const slots = bot.inventory?.slots;
  const worn = Array.isArray(slots) ? [5, 6, 7, 8].map(slot => slots[slot]).filter((item): item is { name: string } => !!item?.name) : [];
  const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
  const out: NearbyNeed[] = [];

  // bed_wool and food: animals within reach of the eye.
  const kit = (() => { try { return descentKit(bot as any); } catch { return null; } })();
  const woolColor = (() => { try { return bedWool(bot as any)?.color; } catch { return undefined; } })();
  const wantBed = !!kit && !kit.bed;
  const wantFood = items.filter(item => isPreparedFood(item.name)).reduce((sum, item) => sum + item.count, 0) < FOOD_ENOUGH;
  if (wantBed || wantFood) {
    const animals = Object.values(bot.entities ?? {})
      .filter((entity): entity is NonNullable<typeof entity> & { name: string; position: Vec3 } => !!entity?.position && !!entity.name && FOOD_ANIMALS.has(entity.name)
        && entity !== (bot.entity as unknown))
      .map(entity => ({ entity, distance: at.distanceTo(entity.position) }))
      .filter(entry => entry.distance <= RANGE)
      .sort((a, b) => a.distance - b.distance);
    if (wantBed) {
      const sheep = animals.filter(({ entity }) => {
        if (entity.name !== 'sheep') return false;
        const wool = sheepWool(bot, entity);
        return !wool || (!wool.sheared && (!woolColor || wool.color === woolColor));
      });
      out.push(...sheep.slice(0, PER_NEED).map(({ entity, distance }) => animalNeed(bot, at, 'bed_wool', entity, distance, sheepWool(bot, entity)?.color)));
    }
    if (wantFood) out.push(...animals.slice(0, PER_NEED).map(({ entity, distance }) => animalNeed(bot, at, 'food', entity, distance)));
  }
  if (wantBed) out.unshift(...standingBeds(bot, now));

  // iron, fuel and wood: blocks in the loaded chunks.
  const carried = [...items, ...worn.map(item => ({ name: item.name, count: 1 }))];
  if (ironStillNeeded(carried, bot.activeFurnaces ?? []) > 0) out.push(...pick(blockNeeds(bot, 'iron', IRON_ORES, now)));
  if (count(name => name === 'coal' || name === 'charcoal') + 9 * count(name => name === 'coal_block') < FUEL_ENOUGH) {
    out.push(...pick(blockNeeds(bot, 'fuel', COAL_ORES, now)));
  }
  const planks = count(name => name.endsWith('_planks')) + 4 * count(name => /_(log|wood|stem|hyphae)$/.test(name));
  if (planks < WOOD_ENOUGH) {
    const logs = logNames(bot.registry);
    out.push(...pick(blockNeeds(bot, 'wood', logs, now)));
  }
  return out.slice(0, MAX_NEEDS);
}

const logCache = new WeakMap<object, string[]>();
/** The log blocks of this registry (read once per registry). */
function logNames(registry: any): string[] {
  if (!registry?.blocksByName) return [];
  let names = logCache.get(registry);
  if (!names) { names = Object.keys(registry.blocksByName).filter(name => name.endsWith('_log') && !name.startsWith('stripped_')); logCache.set(registry, names); }
  return names;
}

/**
 * The nearest bed standing within BED_RANGE, from the places seen, and only one (it is the one to walk to): not a bed of her own (her
 * respawn bed, or one she placed at her base: hers already), nor one whose block, loaded, is no longer a bed (taken or broken since).
 * The block's own name when it is loaded.
 */
function standingBeds(bot: NeedsBody, now: number): NearbyNeed[] {
  const places = (() => { try { return bot.placeMemory?.recall?.('bed', 4) ?? []; } catch { return []; } })();
  const cell = (place: { position: { x: number; y: number; z: number } }) => new Vec3(Math.floor(place.position.x), Math.floor(place.position.y), Math.floor(place.position.z));
  const loaded = (at: Vec3) => { try { return bot.blockAt?.(at)?.name; } catch { return undefined; } };
  const standing = places.filter(place => place.keep !== 'respawn' && place.keep !== 'base' && place.distance <= BED_RANGE)
    .map(place => ({ place, at: cell(place), name: loaded(cell(place)) }))
    .filter(entry => entry.name === undefined || entry.name === null || entry.name.endsWith('_bed'));
  return standing.slice(0, 1).map(({ place, at, name }) => {
    const failed = wasUnreachable(bot, at, now);
    return { id: `bed:b:${at.x},${at.y},${at.z}`, need: 'bed' as const, name: name?.endsWith('_bed') ? name : 'bed', position: { x: at.x, y: at.y, z: at.z },
      distance: place.distance, canReach: !failed, ...(failed ? { why: 'failed_recently' as const } : {}) };
  });
}

/** Those that can be got at first, then the nearest; PER_NEED of them. */
function pick(needs: NearbyNeed[]): NearbyNeed[] {
  return needs.sort((a, b) => Number(b.canReach) - Number(a.canReach) || a.distance - b.distance).slice(0, PER_NEED);
}

/** An animal, with whether a straight line from the eyes reaches it (judged only for the ones said: a few rays, no flood fill). */
function animalNeed(bot: NeedsBody, at: Vec3, need: NearbyNeed['need'], entity: { id?: number; name: string; position: Vec3; height?: number }, distance: number, color?: string): NearbyNeed {
  const seen = inSight(bot, at.offset(0, 1.62, 0), entity.position.offset(0, (entity.height ?? 1) * 0.5, 0));
  const position = rounded(entity.position);
  return { id: typeof entity.id === 'number' ? `${need}:e:${entity.id}` : `${need}:a:${entity.name}:${position.x},${position.y},${position.z}`, need, name: entity.name, ...(color ? { color } : {}), position, distance: Math.round(distance * 10) / 10,
    canReach: true, ...(seen === false ? { exposed: false } : {}) };
}

/** Whether nothing solid lies between the two points; null with no world to read. */
function inSight(bot: NeedsBody, from: Vec3, to: Vec3): boolean | null {
  if (typeof bot.blockAt !== 'function') return null;
  const steps = Math.max(1, Math.ceil(from.distanceTo(to) / RAY_STEP));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cell = new Vec3(Math.floor(from.x + (to.x - from.x) * t), Math.floor(from.y + (to.y - from.y) * t), Math.floor(from.z + (to.z - from.z) * t));
    const block = bot.blockAt(cell, false);
    if (!block || block.boundingBox === 'block') return false;
  }
  return true;
}

function blockNeeds(bot: NeedsBody, need: NearbyNeed['need'], names: string[], now: number): NearbyNeed[] {
  if (!names.length || !bot.registry?.blocksByName || typeof bot.world?.getColumns !== 'function') return [];
  const hits = scanLoadedBlocks(bot as any, names, { maxDistance: RANGE, maxHits: 12 }).hits;
  return hits.map(hit => {
    const failed = wasUnreachable(bot, hit.position, now);
    // A buried ore is got at by digging (mine-block tunnels to it): it can be reached, only not seen from the open.
    const exposed = typeof bot.blockAt !== 'function'
      || NEIGHBOURS.some(([dx, dy, dz]) => bot.blockAt!(hit.position.offset(dx, dy, dz))?.boundingBox !== 'block');
    const position = rounded(hit.position);
    return { id: `${need}:b:${position.x},${position.y},${position.z}`, need, name: hit.name, position, distance: Math.round(hit.distance * 10) / 10,
      canReach: !failed, ...(exposed ? {} : { exposed: false }), ...(failed ? { why: 'failed_recently' as const } : {}) };
  });
}

function rounded(position: Vec3): { x: number; y: number; z: number } {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}
