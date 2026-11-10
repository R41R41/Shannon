import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { entityHealth } from '../mapMarks.js';
import { type Cell } from '../localMap.js';
import { cellText, findItem, guard, inventoryCount, stopped, wait, type StepContext, type StepOutcome } from './common.js';
import { actionSignal, nativeActionHost } from '../../execution/ActionExecution.js';
import { findEntity, isDying } from './use.js';
import { itemIds, itemsSince } from '../huntBarter.js';
import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { seesBodyAt } from '../threatExposure.js';
import { boxCentre, isPerched, partBox, phaseName } from '../dragonParts.js';
import { dragonPhaseOf } from '../dragonState.js';
import { bodyReader } from '../localMap.js';
import { CRYSTAL_REACH, CRYSTAL_SAFE_SHOT } from '../crystalBlast.js';
import { hasShootDiagnostics, noteShootDiagnostic, shootDiagnosticState } from '../shootDiagnostics.js';
import { arrowSegmentCells, firstSolidInArrowSegment } from '../arrowSegment.js';
import { holdShieldForDraw, msSinceShotComing } from '../shieldBlock.js';
import { dig } from './dig.js';
import { place } from './place.js';

/**
 * shoot: a bow or a crossbow at a creature or a cell (the owner's dragon list, 2026-10-21). The aim allows for the arrow's fall (the
 * game's own drag and gravity, tick by tick) and leads a moving target by its measured speed and the flight's time. The draw is held
 * for the seconds asked (a bow is at full power from 1 s; a crossbow loads in 1.25 s). The answer says whether it hit (the target was
 * hurt in the flight's time) and how many arrows are left.
 */
export interface ShootArgs { target?: string | number; at?: Cell; charge?: number; weapon?: 'bow' | 'crossbow'; shots?: number }

const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const ARROW_ENTITIES = new Set(['arrow', 'spectral_arrow']);

/** An aim about to be let go; a creature's also carries the point of it aimed at and what that arrow meets. */
interface ShotAim { yaw: number; pitch: number; ticks: number; far: number; label?: string; flight?: Flight; velocity?: Vec3 }
const EYE = 1.62;
const GRAVITY = 0.05;
const DRAG = 0.99;
const CROSSBOW_SPEED = 3.15;
const CROSSBOW_LOAD_MS = 1300;
/** A bow is held 21 ticks before it is let go (full power from 20: a tick over). */
export const BOW_FULL_DRAW_S = 1.05;
/**
 * Told once after arrows loosed at the dragon in flight (review 2026-11-10, KB1: a precedent spent 192 arrows on it before the crystals). The body is the part aimed at,
 * and a part other than the head takes a quarter and one more (partDamage: about 3 of an arrow's 9); a crystal that stands heals it back. The shot is not refused.
 * It stands before the shots' own lines: act clips a hand's line at 160 characters, and at the end of the text three shots or more cut it off.
 * "A crystal an arrow reaches": a caged one stops the arrow, and the head's knowledge leaves the cage for last.
 */
const FLYING_DRAGON_LINE = '飛んでいる竜は矢が当たりにくく、胴に当たっても 1 本で体力 200 のうち約 3、結晶が残る間は回復で消える。矢の通る結晶が残るなら矢はそちらが先';
/** An end crystal is shot from this far at the most (the arrow's range in the End). */
export const CRYSTAL_SHOT_MAX = 64;

/** First solid cell on the arrow's tick segments. The original goal exemption stays at its four endpoints.
 * unreadSamples counts actual unloaded-cell lookups; per-call cached repeats do not increment it. */
export function arrowBlockedAt(bot: any, eyes: Vec3, yaw: number, pitch: number, speed: number, ticks: number, goal: Vec3,
  trace?: { unreadSamples: number }): { x: number; y: number; z: number; name: string } | null {
  const nativeRead = bodyReader(bot), observed = new Map<string, ReturnType<typeof nativeRead>>();
  const read = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    if (!observed.has(key)) {
      const block = nativeRead(x, y, z); observed.set(key, block);
      if (trace && !block) trace.unreadSamples++;
    }
    return observed.get(key) ?? null;
  };
  let vx = -Math.sin(yaw) * Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed, vz = -Math.cos(yaw) * Math.cos(pitch) * speed;
  let x = eyes.x, y = eyes.y, z = eyes.z;
  for (let tick = 0; tick < ticks; tick++) {
    let previous = { x, y, z };
    for (let sub = 1; sub <= 4; sub++) {
      const px = x + vx * sub / 4, py = y + vy * sub / 4, pz = z + vz * sub / 4;
      if (Math.hypot(px - goal.x, py - goal.y, pz - goal.z) <= 1.2) return null;
      const point = { x: px, y: py, z: pz }, hit = firstSolidInArrowSegment(previous, point, read);
      if (hit) return hit;
      previous = point;
    }
    x += vx; y += vy; z += vz; vx *= DRAG; vy = vy * DRAG - GRAVITY; vz *= DRAG;
  }
  return null;
}

/** The refusal for a crystal shot from where the body is: too near (its blast reaches 12), too far, or no line to it. Null when it can be shot. */
function crystalShotProblem(bot: any, crystal: any, speed: number, launch?: { yaw: number; pitch: number; ticks: number }): StepOutcome | null {
  const eyes = bot.entity.position.offset(0, EYE - 0.1, 0);
  const distance = crystal.position.distanceTo(bot.entity.position);
  if (distance < CRYSTAL_SAFE_SHOT) return stopped(bot, 'too_close', `クリスタルまで ${distance.toFixed(1)}m。爆発は ${CRYSTAL_REACH}m まで届く: ${CRYSTAL_SAFE_SHOT}m 以上離れてから撃つ`);
  if (distance > CRYSTAL_SHOT_MAX) return stopped(bot, 'too_far', `クリスタルまで ${distance.toFixed(1)}m。矢は ${CRYSTAL_SHOT_MAX}m までしか狙えない。次: ${CRYSTAL_SHOT_MAX}m 以内まで近づく（${CRYSTAL_SAFE_SHOT}m 未満には入らない）`);
  const point = crystal.position.offset(0, 1, 0);
  const aim = launch ?? aimPitch(speed, Math.hypot(point.x - eyes.x, point.z - eyes.z), point.y - eyes.y);
  if (!aim) return stopped(bot, 'too_far', `クリスタルまで ${distance.toFixed(1)}m。弓の山なりでは届かない。次: 近づくか、高い足場から撃つ`);
  const yaw = launch?.yaw ?? Math.atan2(-(point.x - eyes.x), -(point.z - eyes.z));
  const trace = hasShootDiagnostics(bot) ? { unreadSamples: 0 } : undefined;
  const hit = arrowBlockedAt(bot, eyes, yaw, aim.pitch, speed, aim.ticks + 2, point, trace);
  noteShootDiagnostic(bot, () => ({ stage: 'crystal_ray', ...shootDiagnosticState(bot, crystal),
    eyes: { x: eyes.x, y: eyes.y, z: eyes.z }, goal: { x: point.x, y: point.y, z: point.z },
    speed, distance, aim: { yaw, pitch: aim.pitch, ticks: aim.ticks }, blocker: hit ? { ...hit } : null, unreadSamples: trace?.unreadSamples ?? null,
    unreadPolicy: 'unchanged_not_solid', checkPoint: 'crystal_check' }));
  if (hit) return stopped(bot, 'line_blocked', `クリスタルへの矢の道が (${hit.x},${hit.y},${hit.z}) の ${hit.name} に塞がれる（距離 ${distance.toFixed(1)}m）。位置を変えるか、塞ぐ物を掘る`, { x: hit.x, y: hit.y, z: hit.z });
  return null;
}

/** The game grows a creature's box by this much when it asks whether an arrow's tick meets it (ProjectileUtil's margin). */
const ARROW_MARGIN = 0.3;

/** A creature as an arrow meets it: its feet now, its speed (blocks a tick), and its box. */
export interface FlightTarget { feet: Vec3; velocity: Vec3; width: number; height: number }
/** What an arrow let go now meets first: the creature's box, a solid cell (named), or nothing within the ticks asked. */
export type Flight = { kind: 'hit'; ticks: number } | { kind: 'block'; ticks: number; x: number; y: number; z: number; name: string } | { kind: 'miss' };

/** Where the segment from..to first enters the box (0..1 along it), or null when it does not touch it. */
function segmentBoxEntry(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, min: number[], max: number[]): number | null {
  const a = [from.x, from.y, from.z], d = [to.x - from.x, to.y - from.y, to.z - from.z];
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (d[axis] === 0) { if (a[axis] < min[axis] || a[axis] > max[axis]) return null; continue; }
    const p = (min[axis] - a[axis]) / d[axis], q = (max[axis] - a[axis]) / d[axis];
    enter = Math.max(enter, Math.min(p, q)); leave = Math.min(leave, Math.max(p, q));
    if (enter > leave) return null;
  }
  return enter;
}

/**
 * The arrow's flight as the game runs it, tick by tick (the whole tick's move, then drag and gravity): each tick's segment is read for
 * solid cells and for the creature's box where the creature will be by then (its speed carried on). The nearer of the two along the
 * segment is what the arrow meets. Unread cells stay not solid (the policy `arrowBlockedAt` keeps).
 */
export function arrowFlight(bot: any, eyes: Vec3, yaw: number, pitch: number, speed: number, target: FlightTarget, ticks: number): Flight {
  const nativeRead = bodyReader(bot), observed = new Map<string, ReturnType<typeof nativeRead>>();
  const read = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    if (!observed.has(key)) observed.set(key, nativeRead(x, y, z));
    return observed.get(key) ?? null;
  };
  let vx = -Math.sin(yaw) * Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed, vz = -Math.cos(yaw) * Math.cos(pitch) * speed;
  let x = eyes.x, y = eyes.y, z = eyes.z;
  const half = target.width / 2 + ARROW_MARGIN;
  for (let tick = 0; tick < ticks; tick++) {
    const from = { x, y, z }, to = { x: x + vx, y: y + vy, z: z + vz };
    const at = target.feet.plus(target.velocity.scaled(tick + 1));
    const meets = segmentBoxEntry(from, to, [at.x - half, at.y - ARROW_MARGIN, at.z - half], [at.x + half, at.y + target.height + ARROW_MARGIN, at.z + half]);
    for (const cell of arrowSegmentCells(from, to)) {
      if (meets !== null && cell.entry > meets) break;
      const block = read(cell.x, cell.y, cell.z);
      if (block?.solid === true) return { kind: 'block', ticks: tick + 1, x: cell.x, y: cell.y, z: cell.z, name: block.name };
    }
    if (meets !== null) return { kind: 'hit', ticks: tick + 1 };
    x = to.x; y = to.y; z = to.z; vx *= DRAG; vy = vy * DRAG - GRAVITY; vz *= DRAG;
  }
  return { kind: 'miss' };
}

/** The points of a creature's box an aim is tried at, in this order: its middle, then over and under it, then its two sides. */
const AIM_POINTS: ReadonlyArray<{ label: string; up: number; side: number }> = [
  { label: '真ん中', up: 0.5, side: 0 }, { label: '上', up: 0.8, side: 0 }, { label: '下', up: 0.2, side: 0 },
  { label: '左', up: 0.5, side: -0.35 }, { label: '右', up: 0.5, side: 0.35 },
];

export interface CreatureAim { yaw: number; pitch: number; ticks: number; label: string; flight: Flight }

/**
 * end1108c S7 (11/8): four shoot hands were refused because the line to the blaze's middle met a wall, and none was tried at the rest of
 * it. Each point of the box is aimed at (its fall allowed for, led by the creature's speed) and its flight run as the game would; the first
 * whose arrow meets the creature is the aim. When none does, the middle's aim and what its arrow meets (a wall, or nothing) are returned.
 * Null when even the middle is out of the bow's reach.
 */
export function creatureAim(bot: any, eyes: Vec3, creature: any, velocity: Vec3, speed: number): CreatureAim | null {
  const width = Number(creature.width ?? 0.6), height = Number(creature.height ?? 1.8);
  const target: FlightTarget = { feet: creature.position, velocity, width, height };
  const flat = Math.hypot(creature.position.x - eyes.x, creature.position.z - eyes.z) || 1;
  // Across the line of sight, horizontally (its left and right as the body sees it).
  const across = new Vec3(-(creature.position.z - eyes.z) / flat, 0, (creature.position.x - eyes.x) / flat);
  let first: CreatureAim | null = null;
  for (const at of AIM_POINTS) {
    const base = creature.position.offset(across.x * at.side * width, height * at.up, across.z * at.side * width);
    let point = base, aim: { pitch: number; ticks: number } | null = null;
    for (let round = 0; round < 3; round++) {
      aim = aimPitch(speed, Math.hypot(point.x - eyes.x, point.z - eyes.z), point.y - eyes.y);
      if (!aim) break;
      point = base.plus(velocity.scaled(aim.ticks));
    }
    if (!aim) { if (!first) return null; continue; }
    const yaw = Math.atan2(-(point.x - eyes.x), -(point.z - eyes.z));
    const flight = arrowFlight(bot, eyes, yaw, aim.pitch, speed, target, aim.ticks + 4);
    const tried: CreatureAim = { yaw, pitch: aim.pitch, ticks: aim.ticks, label: at.label, flight };
    if (flight.kind === 'hit') return tried;
    first ??= tried;
  }
  return first;
}

/**
 * The refusal for a creature (a blaze behind a wall of its room) when no point of it can be reached by an arrow: the arrow would hit the
 * wall, and the draw is a second of the body's time. Null when an aim meets it, when the flight meets nothing (the aim's own error: the
 * draw goes on and the post-draw aim is run again), or when the aim does not reach (that has its own words).
 */
/**
 * end1108f7 S7 (11/8): six shoot hands at blazes were refused 「真ん中・上・下・左右のどこを狙っても」 塞がれる with 「位置を変えるか」, and the
 * head had no place to change to: it shot once in 14 minutes. The cells to stand on near the body (a floor under them, two open cells, no
 * lava or fire) are tried nearest first, each with the flight run from its eyes as the game would; the first SPOTS_TOLD whose arrow meets
 * the creature are named in the refusal for the head to walk to.
 */
const SPOT_RADIUS = 5;
const SPOT_HEIGHTS = [0, -1, 1, -2, 2];
const SPOTS_TRIED = 80;
const SPOTS_TOLD = 2;
/**
 * end1108h7 S7 (11/8): the nearest spot told, (143,76,74), stood 1.1 m and 1.2 m from two other blazes with three in sight; she walked there
 * and went from 20 to 6 health in five seconds. Of the spots whose arrow meets the creature (up to SPOTS_WEIGHED), the ones the fewest
 * other shooters see come first, then the nearest; each is told with that count.
 */
const SPOTS_WEIGHED = 8;
const SHOOTERS = /^(blaze|ghast|skeleton|stray|wither_skeleton|pillager)$/u;
const SHOOTER_M = 24;
const HOT = /lava|fire|magma/u;
/** The other shooters (not `creature`) within SHOOTER_M whose sight reaches a body standing at `cell`. */
function shootersAt(bot: any, creature: any, cell: Cell, closed: (x: number, y: number, z: number) => boolean): number {
  const feet = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
  let seen = 0;
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity || entity === creature || entity.id === creature.id || !SHOOTERS.test(String(entity.name ?? ''))) continue;
    if (!entity.position || entity.position.distanceTo(feet) > SHOOTER_M || isDying(bot, entity)) continue;
    if (seesBodyAt(bot, entity, feet, closed)) seen++;
  }
  return seen;
}
export function clearShotSpots(bot: any, creature: any, speed: number, velocity: Vec3 = new Vec3(0, 0, 0)): Array<Cell & { m: number; others: number }> {
  const read = bodyReader(bot), at = bot.entity.position;
  const fx = Math.floor(at.x), fy = Math.floor(at.y), fz = Math.floor(at.z);
  const solidAt = (x: number, y: number, z: number) => read(x, y, z)?.solid === true;
  const hot = (x: number, y: number, z: number) => HOT.test(String(read(x, y, z)?.name ?? ''));
  const cells: Array<Cell & { m: number }> = [];
  for (const dy of SPOT_HEIGHTS) for (let dx = -SPOT_RADIUS; dx <= SPOT_RADIUS; dx++) for (let dz = -SPOT_RADIUS; dz <= SPOT_RADIUS; dz++) {
    const m = Math.hypot(dx, dz);
    if ((!dx && !dz) || m > SPOT_RADIUS) continue;
    cells.push({ x: fx + dx, y: fy + dy, z: fz + dz, m: m + Math.abs(dy) });
  }
  cells.sort((a, b) => a.m - b.m);
  const found: Array<Cell & { m: number; others: number }> = [];
  let tried = 0;
  for (const cell of cells) {
    if (found.length >= SPOTS_WEIGHED || tried >= SPOTS_TRIED) break;
    const { x, y, z } = cell;
    if (!solidAt(x, y - 1, z) || solidAt(x, y, z) || solidAt(x, y + 1, z) || hot(x, y, z) || hot(x, y - 1, z)) continue;
    tried++;
    const aim = creatureAim(bot, new Vec3(x + 0.5, y + EYE - 0.1, z + 0.5), creature, velocity, speed);
    if (aim?.flight.kind === 'hit') found.push({ x, y, z, m: Math.round(cell.m), others: shootersAt(bot, creature, { x, y, z }, solidAt) });
  }
  return found.sort((a, b) => a.others - b.others || a.m - b.m).slice(0, SPOTS_TOLD);
}

function creatureLineProblem(bot: any, creature: any, speed: number, velocity: Vec3 = new Vec3(0, 0, 0)): StepOutcome | null {
  const eyes = bot.entity.position.offset(0, EYE - 0.1, 0);
  const aim = creatureAim(bot, eyes, creature, velocity, speed);
  if (!aim || aim.flight.kind !== 'block') return null;
  const hit = aim.flight;
  // S1 lab 11/8: the cover reflex had put a cobblestone in the camp's window (beside the head), and the head was told 22 times to move or
  // wait; the cell beside the body is the window itself. end1108b S7: told 「掘れば矢の道が開く」 six times, the head never dug it, so
  // shoot opens it itself (`openWindow`); these words are left for when that could not be done.
  const spots = besideBody(bot, hit) ? [] : clearShotSpots(bot, creature, speed, velocity);
  const next = besideBody(bot, hit) ? `。体のすぐ隣のマス（窓）`
    : spots.length ? `。位置を変えるか、塞ぐ物を掘る。矢が届く立ち位置: ${spots.map(spot => `(${spot.x},${spot.y},${spot.z})（${spot.m}m、ほかの射手 ${spot.others} 体から見える）`).join('、')}。そこへ go してから撃つ`
      : '。位置を変えるか、的が通る所に出るのを待つか、塞ぐ物を掘る（近く 5m に矢が届く立ち位置は無い）';
  return stopped(bot, 'line_blocked', `${creature.name} への矢の道が (${hit.x},${hit.y},${hit.z}) の ${hit.name} に塞がれる（距離 ${creature.position.distanceTo(bot.entity.position).toFixed(1)}m、真ん中・上・下・左右のどこを狙っても）${next}`, { x: hit.x, y: hit.y, z: hit.z });
}

/** True when `cell` is one of the eight columns around the body's feet column, at the feet's or the head's height (a wall of its camp). */
export function besideBody(bot: any, cell: { x: number; y: number; z: number }): boolean {
  const at = bot.entity.position, fx = Math.floor(at.x), fy = Math.floor(at.y), fz = Math.floor(at.z);
  const dx = Math.abs(cell.x - fx), dz = Math.abs(cell.z - fz);
  return Math.max(dx, dz) === 1 && (cell.y === fy || cell.y === fy + 1);
}

/** A draw is cancelled by changing the held slot and back (releasing the bow would shoot). */
/** A shot seen coming within this long ago still counts as a volley in flight; the draw waits at most VOLLEY_WAIT_MS for the lull. */
const VOLLEY_QUIET_MS = 400;
const VOLLEY_WAIT_MS = 2500;
/** How long past the full draw the reflex keeps off the hands if the release never comes (the aim and the release's own looks). */
const DRAW_HOLD_SPARE_MS = 3000;

async function cancelDraw(bot: any, draw?: { end(owned: boolean): void } | null): Promise<void> {
  draw?.end(false);
  try {
    const slot = Number(bot.quickBarSlot ?? 0);
    bot.setQuickBarSlot?.((slot + 1) % 9);
    await new Promise(resolve => setTimeout(resolve, 80));
    bot.setQuickBarSlot?.(slot);
  } catch { /* the draw ends with the connection or the next hand */ }
}

/**
 * end1108h15 S7 (11/8): a hand stopped mid-draw (its stopIf, a hit taken, the head's cancel, the deadline) went through the stops'
 * deactivateItem, and releasing a drawn bow looses it: 9 of 30 arrows left in five stopped hands with no hit told, and with 0 arrows the
 * last 7 minutes had no kill. While the bow is drawn, a deactivateItem from anything but the shot's own release lets it down by the slot
 * (no arrow); a step stopped while the action still owns the body lets it down the same way before its letGo releases.
 */
export function guardDraw(bot: any): { loose(): void; end(owned: boolean): void } {
  const host = nativeActionHost(bot) as any;
  const deactivate = host.deactivateItem;
  let releasing = false, drawn = true;
  const letDown = (by: any) => {
    drawn = false;
    const slot = Number(by.quickBarSlot ?? 0);
    by.setQuickBarSlot?.((slot + 1) % 9);
    host.usingHeldItem = false;
  };
  const guarded = function (this: unknown, ...args: unknown[]) {
    if (!drawn || releasing) return deactivate?.apply(host, args);
    try { letDown(host); } catch { return deactivate?.apply(host, args); }
  };
  host.deactivateItem = guarded;
  const restore = () => { if (host.deactivateItem === guarded) host.deactivateItem = deactivate; };
  return {
    loose: () => { releasing = true; try { bot.deactivateItem(); } finally { releasing = false; drawn = false; restore(); } },
    end: (owned: boolean) => {
      restore();
      if (drawn && owned) { try { letDown(bot); } catch { /* the next hand takes the slot it needs */ } }
      drawn = false;
    },
  };
}

/**
 * end1108h8 S7: a forced look turns the body here but is told to the server only at the next physics tick, and the release went out at once,
 * so the arrow flew at the look sent before the draw (15 arrows in a row 「外れた」 at blazes 3 to 6 m off, which move far across the aim in
 * a second). The release waits for the tick that sends the look (no longer than SEND_LOOK_MS).
 */
const SEND_LOOK_MS = 120;
async function lookSent(bot: any): Promise<void> {
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); bot.removeListener?.('physicsTick', onTick); resolve(); };
    // The tick that sends it: the listener runs before the send in that tick, so the one after it has surely gone.
    let ticks = 0;
    const onTick = () => { if (++ticks >= 2) finish(); };
    const timer = setTimeout(finish, SEND_LOOK_MS);
    bot.on?.('physicsTick', onTick);
  });
}

/** How many of a kind (nearest first) are tried for a clear flight when the head names the kind, not one by its id. */
const KIND_TRIED = 6;
/** A hand that names a kind keeps going after a draw let down (its line blocked, its target gone) this many times in a row at the most. */
const LETDOWNS_IN_A_ROW = 2;

/**
 * end1108g7 S7 (11/8): 「shoot target=blaze」 took the nearest blaze, whose line met the nether bricks, while another flew in the open
 * (refused twice, then the head walked away). A kind named by its name is the nearest one of it an arrow from the eyes reaches (its flight
 * run as the game would, the creature taken as still); the nearest when none is. `skip` leaves out the ones already dealt with.
 */
export function clearestOfKind(bot: any, kind: string, speed: number, range = 96, skip: ReadonlySet<number> = new Set()): any {
  const at = bot.entity?.position;
  if (!at) return null;
  const eyes = at.offset(0, EYE - 0.1, 0);
  const all = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity && entity !== bot.entity && entity.position
    && String(entity.name ?? '').toLowerCase() === kind && !skip.has(entity.id) && entity.position.distanceTo(at) <= range && !isDying(bot, entity))
    .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
  for (const entity of all.slice(0, KIND_TRIED)) if (creatureAim(bot, eyes, entity, new Vec3(0, 0, 0), speed)?.flight.kind === 'hit') return entity;
  return all[0] ?? null;
}

/** True when an arrow let go from the eyes now would meet the creature. */
function clearNow(bot: any, creature: any, speed: number): boolean {
  return creatureAim(bot, bot.entity.position.offset(0, EYE - 0.1, 0), creature, new Vec3(0, 0, 0), speed)?.flight.kind === 'hit';
}

/**
 * end1108g7 S7: a blaze shot dead was never told (the line said 「当たった」 and the hand went on at nothing), and its rod lay where it fell,
 * 18 m off, unpicked. The kill is told with the place it died and what lies there now, each with its distance from the body.
 */
function killLine(bot: any, dead: { id: number; name: string; at: Vec3 }, baseline: Set<number>): string {
  const body = bot.entity.position;
  const spot = `${dead.name} #${dead.id} を倒した (${Math.floor(dead.at.x)},${Math.floor(dead.at.y)},${Math.floor(dead.at.z)})（${dead.at.distanceTo(body).toFixed(0)}m）`;
  const stacks = itemsSince(bot, baseline, dead.at, 6);
  if (!stacks.length) return `${spot}。落とし物は見えない（無かったか、まだ落ちていない）`;
  // end1108h7b S7: a rod told only by its place was asked for with a pickup by radius from 10 m off, which took the nearest brick instead and
  // stopped; the drop's own id lets pickup walk to that one (ids are not bound by the radius).
  const ids: number[] = [];
  const told = stacks.map(entity => {
    baseline.add(entity.id);
    ids.push(entity.id);
    let name = `#${entity.id}`, count = 1;
    try { const stack = entity.getDroppedItem?.(); if (stack?.name) { name = String(stack.name); count = Number(stack.count ?? 1); } } catch { /* its stack not here yet */ }
    const p = entity.position;
    return `${name}×${count} が (${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})（${p.distanceTo(body).toFixed(0)}m、id ${entity.id}）`;
  });
  return `${spot}。落とし物 ${told.join('、')}（pickup target=#${ids[0]} でその物へ歩いて拾う${ids.length > 1 ? `。ほかは target=#${ids.slice(1).join('・#')}` : ''}）`;
}

/**
 * end1108g7 S7: she shot from 18 m off the spawner and waited there, where no blaze comes (they come only while a player is within 16 m),
 * and the line never said how far it was. The distance to the spawner in sight, as attack's line tells it, and when it is past 16 m, why.
 */
function spawnerLine(bot: any): string {
  try {
    const spawner = scanLoadedBlocks(bot, ['spawner'], { maxHits: 1, maxDistance: 32 }).hits[0];
    if (!spawner) return '';
    const far = Math.round(spawner.distance * 10) / 10;
    return `。湧き場 (${spawner.position.x},${spawner.position.y},${spawner.position.z}) まで ${far}m${far > 16 ? '（16m より遠いと新しいブレイズは湧かない）' : ''}`;
  } catch { return ''; }
}

/** A bow's arrow speed (blocks a tick) after a draw of `seconds` (the game: power = (f^2 + 2f) / 3, f the draw in seconds, at most 1). */
export function bowSpeed(seconds: number): number {
  const f = Math.max(0, seconds);
  return Math.min(1, (f * f + 2 * f) / 3) * 3;
}

/**
 * The pitch (radians, up positive) to send an arrow of `speed` to a point `horizontal` blocks away and `rise` blocks up, on the low
 * arc, and the ticks of its flight; null when it cannot reach. Simulated as the game moves an arrow: move, drag, gravity.
 */
export function aimPitch(speed: number, horizontal: number, rise: number): { pitch: number; ticks: number } | null {
  // A target within two ticks of flight (a blaze hovering over a walled cell): the tick-by-tick search steps three blocks at a time and finds no pitch for it; the arrow flies straight there (the fall is a tenth of a block in so short a flight).
  const straight = Math.hypot(horizontal, rise);
  if (straight <= 2 * speed && speed > 0) return { pitch: Math.atan2(rise, horizontal), ticks: Math.max(1, Math.ceil(straight / speed)) };
  let best: { pitch: number; ticks: number; error: number } | null = null;
  for (let degrees = -89; degrees <= 89; degrees += 0.25) {
    const pitch = degrees * Math.PI / 180;
    let vx = Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed, x = 0, y = 0;
    for (let tick = 1; tick <= 200; tick++) {
      x += vx; y += vy;
      vx *= DRAG; vy = vy * DRAG - GRAVITY;
      if (x >= horizontal) {
        const error = Math.abs(y - rise);
        if (!best || error < best.error - 1e-9) best = { pitch, ticks: tick, error };
        break;
      }
      if (y < rise - 64) break;
    }
    // The low arc: the first pitch that comes within a tenth of a block is kept.
    if (best && best.error < 0.1) break;
  }
  return best && best.error < 1.0 ? { pitch: best.pitch, ticks: best.ticks } : null;
}

/** The target's speed (blocks a tick) measured over a fifth of a second. */
async function measureVelocity(ctx: StepContext, entity: any): Promise<Vec3> {
  const from = entity.position.clone();
  await wait(ctx, 200);
  const to = ctx.bot.entities?.[entity.id]?.position ?? from;
  return to.minus(from).scaled(1 / 4);
}

export async function shoot(ctx: StepContext, args: ShootArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const weaponName = args.weapon ?? (findItem(bot, 'bow') ? 'bow' : findItem(bot, 'crossbow') ? 'crossbow' : bot.heldItem?.name === 'crossbow' ? 'crossbow' : 'bow');
  const weapon = findItem(bot, weaponName) ?? (bot.heldItem?.name === weaponName ? bot.heldItem : null);
  if (!weapon) return stopped(bot, 'missing_item', `${weaponName} を持っていない`);
  const arrowsLeft = () => ARROWS.reduce((sum, name) => sum + inventoryCount(bot, name), 0);
  if (arrowsLeft() === 0 && bot.game?.gameMode !== 'creative') return stopped(bot, 'missing_item', '矢を持っていない');
  const crossbow = weaponName === 'crossbow';
  const charge = crossbow ? CROSSBOW_LOAD_MS / 1000 : Math.max(0.2, Math.min(1.2, args.charge ?? BOW_FULL_DRAW_S));
  const speed = crossbow ? CROSSBOW_SPEED : bowSpeed(charge);
  // A kind named by its name (not an id): the one whose arrow flies clear, and the next such one after a kill or a let-down draw.
  const named = typeof args.target === 'string' ? args.target.trim().toLowerCase().replace(/^minecraft:/u, '') : '';
  const kind = named && !/^#?\d+$/u.test(named) && named !== 'end_crystal' && named !== 'ender_dragon' ? named : null;
  let target = kind ? clearestOfKind(bot, kind, speed) : args.target !== undefined ? findEntity(bot, args.target, 96) : null;
  if (args.target !== undefined && !target) return stopped(bot, 'target_not_found', `${args.target} が 96m 内にいない`);
  if (!target && !args.at) return stopped(bot, 'invalid_input', 'shoot には target か at が要る');
  if (bot.heldItem?.type !== weapon.type) {
    const held = await guard(ctx, equipToHandVerified(bot, weapon), 5000);
    if (!held?.value.held) return stopped(bot, 'equip_failed', `${weaponName} を手に持てなかった`);
  }
  const shots = Math.max(1, Math.min(8, Math.round(args.shots ?? 1)));
  const results: string[] = [];
  let hits = 0, noArrows = 0, kills = 0, letdowns = 0;
  // An arrow loosed at the dragon in flight (a perched one is refused below): the result says what such an arrow is worth, the head chooses.
  let atFlyingDragon = false;
  // The items lying about before the hand: a kill's drops are the ones that were not.
  const baseline = itemIds(bot);
  const dealt = new Set<number>();
  /** The next of the kind with a clear flight (null when none is clear): told in the line when it is another one. */
  const nextClear = (): any => {
    if (!kind) return null;
    const next = clearestOfKind(bot, kind, speed, 96, dealt);
    if (!next || !clearNow(bot, next, speed)) return null;
    if (next.id !== target?.id) results.push(`矢の通る ${kind} #${next.id}（${next.position.distanceTo(bot.entity.position).toFixed(0)}m）へ替えた`);
    return next;
  };
  // The End: a crystal is shot from beyond its blast and along a clear line (asked again at every shot and before the release); a perched dragon takes nothing from an arrow.
  if (target?.name === 'ender_dragon') {
    const phase = dragonPhaseOf(bot, target);
    if (isPerched(phase)) return stopped(bot, 'perched_immune', `止まり木の竜（phase ${phase} ${phaseName(phase)}）に矢は効かない（飛んでいる間だけ。近接は attack）`);
  }
  // end1108b S7: the windows this hand opened in the body's own wall, shut again before it answers.
  const opened: Cell[] = [];
  const finish = async (outcome: StepOutcome): Promise<StepOutcome> => {
    if (!opened.length) return outcome;
    const shut = await shutWindows(ctx, opened);
    return { ...outcome, text: `${outcome.text}。${shut}` };
  };
  // A hand that ends by a throw (a cancel, a death) still shuts what it opened.
  try {
  for (let shot = 0; shot < shots; shot++) {
    let live = target ? bot.entities?.[target.id] : null;
    if (target && (!live || (kind && isDying(bot, live)))) {
      if (live) dealt.add(live.id);
      const next = nextClear();
      if (!next) { results.push(kind ? `矢の通る ${kind} が見えない` : '的が見えなくなった'); break; }
      target = next; live = next;
    }
    if (live && kind && !clearNow(bot, live, speed)) {
      // end1108g7 S7: refused at the nearest while another flew clear. Another of the kind whose arrow flies clear is taken first.
      const other = clearestOfKind(bot, kind, speed, 96, new Set([...dealt, live.id]));
      if (other && clearNow(bot, other, speed)) {
        results.push(`${kind} #${live.id} への矢の道は塞がれている。矢の通る #${other.id}（${other.position.distanceTo(bot.entity.position).toFixed(0)}m）へ替えた`);
        target = other; live = other;
      }
    }
    if (live?.name === 'end_crystal') {
      const refusal = crystalShotProblem(bot, live, speed);
      if (refusal) { if (shot === 0) return refusal; results.push(refusal.text); break; }
    }
    if (live && live.name !== 'end_crystal' && live.name !== 'ender_dragon') {
      let refusal = creatureLineProblem(bot, live, speed);
      // end1108b S7: the line is blocked by a cell of the body's own wall (beside its feet or head): the window is dug for this shot.
      if (refusal?.at && besideBody(bot, refusal.at) && opened.length < WINDOWS_PER_HAND) {
        const dug = await openWindow(ctx, refusal.at, String(live.name ?? ''));
        if (!dug.ok) refusal = { ...refusal, text: `${refusal.text}。窓を開けられなかった: ${dug.text.slice(0, 120)}` };
        else {
          opened.push(refusal.at);
          // The dig took the pickaxe into the hand: the bow is taken back before the draw.
          if (bot.heldItem?.type !== weapon.type) {
            const again = await guard(ctx, equipToHandVerified(bot, findItem(bot, weaponName) ?? weapon), 5000);
            if (!again?.value.held) return finish(stopped(bot, 'equip_failed', `窓を開けた後、${weaponName} を手に持ち直せなかった`));
          }
          refusal = creatureLineProblem(bot, bot.entities?.[live.id] ?? live, speed);
        }
      }
      if (refusal) { if (shot === 0) return finish(refusal); results.push(refusal.text); break; }
    }
    let cancelled: string | null = null;
    /** The aim from where the body and the target are now: the fall allowed for, the target led by its speed over the flight. */
    const aimNow = async (): Promise<ShotAim | null> => {
      const now = target ? bot.entities?.[target.id] : null;
      const velocity = now ? await measureVelocity(ctx, now) : new Vec3(0, 0, 0);
      const eyes = bot.entity.position.offset(0, EYE - 0.1, 0);
      const seen = target ? bot.entities?.[target.id] : null;
      if (target && !seen) return null;
      // A creature: the point of it the arrow can reach (its flight run as the game would, the creature carried on at its speed).
      if (seen && seen.name !== 'end_crystal' && seen.name !== 'ender_dragon') {
        const picked = creatureAim(bot, eyes, seen, velocity, speed);
        if (!picked) return { yaw: 0, pitch: 0, ticks: -1, far: Math.hypot(seen.position.x - eyes.x, seen.position.z - eyes.z) };
        const result: ShotAim = { yaw: picked.yaw, pitch: picked.pitch, ticks: picked.ticks, far: 0, label: picked.label, flight: picked.flight, velocity };
        noteShootDiagnostic(bot, () => ({ stage: 'aim', shot: shot + 1, ...shootDiagnosticState(bot, seen),
          eyes: { x: eyes.x, y: eyes.y, z: eyes.z }, speed, aim: { yaw: result.yaw, pitch: result.pitch, ticks: result.ticks, far: 0, label: picked.label, flight: picked.flight.kind } }));
        return result;
      }
      // The dragon is hit through its parts: the body's box (a 5 x 3 block at its feet), not the middle of its 16 x 8 one.
      const middle = seen?.name === 'ender_dragon' ? boxCentre(partBox({ position: seen.position, yaw: seen.yaw }, 'body')) : null;
      const base = middle ? new Vec3(middle.x, middle.y, middle.z) : seen ? seen.position.offset(0, (seen.height ?? 1.8) * 0.5, 0) : new Vec3(args.at!.x + 0.5, args.at!.y + 0.5, args.at!.z + 0.5);
      let point = base, aim: { pitch: number; ticks: number } | null = null;
      for (let round = 0; round < 3; round++) {
        aim = aimPitch(speed, Math.hypot(point.x - eyes.x, point.z - eyes.z), point.y - eyes.y);
        if (!aim) return { yaw: 0, pitch: 0, ticks: -1, far: Math.hypot(point.x - eyes.x, point.z - eyes.z) };
        point = base.plus(velocity.scaled(aim.ticks));
      }
      const result: ShotAim = { yaw: Math.atan2(-(point.x - eyes.x), -(point.z - eyes.z)), pitch: aim!.pitch, ticks: aim!.ticks, far: 0 };
      noteShootDiagnostic(bot, () => ({ stage: 'aim', shot: shot + 1, ...shootDiagnosticState(bot, seen),
        eyes: { x: eyes.x, y: eyes.y, z: eyes.z }, point: { x: point.x, y: point.y, z: point.z }, speed, aim: { ...result } }));
      return result;
    };
    let hurt = false;
    const onHurt = (entity: any) => { if (live && entity?.id === live.id) hurt = true; };
    // A crystal is not hurt: it breaks, and the client is told it is gone.
    const onGone = (entity: any) => { if (live && entity?.id === live.id && live.name === 'end_crystal') hurt = true; };
    const before = arrowsLeft();
    let aim: ShotAim | null = null;
    let shield: { release: () => void } | null = null;
    let draw: ReturnType<typeof guardDraw> | null = null;
    // An arrow seen leaving the body (a bow with Infinity takes none from the pack, so the count alone cannot tell).
    let arrowSeen = false;
    const onSpawn = (entity: any) => {
      if (ARROW_ENTITIES.has(String(entity?.name ?? '')) && entity.position && bot.entity?.position && entity.position.distanceTo(bot.entity.position) < 4) arrowSeen = true;
    };
    bot.on('entityHurt', onHurt); bot.on('entityGone', onGone); bot.on('entitySpawn', onSpawn);
    try {
      // A volley in flight is taken on the shield first (a blaze sends three, then rests): the draw starts in the lull.
      for (let waited = 0; waited < VOLLEY_WAIT_MS && msSinceShotComing(bot) < VOLLEY_QUIET_MS; waited += 100) await wait(ctx, 100);
      const first = await aimNow();
      if (first && first.ticks > 0) await guard(ctx, Promise.resolve(bot.look(first.yaw, first.pitch, true)), 1000);
      // A raised shield keeps the server from starting the draw at all; it comes down first, and the reflex keeps off the hands until the release.
      const held = holdShieldForDraw(bot, charge * 1000 + DRAW_HOLD_SPARE_MS);
      shield = held;
      if (held.lowered) await wait(ctx, 100);
      // end1108c S7 19:06:08: three draws let no arrow go (矢が減っていない) while the cover reflex had the hands. Something still in use
      // (a shield raised outside the reflex's own state, a bite of food) keeps the server from starting the draw: it is let go first,
      // and the bow is taken back if the hand was given something else.
      else if (bot.usingHeldItem === true) { bot.deactivateItem(); await wait(ctx, 100); }
      if (bot.heldItem?.type !== weapon.type) {
        const again = await guard(ctx, equipToHandVerified(bot, findItem(bot, weaponName) ?? weapon), 5000);
        if (!again?.value.held) { results.push(`${weaponName} が手から離れていて持ち直せなかった`); break; }
      }
      draw = crossbow ? null : guardDraw(bot);
      bot.activateItem();
      await wait(ctx, charge * 1000);
      if (crossbow) { bot.deactivateItem(); await wait(ctx, 100); }
      aim = await aimNow();
      if (!aim || aim.ticks < 0) {
        // Releasing a drawn bow fires it. An unusable post-draw aim ends by the same slot cancellation;
        // the crossbow's existing load/deactivate boundary does not fire an arrow and stays unchanged.
        if (crossbow) bot.deactivateItem(); else await cancelDraw(bot, draw);
      }
      else {
        // The body may have been knocked nearer to the crystal during the draw: its blast is not shot into.
        const near = live?.name === 'end_crystal' && bot.entities?.[live.id] ? bot.entity.position.distanceTo(live.position) : null;
        // A creature: the led aim's own flight (the one about to be let go) must not end in a wall.
        const drawnFlight = aim.flight, blockedNow = drawnFlight && drawnFlight.kind === 'block' ? drawnFlight : null;
        if (blockedNow) { cancelled = `引いている間に矢の道が塞がれた（${live?.name} を${aim.label ?? '真ん中'}に狙うと (${blockedNow.x},${blockedNow.y},${blockedNow.z}) の ${blockedNow.name} に当たる）ので放さなかった`; await cancelDraw(bot, draw); }
        else if (near !== null && near < CRYSTAL_SAFE_SHOT) { cancelled = `引いている間に ${near.toFixed(1)}m まで近づいたので放さなかった（${CRYSTAL_SAFE_SHOT}m 以上で撃つ）`; await cancelDraw(bot, draw); }
        else {
        await guard(ctx, Promise.resolve(bot.look(aim.yaw, aim.pitch, true)), 1000);
        await lookSent(bot);
        // The last aim awaited native movement/look. Re-read the crystal's actual arrow path now,
        // with no intervening await before a bow release (or a crossbow's firing activation).
        const currentCrystal = live?.name === 'end_crystal' ? bot.entities?.[live.id] : null;
        // A creature: the flight is run once more from where the eyes are after the look, at the yaw and pitch actually set.
        const creatureNow = aim.flight && live ? bot.entities?.[live.id] : null;
        const lastFlight = creatureNow ? arrowFlight(bot, bot.entity.position.offset(0, EYE - 0.1, 0), aim.yaw, aim.pitch, speed,
          { feet: creatureNow.position, velocity: aim.velocity ?? new Vec3(0, 0, 0), width: Number(creatureNow.width ?? 0.6), height: Number(creatureNow.height ?? 1.8) }, aim.ticks + 4) : null;
        const refusal = live?.name === 'end_crystal' ? currentCrystal ? crystalShotProblem(bot, currentCrystal, speed, aim)
          : stopped(bot, 'target_not_found', '的が見えなくなったので放さなかった')
          : lastFlight?.kind === 'block' ? stopped(bot, 'line_blocked', `放す直前に矢の道が (${lastFlight.x},${lastFlight.y},${lastFlight.z}) の ${lastFlight.name} に塞がれたので放さなかった`, { x: lastFlight.x, y: lastFlight.y, z: lastFlight.z }) : null;
        if (refusal) { cancelled = refusal.text; await cancelDraw(bot, draw); }
        else {
        if (crossbow) { bot.activateItem(); await wait(ctx, 50); }
        if (draw) draw.loose(); else bot.deactivateItem();
        shield?.release(); shield = null;
        noteShootDiagnostic(bot, () => ({ stage: 'released', shot: shot + 1, ...shootDiagnosticState(bot, bot.entities?.[live?.id]),
          speed, aim: { ...aim! } }));
        await wait(ctx, aim.ticks * 50 + 500);
        }
        }
      }
    } finally { draw?.end(actionSignal(bot)?.aborted !== true); shield?.release(); bot.removeListener('entityHurt', onHurt); bot.removeListener('entityGone', onGone); bot.removeListener('entitySpawn', onSpawn); }
    // end1108g7 S7: a draw let down (its line blocked mid-draw, its target gone) ended the hand, and the head took 10 to 20 seconds to
    // send it again. A hand that names a kind goes on at the next one whose arrow flies clear (twice in a row at the most).
    if (cancelled || !aim) {
      results.push(cancelled ?? '的が見えなくなった');
      if (++letdowns > LETDOWNS_IN_A_ROW) break;
      const gone = live && (!bot.entities?.[live.id] || isDying(bot, bot.entities[live.id]));
      if (gone && live) dealt.add(live.id);
      const next = nextClear();
      if (!next) break;
      target = next;
      continue;
    }
    letdowns = 0;
    if (aim.ticks < 0) { results.push(`${live ? `${live.name}` : cellText(args.at!)} は遠すぎて届かない（${aim.far.toFixed(0)}m）`); break; }
    if (hurt) hits++;
    // end1108c S7: an arrow that never left the bow was told as 「外れた」, and the head aimed again three times. It is told as what it was.
    const noArrow = !hurt && !arrowSeen && before === arrowsLeft() && bot.game?.gameMode !== 'creative';
    noArrows = noArrow ? noArrows + 1 : 0;
    const health = live && bot.entities?.[live.id] ? entityHealth(bot, bot.entities[live.id]) : null;
    const where = aim.label && aim.label !== '真ん中' ? `、${aim.label}を狙った` : '';
    const said = noArrow ? '矢が出なかった（弓を引けていない。手が他の物を使っていた見込み）'
      : live ? (live.name === 'end_crystal' ? (hurt ? 'クリスタルを壊した（爆発した）' : '外れた（クリスタルは残っている）') : hurt ? `当たった${health !== null ? `（残り体力 ${health}）` : ''}` : '外れた') : `${cellText(args.at!)} へ射った`;
    results.push(`${shot + 1}発目: ${said}（飛ぶ時間 ${(aim.ticks / 20).toFixed(1)}秒、仰角 ${(aim.pitch * 180 / Math.PI).toFixed(1)}°${where}）`);
    if (!noArrow && live?.name === 'ender_dragon') atFlyingDragon = true;
    if (noArrows >= 2) { results.push('2 回続けて矢が出なかったので止めた'); break; }
    // A creature this arrow hurt that is now dying or gone: the kill, where, and what fell there.
    if (live && hurt && live.name !== 'end_crystal' && live.name !== 'ender_dragon') {
      const now = bot.entities?.[live.id];
      if (!now || isDying(bot, now)) {
        const at = (now ?? live).position.clone();
        dealt.add(live.id); kills++;
        // The drops come with the death; a few ticks more for their stacks to be told to the client.
        for (let waited = 0; waited < 600 && !itemsSince(bot, baseline, at, 6).length; waited += 100) await wait(ctx, 100);
        results.push(killLine(bot, { id: live.id, name: String(live.name ?? 'entity'), at }, baseline));
      }
    }
  }
  } catch (error) {
    if (opened.length) await shutWindows(ctx, opened.splice(0)).catch(() => undefined);
    throw error;
  }
  const fired = results.filter(line => /^\d+発目/u.test(line)).length;
  const tally = `当たり ${hits}/${fired}${kills ? `、倒した ${kills}` : ''}、矢の残り ${arrowsLeft()}`;
  // At the flying dragon the worth of the arrow and the tally come first, so that the 160 characters of act's line cut the later shots' details and not these.
  const text = atFlyingDragon ? `${weaponName}で射った（${FLYING_DRAGON_LINE}）: ${tally}。${results.join('、')}`
    : `${weaponName}で射った: ${results.join('、')}。${tally}${kind === 'blaze' ? spawnerLine(bot) : ''}`;
  return finish({ ok: true, data: { arrowsLeft: arrowsLeft(), kills }, text });
}

/** The windows one shoot hand may open (one, and a second when the target moves round the corner). */
const WINDOWS_PER_HAND = 2;
/** What a window is shut with, in this order (the dug netherrack is carried after the dig, so one is always at hand in the Nether). */
const WINDOW_FILL = ['cobblestone', 'cobbled_deepslate', 'netherrack', 'blackstone', 'stone', 'dirt', 'basalt', 'end_stone'];

/** Digs the window `cell` in the body's own wall, letting in only the kind being shot (the exposure guard keeps every other). */
async function openWindow(ctx: StepContext, cell: Cell, kind: string): Promise<StepOutcome> {
  return dig(ctx, { at: [cell], exposeOk: kind ? [kind] : false });
}

/** Shuts the windows again with a block the body carries; the words say what was done. */
async function shutWindows(ctx: StepContext, cells: Cell[]): Promise<string> {
  const said: string[] = [];
  for (const cell of cells) {
    const block = WINDOW_FILL.find(name => inventoryCount(ctx.bot, name) > 0);
    if (!block) { said.push(`窓 ${cellText(cell)} を開けて撃った。閉じる石が無いので開いたまま`); continue; }
    const put = await place(ctx, { block, at: [cell] }).catch((error: unknown) => ({ ok: false, text: String((error as Error)?.message ?? error) }));
    said.push(put.ok ? `窓 ${cellText(cell)} を開けて撃ち、${block} で閉じた` : `窓 ${cellText(cell)} を開けて撃った。閉じられなかった: ${put.text.slice(0, 80)}`);
  }
  return said.join('。');
}
