/**
 * Where the body stands to set a bed down, and to lie in one (run 6, 11/11 07:14 JST): from a one-wide water pit the body set a bed into a
 * cave pocket behind two blocks of rock (the server takes a place across rock, it checks reach only), then looked for "its" bed within
 * three blocks of its feet cell, did not find it (3.3 away) and stopped, the bed lost for the rest of the run.
 *
 * A bed is used from a stand: a cell the body can walk to, from which (1) the nearer half of the bed is within the server's sleep range
 * (3.0 across, 2.0 up; here 2.5 and 1.5, a margin for drift), (2) the foot cell is within use reach of the eyes, (3) nothing solid is
 * between the eyes and the foot cell. A stand in water or fire is none. Pure over a `blockAt`: the doing (walking, placing) is the skill's.
 */
import { Vec3 } from 'vec3';
import { floorOpensWhenUsed } from './bedSpot.js';
import { STAND_USE_REACH, stationAccess, type StationBot } from './workstationAccess.js';

/** Cells the sleep range takes across and up from the stand (the server's 3.0 and 2.0, less a margin for the body's drift). */
const SLEEP_ACROSS = 2.5;
const SLEEP_UP = 1.5;
const LIQUID = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column']);
const HURTS = new Set(['fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'campfire', 'soul_campfire']);

export type BedStandBot = StationBot & { blockAt: (position: Vec3) => any };

export interface BedStandPlan {
  /** The foot cell (the one the bed is set on) and the head cell beyond it, away from the stand. */
  foot: Vec3;
  head: Vec3;
  /** The cell the body stands in (its feet cell); `here` when that is the cell it is in. */
  stand: Vec3;
  here: boolean;
  /** Steps of walk from the body to the stand. */
  steps: number;
}

export interface BedStandOptions {
  /** Cells round a stand searched for the foot cell (default 3). */
  radius?: number;
  /** Eyes to the foot cell centre (default and at most STAND_USE_REACH). */
  reach?: number;
  /** Cells the body can walk to, from `walkableCells`; without it only the cell the body is in is a stand. */
  walk?: Map<string, number>;
  /** A cell a bed may replace (air, grass...). */
  isFree: (block: any) => boolean;
  /** A foot cell not to choose (a bed did not come there lately). */
  skip?: (cell: Vec3) => boolean;
  /** The cells a body at this place fills (a bed is never put into them). */
  bodyAt?: (at: { x: number; y: number; z: number }) => Vec3[];
}

const at = (bot: BedStandBot, cell: Vec3): any => { try { return bot.blockAt(cell) ?? null; } catch { return null; } };
const nameOf = (block: any) => String(block?.name ?? '');
const hurtsAt = (bot: BedStandBot, cell: Vec3) => { const name = nameOf(at(bot, cell)); return LIQUID.has(name) || HURTS.has(name); };
const cellOf = (position: { x: number; y: number; z: number }) => new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));

/** The body's own cell is in water or fire (a run-6 pit): no stand there. */
export function bodyInHazard(bot: BedStandBot): boolean {
  const feet = cellOf(bot.entity.position);
  return hurtsAt(bot, feet) || hurtsAt(bot, feet.offset(0, 1, 0));
}

/** Whether a bed with these two halves is in the sleep range from `from` (the nearer half counts, as on the server). */
export function inSleepRange(from: { x: number; y: number; z: number }, halves: Array<{ x: number; y: number; z: number }>): boolean {
  return halves.some(half => Math.abs(half.x + 0.5 - from.x) <= SLEEP_ACROSS && Math.abs(half.z + 0.5 - from.z) <= SLEEP_ACROSS
    && Math.abs(from.y - half.y) <= SLEEP_UP);
}

/** The block that hides `cell` from the eyes of a body at `from`, as "name(x,y,z)", or '' when nothing does (or it is not known). */
export function whatHides(bot: BedStandBot, cell: Vec3, from: Vec3 = bot.entity.position): string {
  const seen = stationAccess(bot, cell, from, 99);
  return seen.obstruction ? `${seen.obstruction.name}(${seen.obstruction.position.x},${seen.obstruction.position.y},${seen.obstruction.position.z})` : '';
}

/** The stands in the order of preference: where the body is, then the cells it can walk to, nearest first. */
function* stands(bot: BedStandBot, walk?: Map<string, number>): Generator<{ cell: Vec3; at: Vec3; here: boolean; steps: number }> {
  const pos = bot.entity.position;
  const here = cellOf(pos);
  if (!bodyInHazard(bot)) yield { cell: here, at: pos, here: true, steps: 0 };
  for (const [key, steps] of walk ?? []) {
    const [x, y, z] = key.split(',').map(Number);
    const cell = new Vec3(x, y, z);
    if (cell.equals(here)) continue;
    yield { cell, at: new Vec3(x + 0.5, y, z + 0.5), here: false, steps };
  }
}

/**
 * The stand, foot cell and head cell for a bed to be set down: the first stand (the body's own cell, then the nearest walk) that has a
 * free 2x1 floor with air over it, in sleep range, in reach and in sight. Null when there is none (the body in water: none at all).
 */
export function planBedStand(bot: BedStandBot, options: BedStandOptions): BedStandPlan | null {
  const radius = options.radius ?? 3;
  const reach = Math.min(options.reach ?? STAND_USE_REACH, STAND_USE_REACH);
  for (const stand of stands(bot, options.walk)) {
    const body = options.bodyAt?.(stand.at) ?? [];
    const found: Array<{ foot: Vec3; head: Vec3; distance: number }> = [];
    for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) for (const y of [0, -1, 1]) {
      if (!x && !z) continue;
      const foot = stand.cell.offset(x, y, z);
      const dir = Math.abs(x) >= Math.abs(z) ? new Vec3(Math.sign(x), 0, 0) : new Vec3(0, 0, Math.sign(z));
      const head = foot.plus(dir);
      if (!inSleepRange(stand.at, [foot, head])) continue;
      if ([foot, head].some(cell => body.some(b => b.equals(cell)))) continue;
      if (options.skip?.(foot)) continue;
      if (![foot, head].every(cell => options.isFree(at(bot, cell)))) continue;
      // On solid ground that is not used by a right click, with no solid block over either half (the server's "obstructed").
      const floorOk = (cell: Vec3) => { const under = at(bot, cell.offset(0, -1, 0)); return under?.boundingBox === 'block' && !floorOpensWhenUsed(under); };
      const openAbove = (cell: Vec3) => at(bot, cell.offset(0, 1, 0))?.boundingBox !== 'block';
      if (![foot, head].every(cell => floorOk(cell) && openAbove(cell))) continue;
      const seen = stationAccess(bot, foot, stand.at, reach);
      if (!seen.inReach || !seen.clear) continue;
      found.push({ foot, head, distance: seen.eyeDistance });
    }
    if (!found.length) continue;
    found.sort((a, b) => a.distance - b.distance);
    return { foot: found[0].foot, head: found[0].head, stand: stand.cell, here: stand.here, steps: stand.steps };
  }
  return null;
}

/**
 * The stand to lie in a bed that is already there (either half given): in sleep range, the bed in reach and in sight. Null when no cell
 * the body can walk to has all three (the bed behind rock, or across water).
 */
export function planBedApproach(bot: BedStandBot, bed: Vec3, other: Vec3 | null, options: { walk?: Map<string, number>; reach?: number } = {}):
  { stand: Vec3; here: boolean; steps: number } | null {
  const reach = Math.min(options.reach ?? STAND_USE_REACH, STAND_USE_REACH);
  const halves = other ? [bed, other] : [bed];
  for (const stand of stands(bot, options.walk)) {
    if (!inSleepRange(stand.at, halves)) continue;
    if (!halves.some(half => { const seen = stationAccess(bot, half, stand.at, reach); return seen.inReach && seen.clear; })) continue;
    return { stand: stand.cell, here: stand.here, steps: stand.steps };
  }
  return null;
}

