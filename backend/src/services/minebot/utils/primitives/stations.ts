import type { Cell } from '../localMap.js';
import { blockAt, eyeDistance, freeSlots, inventoryCount, DIG_REACH, type StepContext } from './common.js';
import { dig } from './dig.js';
import { furnaceBusy } from './furnace.js';
import { go } from './go.js';
import { pickup } from './pickup.js';
import { currentDimension, forgetStation, stationsOf, type Station } from './stationLedger.js';

/**
 * carryAway (run 5, 2026-11-11: four crafting tables and four furnaces left standing, 16 planks and 32 cobblestone with them): before a hand that
 * takes the body far from a station it set down, the body digs the station up and takes it into the pack, as a player picks up the table he put
 * down. The planner is not asked and nothing waits: it is a dig and a pickup (about 1 s), capped, and the hand runs as it was sent whatever
 * comes of it.
 *
 * Leaves it: the hand's target is within LEAVE_M of it (a walk back over that is shorter than the dig, and she uses it again), a furnace that has
 * a batch in it or waiting to be taken (`activeFurnaces`: the planner's job list owns it), a station a hand of this act names, a hostile within
 * 8 m, health under 8, the body in liquid or in the air, the station out of the body's 8 m, no pickaxe for a furnace, no room in the pack.
 * A station is forgotten once it is in the pack or its block is gone; one that stays standing after an attempt is kept (a later hand tries again, never inside
 * 15 s of the last try, and twice at most). The time given to one is the dig's own time (`bot.digTime`) and what the pickup settle takes.
 */
export const LEAVE_M = 10;
export const TAKE_RANGE_M = 8;
/** The time one station may take: its dig time and the collect and pickup after it, never under STATION_MIN_MS nor over STATION_MAX_MS (a table dug by hand is 3.75 s). */
export const STATION_MIN_MS = 6000;
export const STATION_MAX_MS = 10000;
export const STATION_EXTRA_MS = 3500;
export const WALK_EXTRA_MS = 3000;
export const HAND_MS = 14000;
export const RETRY_GAP_MS = 15000;
export const MAX_TRIES = 2;
export const SAFE_HOSTILE_M = 8;
export const SAFE_HP = 8;

export interface StationFacts {
  station: Station;
  /** The cells the hand is going to (a go's goals, a walk's end, a dig's cells, a vertical's end). */
  targets: Cell[];
  /** The cells later hands of this act name. */
  named: Cell[];
  /** The distance (m) from the body's feet to the station. */
  fromBody: number;
  sameDimension: boolean;
  busyFurnace: boolean;
  hostileNear: boolean;
  lowHealth: boolean;
  inLiquidOrAir: boolean;
  hasPickaxe: boolean;
  packFull: boolean;
}
export type StationVerdict = { do: 'take' } | { do: 'keep'; why: string; forget: boolean; say?: string };

const centre = (cell: { x: number; y: number; z: number }) => ({ x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 });
const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;
const nameOf = (station: Station) => `${station.block}(${station.x},${station.y},${station.z})`;

/** What to do with one station before a hand (pure: the facts are read by carryAway). */
export function judgeStation(facts: StationFacts): StationVerdict {
  const { station } = facts;
  if (!facts.sameDimension) return { do: 'keep', why: 'dimension', forget: true };
  if (!facts.targets.length) return { do: 'keep', why: 'no_target', forget: false };
  if (facts.named.some(cell => sameCell(cell, station)) || facts.targets.some(cell => sameCell(cell, station))) return { do: 'keep', why: 'named', forget: false };
  const from = centre(station);
  const nearest = Math.min(...facts.targets.map(cell => { const c = centre(cell); return Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z); }));
  if (nearest <= LEAVE_M) return { do: 'keep', why: 'near', forget: false };
  if (station.block !== 'crafting_table' && facts.busyFurnace) {
    return { do: 'keep', why: 'smelting', forget: false, say: `${nameOf(station)} は焼き途中・出来上がり待ちなので置いたまま` };
  }
  if (facts.fromBody > TAKE_RANGE_M) return { do: 'keep', why: 'far', forget: true };
  if (facts.hostileNear) return { do: 'keep', why: 'hostile', forget: false, say: `${nameOf(station)} は敵が近いので置いたまま` };
  if (facts.lowHealth || facts.inLiquidOrAir) return { do: 'keep', why: 'unsafe', forget: false };
  if (station.block !== 'crafting_table' && !facts.hasPickaxe) return { do: 'keep', why: 'no_pickaxe', forget: false };
  if (facts.packFull) return { do: 'keep', why: 'pack_full', forget: false };
  return { do: 'take' };
}

const isHostile = (bot: any, entity: any) => bot.registry?.entitiesByName?.[entity?.name]?.type === 'hostile';
function readFacts(ctx: StepContext, station: Station, targets: Cell[], named: Cell[]): StationFacts {
  const bot = ctx.bot;
  const at = bot.entity?.position;
  const from = centre(station);
  const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>;
  const busy = furnaceBusy(bot, station);
  const holding = station.holds === true;
  const stackable = items.some(item => item.name === station.block && item.count < 64);
  return {
    station, targets, named,
    fromBody: at ? Math.hypot(at.x - from.x, at.y - from.y, at.z - from.z) : Infinity,
    sameDimension: station.dim === currentDimension(bot),
    busyFurnace: busy || holding,
    hostileNear: !!at && Object.values(bot.entities ?? {}).some((entity: any) => entity && entity !== bot.entity && entity.position && isHostile(bot, entity)
      && entity.position.distanceTo(at) <= SAFE_HOSTILE_M),
    lowHealth: Number(bot.health ?? 20) < SAFE_HP,
    inLiquidOrAir: !!(bot.entity?.isInWater || bot.entity?.isInLava || bot.entity?.onGround === false),
    hasPickaxe: items.some(item => /_pickaxe$/u.test(item.name)),
    packFull: freeSlots(bot) === 0 && !stackable,
  };
}

/** A context whose stop is the act's or the time given (a slow dig is cut here and never takes the hand's time). */
function limited(ctx: StepContext, ms: number): { ctx: StepContext; done: () => void } {
  const control = new AbortController();
  const relay = () => control.abort(ctx.stop.reason);
  if (ctx.stop.aborted) control.abort(ctx.stop.reason); else ctx.stop.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(() => control.abort('station_time'), Math.max(0, ms));
  return { ctx: { ...ctx, stop: control.signal, deadline: Math.min(ctx.deadline, Date.now() + ms) }, done: () => { clearTimeout(timer); ctx.stop.removeEventListener('abort', relay); } };
}

/** How long one station may take: the dig's own time (with the tool held now) and the collect and pickup after it. */
export function stationMs(bot: any, station: Station): number {
  let dig = 0;
  try { const block = blockAt(bot, station); dig = typeof bot.digTime === 'function' && block ? Number(bot.digTime(block)) || 0 : 0; } catch { dig = 0; }
  return Math.max(STATION_MIN_MS, Math.min(STATION_MAX_MS, Math.round(dig) + STATION_EXTRA_MS));
}

/** What came of one attempt: in the pack, the block gone (dropped, not taken), or still standing. */
type TakeState = 'carried' | 'gone' | 'standing';

/** Digs the station up and takes it into the pack; says what came of it. Walks beside it first when it is out of the hand's reach. */
async function takeUp(ctx: StepContext, station: Station, ms: number): Promise<{ text: string; state: TakeState }> {
  const bot = ctx.bot;
  const cell = { x: station.x, y: station.y, z: station.z };
  const had = inventoryCount(bot, station.block);
  const run = limited(ctx, ms);
  try {
    if (eyeDistance(bot, cell) > DIG_REACH - 1) {
      const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [0, -1, 1].map(dy => ({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })));
      await go(run.ctx, { goals: beside, range: 1, maxDrop: 3, seconds: Math.max(1, Math.min(3, Math.floor(ms / 1000) - 3)) });
    }
    await dig(run.ctx, { at: [cell], take: true, collect: true });
    if (inventoryCount(bot, station.block) <= had) await pickup(run.ctx, { item: station.block, radius: 4, canDig: [] });
  } catch { /* the time or the act's stop: said from the pack below */ }
  finally { run.done(); }
  // The time ran out between the break and the pickup: the block is gone and its drop lies near; a short pickup (its own 2 s, the act's stop only) takes it.
  if (inventoryCount(bot, station.block) <= had && blockAt(bot, cell)?.name !== station.block && !ctx.stop.aborted) {
    const rest = limited(ctx, 2000);
    try { await pickup(rest.ctx, { item: station.block, radius: 4, canDig: [] }); } catch { /* the pack is read below */ }
    finally { rest.done(); }
  }
  const name = nameOf(station);
  if (inventoryCount(bot, station.block) > had) return { text: `出る前に ${name} を拾って持った`, state: 'carried' };
  const standing = blockAt(bot, cell)?.name === station.block;
  return standing ? { text: `${name} は拾えず置いたまま`, state: 'standing' }
    : { text: `${name} は掘ったが拾えていない（近くに落ちていれば pickup で）`, state: 'gone' };
}

/**
 * Before a hand whose body goes to `targets`: the stations set down that are left behind are taken up (see the head of this file). Returns the words
 * for the hand's line ('' when nothing was done or said). Never throws and never fails the hand.
 */
export async function carryAway(ctx: StepContext, targets: Cell[], named: Cell[] = []): Promise<string> {
  const bot = ctx.bot;
  const words: string[] = [];
  try {
    if (!targets.length || ctx.stop.aborted) return '';
    const started = Date.now();
    for (const station of stationsOf(bot)) {
      if (station.dim !== currentDimension(bot)) { forgetStation(bot, station); continue; }
      const here = blockAt(bot, station);
      if (here && here.name !== station.block) { forgetStation(bot, station); continue; }
      const verdict = judgeStation(readFacts(ctx, station, targets, named));
      if (verdict.do === 'keep') {
        if (verdict.forget) forgetStation(bot, station);
        if (verdict.say && !station.told) { station.told = true; words.push(verdict.say); }
        continue;
      }
      if (station.lastTry && Date.now() - station.lastTry < RETRY_GAP_MS) continue;
      const left = HAND_MS - (Date.now() - started);
      if (left < 800 || ctx.stop.aborted) break;
      station.lastTry = Date.now();
      const taken = await takeUp(ctx, station, Math.min(stationMs(bot, station) + (eyeDistance(bot, station) > DIG_REACH - 1 ? WALK_EXTRA_MS : 0), left));
      words.push(taken.text);
      if (taken.state === 'standing') { station.tries = (station.tries ?? 0) + 1; if (station.tries >= MAX_TRIES) forgetStation(bot, station); }
      else forgetStation(bot, station);
    }
  } catch { /* a help: the hand runs as it was sent */ }
  return words.join('。');
}
