import { timedEngagement } from '../utils/engagement.js';
import { potionIn } from '../utils/potionContents.js';
import type { WorldDelta, WorldFrame, WorldInventoryStack, WorldObservation, WorldVector } from './types.js';
import { roundedExertion, type Exertion } from '../utils/exertionMeter.js';
import { closingSpeed, secondsToContact } from '../utils/threatTracker.js';
import { threatExposure } from '../utils/threatExposure.js';
import { isSealedIn } from '../utils/shelter.js';
import { builtAroundStatus } from '../utils/builtAround.js';
import { creeperLit } from '../utils/creeperFuse.js';
import { backgroundJobs } from '../execution/backgroundJobs.js';

/** The shelter check, for whatever stands in for a body here (a cached self-state has no world to read). */
function sealedIn(bot: unknown): boolean {
  const body = bot as { entity?: { position?: { floored?: unknown } }; blockAt?: unknown } | undefined;
  if (typeof body?.blockAt !== 'function' || typeof body.entity?.position?.floored !== 'function') return false;
  try { return isSealedIn(body as any); } catch { return false; }
}

const MAX_NEARBY_ENTITIES = 16;
/** How far out a hostile's exposure is judged: beyond this it is no immediate concern either way. */
const EXPOSURE_RANGE = 32;

interface WorldFrameEntityLike {
  id?: number;
  position?: unknown;
  name?: string;
  username?: string;
  displayName?: { toString(): string } | string;
  type?: string;
  isInWater?: boolean;
  metadata?: unknown[];
  effects?: Record<string, { id?: number; amplifier?: number }>;
}

/** Minimal structural view used by observation; avoids coupling cognition to Mineflayer internals. */
export interface WorldFrameBotLike {
  entity?: WorldFrameEntityLike;
  entities?: Record<string, WorldFrameEntityLike | undefined>;
  inventory?: { items?(): Array<{ name: string; count: number; maxDurability?: number; durabilityUsed?: number }> };
  currentWindow?: { type?: string; inventoryStart: number; inventoryEnd: number; slots: Array<{ name: string; count: number } | null> } | null;
  registry?: { effects?: Record<string, { name: string }>; entitiesByName?: Record<string, { type?: string }>; biomes?: Record<number, { name?: string }> };
  world?: { getBiome?(position: unknown): unknown };
  time?: { timeOfDay?: number };
  isRaining?: boolean;
  game?: { dimension?: unknown };
  heldItem?: { name?: string } | null;
  health?: number;
  food?: number;
  isInWater?: boolean;
  environmentState?: {
    dimension?: unknown;
    weather?: string;
    time?: string;
    biome?: string;
  };
  selfState?: {
    botPosition?: unknown;
    botHeldItem?: string;
    inventory?: Array<{ name: string; count: number }>;
  };
}

/** Present only on a live body: the hunger reserve, the exertion so far and the chosen pace. */
function bodyEconomy(bot: unknown): Pick<WorldObservation, 'saturation' | 'exertion' | 'movementPace'> {
  const body = bot as { foodSaturation?: unknown; exertion?: Exertion; movementPace?: unknown } | undefined;
  const exertion = roundedExertion(body?.exertion);
  return {
    ...(typeof body?.foodSaturation === 'number' && Number.isFinite(body.foodSaturation) ? { saturation: Math.round(body.foodSaturation * 10) / 10 } : {}),
    ...(exertion ? { exertion, movementPace: body?.movementPace === 'walk' ? 'walk' as const : 'sprint' as const } : {}),
  };
}

/** The player window's armour slots and off hand, in mineflayer's numbering. */
const WORN_SLOTS: ReadonlyArray<[number, string]> = [[5, '頭'], [6, '胴'], [7, '脚'], [8, '足'], [45, '左手']];

/**
 * What the body wears and holds in the off hand, in one line. The pack (`inventory`) is slots 9-44 only, so armour put
 * on and a shield in the off hand were in no observation: only get-equipment told of them.
 */
function wornLine(bot: unknown): Pick<WorldObservation, 'worn'> {
  const slots = (bot as { inventory?: { slots?: unknown } } | undefined)?.inventory?.slots;
  if (!Array.isArray(slots)) return {};
  return { worn: WORN_SLOTS.map(([slot, label]) => {
    const item = slots[slot] as { name?: string; maxDurability?: unknown; durabilityUsed?: unknown } | null | undefined;
    if (!item?.name) return `${label}: なし`;
    const max = item.maxDurability, used = item.durabilityUsed;
    return `${label}: ${item.name}${typeof max === 'number' && max > 0 && typeof used === 'number' ? `(残り${Math.max(0, max - used)}/${max})` : ''}`;
  }).join('、') };
}

const NIGHTFALL_TICK = 13000;
const MORNING_TICK = 23000;
const HIT_RANGE = 24;

/**
 * The body's reserves as a planner can weigh them. Health, food and the clock were each in the observation
 * as bare numbers; what they came to was left to be worked out, and was not: bodies went back to their work
 * at 7 health with nothing to eat and no regeneration, at dusk, and the next mob finished them (paid runs
 * L64, L65, L70). Nothing here is a rule: the damage a hit does is what the body has measured.
 */
function survivalMargin(bot: unknown, health: number | null, food: number | null, timeOfDay: number | null,
  inventory: Array<{ name: string; count: number }>, threats: Array<{ name: string; distance: number; canReachMe?: false }>): WorldObservation['margin'] | undefined {
  if (health === null || food === null) return undefined;
  const body = bot as { registry?: { foodsByName?: Record<string, unknown> }; combatStats?: () => { mobs?: Record<string, { hits: number; damage: number }> } } | undefined;
  const foods = body?.registry?.foodsByName;
  const tick = timeOfDay === null ? null : ((timeOfDay % 24000) + 24000) % 24000;
  let hitsLeft: { from: string; hits: number } | undefined;
  try {
    const mobs = body?.combatStats?.().mobs;
    if (mobs) {
      let hardest: { from: string; perHit: number } | null = null;
      for (const threat of threats) {
        if (threat.canReachMe === false || threat.distance > HIT_RANGE) continue;
        const measured = mobs[threat.name];
        if (!measured || measured.hits <= 0) continue;
        const perHit = measured.damage / measured.hits;
        if (perHit > 0 && (!hardest || perHit > hardest.perHit)) hardest = { from: threat.name, perHit };
      }
      if (hardest) hitsLeft = { from: hardest.from, hits: Math.max(0, Math.ceil(health / hardest.perHit)) };
    }
  } catch { /* no measurements: nothing said */ }
  return {
    ...(tick !== null && tick < NIGHTFALL_TICK ? { darkInSeconds: Math.round((NIGHTFALL_TICK - tick) / 20) } : {}),
    ...(tick !== null && tick >= NIGHTFALL_TICK && tick < MORNING_TICK ? { darkInSeconds: 0, lightInSeconds: Math.round((MORNING_TICK - tick) / 20) } : {}),
    regenerating: food >= 18,
    foodItems: foods ? inventory.filter(item => item.name in foods).reduce((sum, item) => sum + item.count, 0) : 0,
    ...(hitsLeft ? { hitsLeft } : {}),
  };
}

const biomeCache = new WeakMap<object, { key: string; name: string }>();
/**
 * The biome under the body, read from the world itself. `environmentState.biome` is filled by `auto-update-state`, which the
 * common-FCA body never runs, so it stayed empty. Cached per 2-block cell (a biome does not change inside one) so the 100 ms
 * observation does not look it up each time; an unloaded cell is null, never an empty string.
 */
function biomeAt(bot: WorldFrameBotLike | undefined): string | null {
  const world = bot?.world, position = bot?.entity?.position as { x?: number; y?: number; z?: number } | undefined;
  if (!bot || typeof world?.getBiome !== 'function' || !position) return null;
  const x = finiteNumber(position.x), y = finiteNumber(position.y), z = finiteNumber(position.z);
  if (x === null || y === null || z === null) return null;
  const key = `${Math.floor(x / 2)},${Math.floor(y / 2)},${Math.floor(z / 2)}`;
  const cached = biomeCache.get(bot);
  if (cached?.key === key) return cached.name;
  try {
    const id = world.getBiome(bot.entity!.position);
    const name = typeof id === 'number' ? bot.registry?.biomes?.[id]?.name : undefined;
    if (!name) return null;
    biomeCache.set(bot, { key, name });
    return name;
  } catch { return null; }
}

/**
 * Furnaces still working, as said in the observation (the long instruction is the API's own wording). Under 600 characters, with the
 * number of furnaces left out said beside them (`jobsOmitted`): a mind that sees two of five must not think there are two.
 */
const JOBS_MAX_CHARS = 600;
function jobsFrame(bot: unknown): { jobs: NonNullable<WorldObservation['jobs']>; omitted: number } | undefined {
  const furnaces = (bot as { activeFurnaces?: unknown[] } | undefined)?.activeFurnaces;
  if (!Array.isArray(furnaces) || !furnaces.length) return undefined;
  const jobs = backgroundJobs(bot as Parameters<typeof backgroundJobs>[0]).map(job => ({
    status: job.status, remainingEstimateMs: job.remainingEstimateMs, input: job.input, count: job.count,
    position: { x: job.position.x, y: job.position.y, z: job.position.z },
    ...(job.unfueledInputCount ? { unfueledInputCount: job.unfueledInputCount } : {}), completionVerified: false as const,
  }));
  const total = jobs.length;
  while (jobs.length > 1 && JSON.stringify(jobs).length > JOBS_MAX_CHARS) jobs.pop();
  return jobs.length ? { jobs, omitted: total - jobs.length } : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function vector(value: unknown): WorldVector | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = finiteNumber(candidate.x);
  const y = finiteNumber(candidate.y);
  const z = finiteNumber(candidate.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function distance(a: WorldVector, b: WorldVector): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export function captureWorldObservation(bot?: unknown): WorldObservation {
  const observedBot = bot as WorldFrameBotLike | undefined;
  const position = vector(observedBot?.entity?.position ?? observedBot?.selfState?.botPosition);
  const window = observedBot?.currentWindow;
  const windowKnown = window && Number.isInteger(window.inventoryStart) && Number.isInteger(window.inventoryEnd)
    && window.inventoryStart >= 0 && window.inventoryEnd > window.inventoryStart && window.inventoryEnd <= window.slots.length;
  const inventory = (windowKnown ? window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(item => item !== null)
    : observedBot?.inventory?.items?.() ?? observedBot?.selfState?.inventory ?? [])
    // A planner told not to re-query the inventory saw only names, so a worn
    // pickaxe broke unannounced and left a paid run (L13) stranded underground.
    .map(item => {
      const { maxDurability: max, durabilityUsed: used } = item as { maxDurability?: unknown; durabilityUsed?: unknown };
      // Every potion is the one item: what it is a potion of is said beside it (see potionContents).
      const contents = potionIn(item as { name?: string; components?: unknown });
      return typeof max === 'number' && max > 0 && typeof used === 'number' && Number.isFinite(used)
        ? { name: item.name, count: item.count, durability: { left: Math.max(0, max - used), max } }
        : contents ? { name: item.name, count: item.count, contents } : { name: item.name, count: item.count };
    })
    .filter(item => item.name && Number.isFinite(item.count) && item.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const allEntities = position
    ? Object.values(observedBot?.entities ?? {})
      .filter((entity): entity is WorldFrameEntityLike => Boolean(entity?.position) && entity !== observedBot?.entity)
      .map(entity => {
        const entityPosition = vector(entity.position);
        if (!entityPosition) return null;
        const range = distance(position, entityPosition);
        // Only what the body has measured: approach rate and the time it leaves.
        const closing = closingSpeed(observedBot, entity.id);
        const contact = secondsToContact(range, closing);
        const kind = observedBot?.registry?.entitiesByName?.[entity.name ?? '']?.type ?? entity.type ?? 'unknown';
        // A hostile with rock all round between it and the body: near, but it can neither see nor get here.
        const sealed = kind === 'hostile' && range <= EXPOSURE_RANGE && threatExposure(observedBot as any, entity as any) === 'sealed';
        return {
          name: entity.name ?? entity.username ?? entity.displayName?.toString?.() ?? 'unknown',
          kind,
          distance: Math.round(range * 100) / 100,
          position: entityPosition,
          ...(closing !== null && Math.abs(closing) >= 0.3 ? { closingSpeed: Math.round(closing * 10) / 10 } : {}),
          ...(contact !== null ? { secondsToContact: Math.round(contact * 10) / 10 } : {}),
          ...(entity.name === 'creeper' ? { ignited: creeperLit(entity) } : {}),
          ...(sealed ? { canReachMe: false as const } : {}),
        };
      })
      .filter((entity): entity is NonNullable<typeof entity> => entity !== null)
      .sort((a, b) => a.distance - b.distance)
    : [];
  const nearbyEntities = allEntities.slice(0, MAX_NEARBY_ENTITIES);
  const landmarks = (observedBot as { landmarks?: WorldObservation['landmarks'] } | undefined)?.landmarks;
  // Separate budget: item crowds must not erase an observed hostile.
  const nearbyThreats = allEntities.filter(entity => entity.kind === 'hostile').slice(0, MAX_NEARBY_ENTITIES);

  const activeEffectsValue = (observedBot as unknown as { activeEffects?: unknown })?.activeEffects;
  const nativeEffects = observedBot?.entity?.effects;
  const activeEffects = nativeEffects ? Object.entries(nativeEffects).map(([id, effect]) => ({
    name: observedBot?.registry?.effects?.[String(effect.id ?? id)]?.name ?? `effect_${effect.id ?? id}`,
    amplifier: finiteNumber(effect.amplifier) ?? 0,
  })) : Array.isArray(activeEffectsValue)
    ? activeEffectsValue
      .filter(effect => effect && typeof effect === 'object')
      .map(effect => {
        const value = effect as { name?: unknown; amplifier?: unknown };
        return {
          name: typeof value.name === 'string' ? value.name : 'unknown',
          amplifier: finiteNumber(value.amplifier) ?? 0,
        };
      })
    : [];

  const observedAt = new Date().toISOString();
  const isInWater = observedBot?.entity?.isInWater ?? observedBot?.isInWater;
  const timeOfDay = finiteNumber(observedBot?.time?.timeOfDay);
  const time = timeOfDay !== null ? String(timeOfDay) : observedBot?.environmentState?.time || null;
  // A thunderstorm is said apart from rain: the body may sleep in it by day (get-time-and-weather said so, and is no longer offered).
  const thunder = observedBot?.isRaining === true && Number((observedBot as { thunderState?: unknown }).thunderState) > 0;
  const weather = typeof observedBot?.isRaining === 'boolean' ? thunder ? 'thunder' : observedBot.isRaining ? 'rain' : 'clear' : observedBot?.environmentState?.weather || null;
  const fact = (value: unknown, source: 'native' | 'window' | 'cache', known: boolean) => ({ value: known ? value : null, observedAt, source, coverage: known ? 'known' as const : 'unknown' as const });
  return {
    observedAt,
    dimension: observedBot?.game?.dimension?.toString?.() ?? observedBot?.environmentState?.dimension?.toString?.() ?? null,
    position,
    health: finiteNumber(observedBot?.health),
    food: finiteNumber(observedBot?.food),
    oxygen: finiteNumber((observedBot as unknown as { oxygenLevel?: unknown })?.oxygenLevel),
    ...bodyEconomy(observedBot),
    ...(observedBot?.entity ? (() => { const margin = survivalMargin(observedBot, finiteNumber(observedBot?.health), finiteNumber(observedBot?.food),
      // Dark and light are the overworld's (see describeSituation): elsewhere the clock says nothing of safety.
      String(observedBot?.game?.dimension ?? 'overworld').includes('overworld') ? timeOfDay : null, inventory, nearbyThreats); return margin ? { margin } : {}; })() : {}),
    isInWater: isInWater ?? false,
    // Said only when true: a planner that went back to its task from a summary did not know it stood in the
    // shelter it had just closed, asked for a shelter again, and was walked out of it (paid run L70).
    ...(sealedIn(observedBot) ? { sealedInShelter: true as const } : {}),
    weather,
    time,
    biome: biomeAt(observedBot) ?? (observedBot?.environmentState?.biome || null),
    heldItem: observedBot?.heldItem?.name ?? observedBot?.selfState?.botHeldItem ?? null,
    ...wornLine(observedBot),
    inventory,
    activeEffects,
    nearbyEntities,
    nearbyThreats,
    ...(landmarks?.length ? { landmarks: structuredClone(landmarks) } : {}),
    ...(() => {
      try {
        const remembered = (observedBot as { placeMemory?: { digest(limit?: number): Record<string, string> } } | undefined)?.placeMemory?.digest(10);
        return remembered && Object.keys(remembered).length ? { rememberedPlaces: remembered } : {};
      } catch { return {}; }
    })(),
    ...(() => {
      // The last death, while its dropped items may still lie there or for half an hour: a cue to go back for them.
      try {
        const memory = (observedBot as { placeMemory?: { lastDeath?(): string | undefined; deaths?(): WorldObservation['deaths'] } } | undefined)?.placeMemory;
        const line = memory?.lastDeath?.(), deaths = memory?.deaths?.();
        // `deaths` is for the API's recall (a death raises its "died" cue); `lastDeath` is the line to act on.
        return { ...(line ? { lastDeath: line } : {}), ...(deaths?.length ? { deaths } : {}) };
      } catch { return {}; }
    })(),
    ...(() => {
      try {
        const built = builtAroundStatus(observedBot);
        return built ? { builtAround: built } : {};
      } catch { return {}; }
    })(),
    ...(() => {
      try {
        const taken = timedEngagement(observedBot as object);
        return taken ? { acceptedThreats: `${taken.kinds.join('・')}（残り${taken.secondsLeft}秒）` } : {};
      } catch { return {}; }
    })(),
    ...(() => {
      try {
        const stops = (observedBot as { recentInterruptions?: () => string | null } | undefined)?.recentInterruptions?.();
        return stops ? { recentInterruptions: stops } : {};
      } catch { return {}; }
    })(),
    ...(() => {
      try {
        const reflexes = (observedBot as { reflexLedger?: { summary(): WorldObservation['reflexes'] } } | undefined)?.reflexLedger?.summary();
        return reflexes ? { reflexes } : {};
      } catch { return {}; }
    })(),
    ...(() => {
      // Only where the P8 layer is loaded (the reflex ledger is its mark: common-FCA mode): the legacy planner has its own
      // `get-background-jobs` and keeps the observation it had.
      try {
        if (!(observedBot as { reflexLedger?: unknown } | undefined)?.reflexLedger) return {};
        const frame = jobsFrame(observedBot);
        return frame ? { jobs: frame.jobs, ...(frame.omitted ? { jobsOmitted: frame.omitted } : {}) } : {};
      } catch { return {}; }
    })(),
    facts: {
      water: fact(isInWater, observedBot?.entity?.isInWater !== undefined ? 'native' : 'cache', isInWater !== undefined),
      inventory: fact(inventory, windowKnown ? 'window' : 'native', Boolean(windowKnown || observedBot?.inventory?.items)),
      time: fact(time, timeOfDay !== null ? 'native' : 'cache', time !== null),
      weather: fact(weather, typeof observedBot?.isRaining === 'boolean' ? 'native' : 'cache', weather !== null),
      effects: fact(activeEffects, nativeEffects ? 'native' : 'cache', Boolean(nativeEffects || Array.isArray(activeEffectsValue))),
    },
    container: windowKnown ? { type: window.type ?? 'unknown', items: window.slots.slice(0, window.inventoryStart)
      .filter(item => item !== null).map(item => ({ name: item.name, count: item.count })),
      fuel: finiteNumber((window as unknown as { fuel?: unknown }).fuel),
      progress: finiteNumber((window as unknown as { progress?: unknown }).progress) } : null,
  };
}

/** Timestamps describe samples, not changes in world content. */
export function worldContentDigest(world: WorldObservation): string {
  const { observedAt, facts, runId: _run, revision: _revision, ...content } = world as WorldFrame;
  return JSON.stringify({ ...content, facts: facts ? Object.fromEntries(Object.entries(facts)
    .map(([name, { observedAt: _timestamp, ...fact }]) => [name, fact])) : undefined });
}

export function diffWorldFrames(before: WorldFrame, after: WorldFrame): WorldDelta {
  const beforeInventory = inventoryCounts(before.inventory);
  const afterInventory = inventoryCounts(after.inventory);
  const names = new Set([...beforeInventory.keys(), ...afterInventory.keys()]);
  const inventoryDelta: WorldInventoryStack[] = [];
  for (const name of names) {
    const count = (afterInventory.get(name) ?? 0) - (beforeInventory.get(name) ?? 0);
    if (count !== 0) inventoryDelta.push({ name, count });
  }
  inventoryDelta.sort((a, b) => a.name.localeCompare(b.name));

  return {
    positionDelta: before.position && after.position
      ? {
          x: after.position.x - before.position.x,
          y: after.position.y - before.position.y,
          z: after.position.z - before.position.z,
        }
      : null,
    healthDelta: before.health === null || after.health === null ? null : after.health - before.health,
    foodDelta: before.food === null || after.food === null ? null : after.food - before.food,
    dimensionChanged: before.dimension !== after.dimension,
    inventoryDelta,
  };
}

function inventoryCounts(items: WorldInventoryStack[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}
