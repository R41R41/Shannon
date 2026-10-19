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
 * - bed_wool: no bed (carried or set): sheep, of the colour most wool is carried of (any colour with none), not shorn.
 * - food: fewer than FOOD_ENOUGH portions of cooked food: the animals that are food.
 * - iron: less than IRON_ENOUGH iron (ingots, raw, ore blocks, iron blocks as nine, and what the armour worn or carried took): iron ore.
 * - wood: fewer than WOOD_ENOUGH planks (a log is four): logs.
 *
 * Each with where it is and how far. `canReach` is false only for a block mine-block failed to reach lately (why: failed_recently):
 * whether an animal behind a hill or a fence can be walked to is not known from here, and a buried ore is got at by digging to it.
 * `exposed: false` says it is out of sight (an animal no straight line from the eyes reaches; an ore with no face open to the air).
 * Nearest first, those that can be got at ahead of those that cannot; PER_NEED of each. Whether to go for one is the planner's
 * (mb-head: the fast decisions and Jev).
 */
const RANGE = 24;
const PER_NEED = 2;
const MAX_NEEDS = 8;
const FOOD_ENOUGH = 6;
const IRON_ENOUGH = 24;
const WOOD_ENOUGH = 12;
/** Read again after this long, or when the body has moved this far: the observation is taken far more often than this. */
const CACHE_MS = 3_000;
const CACHE_MOVE = 4;
const RAY_STEP = 0.25;

const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];
/** The iron each piece of armour took: a body in iron armour needs less ore. */
const IRON_IN: Record<string, number> = { iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4 };
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

interface NeedsBody {
  entity?: { position: Vec3 };
  entities?: Record<string, { name?: string; position?: Vec3; metadata?: unknown[]; height?: number } | undefined>;
  inventory?: { items?(): Array<{ name: string; count: number }>; slots?: Array<{ name?: string; count?: number } | null | undefined> };
  registry?: any;
  world?: any;
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
    try { needs = readNeeds(bot, at, now); } catch { needs = []; }
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

  // iron and wood: blocks in the loaded chunks.
  const iron = count(name => name === 'iron_ingot' || name === 'raw_iron' || IRON_ORES.includes(name))
    + 9 * count(name => name === 'iron_block' || name === 'raw_iron_block')
    + [...items, ...worn].reduce((sum, item) => sum + (IRON_IN[item.name] ?? 0) * ((item as { count?: number }).count ?? 1), 0);
  if (iron < IRON_ENOUGH) out.push(...pick(blockNeeds(bot, 'iron', IRON_ORES, now)));
  const planks = count(name => name.endsWith('_planks')) + 4 * count(name => /_(log|wood|stem|hyphae)$/.test(name));
  if (planks < WOOD_ENOUGH) {
    const logs = Object.keys(bot.registry?.blocksByName ?? {}).filter(name => name.endsWith('_log') && !name.startsWith('stripped_'));
    out.push(...pick(blockNeeds(bot, 'wood', logs, now)));
  }
  return out.slice(0, MAX_NEEDS);
}

/** Those that can be got at first, then the nearest; PER_NEED of them. */
function pick(needs: NearbyNeed[]): NearbyNeed[] {
  return needs.sort((a, b) => Number(b.canReach) - Number(a.canReach) || a.distance - b.distance).slice(0, PER_NEED);
}

/** An animal, with whether a straight line from the eyes reaches it (judged only for the ones said: a few rays, no flood fill). */
function animalNeed(bot: NeedsBody, at: Vec3, need: NearbyNeed['need'], entity: { name: string; position: Vec3; height?: number }, distance: number, color?: string): NearbyNeed {
  const seen = inSight(bot, at.offset(0, 1.62, 0), entity.position.offset(0, (entity.height ?? 1) * 0.5, 0));
  return { need, name: entity.name, ...(color ? { color } : {}), position: rounded(entity.position), distance: Math.round(distance * 10) / 10,
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
    return { need, name: hit.name, position: rounded(hit.position), distance: Math.round(hit.distance * 10) / 10,
      canReach: !failed, ...(exposed ? {} : { exposed: false }), ...(failed ? { why: 'failed_recently' as const } : {}) };
  });
}

function rounded(position: Vec3): { x: number; y: number; z: number } {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}
