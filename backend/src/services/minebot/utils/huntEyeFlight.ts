import { Vec3 } from 'vec3';
import type { Cell } from './localMap.js';

/**
 * A thrown eye of ender, read from the connection's own words (S2, 2026-11-02).
 *
 * The method is the one aibengineering/mine-ai-mcp (MIT, src/actions/locate-stronghold/throw-eye.ts) uses: watch `entitySpawn` for an
 * `eye_of_ender` that appears within three blocks of the thrower, follow it by `entityMoved` and end the watch at `entityGone` (ten seconds
 * at most: the eye lives 80 ticks, four seconds, and the rest is allowance for lag). This is written afresh for this body: a sampling loop on
 * a timer (what `use` did before) cannot tell how the flight ended, and its "the eye broke" was true for every eye whose entity had gone.
 *
 * What the game does (1.21, EyeOfEnder.tick), and so what is read here:
 *  - The eye is given a target: the nearest stronghold's block position. Farther than 12 blocks away, it flies the horizontal line toward the
 *    target for 12 blocks, climbing 8; nearer, it flies to the target itself (and falls toward its height). Every position of the flight lies
 *    on the line from where it appeared to the target, so the direction start -> end is exact whatever the eye does after it arrives (it
 *    hovers and swings about the 12-block point). The packets carry 1/4096 of a block, so over a flight of 8 blocks the direction is good to
 *    a hundredth of a degree: the measure is the line, and the line is the stronghold's.
 *  - At 80 ticks the eye is discarded and one of two things follows in the same tick: four times in five the item falls (an item entity of
 *    `ender_eye` appears where the eye was), one time in five it shatters (a level event 2003 at the eye's block). Both are told by the
 *    connection, so they are read, not guessed from the pack (the count of eyes in the pack falls when an eye is thrown, whatever becomes of it).
 *
 * Nothing here moves the body or throws: the caller activates the item and this watches (`watchEyeFlight` before `activateItem`).
 */

export type Point3 = { x: number; y: number; z: number };

/** An eye of ender appears at the thrower's x and z, at the middle of the thrower: this near is "ours". */
export const EYE_SPAWN_RADIUS = 3;
/** The longest a flight is followed after the eye appeared (the eye lives 80 ticks). */
export const EYE_WATCH_MS = 10_000;
/** How long the end of the eye is watched for a dropped item or a shattering after the eye is gone (both come in the same tick). */
export const EYE_FATE_MS = 1_500;
/** The level event of a shattering eye (LevelEvent 2003, ender eye break). */
export const EYE_BREAK_EVENT = 2003;
/** A flight shorter than this (blocks, horizontally) points nowhere: the stronghold is right below (or beside the thrower within a block). */
export const EYE_MIN_FLAT = 1;
/** An item that falls from the eye lies within this many blocks (horizontally) of where the eye was last seen (it is dropped where it is discarded, and falls). */
const DROP_RADIUS = 4;
/** A level event counts as this eye's when its block is within this many blocks of the eye's last position. */
const BREAK_RADIUS = 6;

export type EyeFate = 'dropped' | 'shattered' | 'unknown';

export interface EyeFlight {
  /** The eye entity's id. */
  id: number;
  /** Where the thrower stood (feet, exact) when the eye was thrown: the base of the line. */
  origin: Point3;
  /** The eye's first position (the thrower's x and z, the thrower's middle). */
  start: Point3;
  /** The eye's last position seen. */
  end: Point3;
  /** Blocks flown horizontally, start to end. */
  flat: number;
  /** end.y - start.y: up is positive. */
  rise: number;
  /** The horizontal direction start -> end as a unit vector (x east, z south), or null when it flew less than EYE_MIN_FLAT. */
  unit: { x: number; z: number } | null;
  /** The compass bearing of `unit` (0 north = -z, 90 east = +x), two decimals, or null with it. */
  bearingDeg: number | null;
  /** Positions seen after the first. */
  samples: number;
  /** Milliseconds from the first position to the eye being gone (or to the end of the watch). */
  ms: number;
  /** The eye was seen to go (entityGone); false when the watch ran out first. */
  gone: boolean;
  /** How it ended, from the connection's words: dropped (an item entity of the eye appeared), shattered (the level event), or unknown (neither was seen). */
  fate: EyeFate;
  /** The item that fell: its entity id and where it lies. */
  drop?: { id: number; at: Point3 };
  /** Flew less than EYE_MIN_FLAT sideways and fell more than a block: the stronghold is right below (`end` is where it is). */
  overhead: boolean;
}

export interface EyeWatcher {
  /** True when an eye of ours appeared (within `spawnWaitMs`), false when none did. */
  spawned: Promise<boolean>;
  /** The record once the eye is gone and its end watched, or null when no eye appeared. */
  flight: Promise<EyeFlight | null>;
  /** Stops watching (and settles `flight` with what was seen so far); safe to call again. */
  cancel(): void;
}

interface BotLike {
  entity?: { position: Vec3 };
  entities?: Record<string, any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  _client?: { on?(event: string, listener: (...args: any[]) => void): unknown; removeListener?(event: string, listener: (...args: any[]) => void): unknown };
}

const round = (value: number, places: number) => { const factor = 10 ** places; return Math.round(value * factor) / factor; };
const point = (position: { x: number; y: number; z: number }): Point3 => ({ x: round(position.x, 3), y: round(position.y, 3), z: round(position.z, 3) });

/** The compass bearing of a horizontal vector: 0 north (-z), 90 east (+x). */
export function bearingOf(dx: number, dz: number): number {
  return (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
}

/** The unit vector, the bearing and the lengths of a flight from `start` to `end`. */
export function flightVector(start: Point3, end: Point3): { flat: number; rise: number; unit: { x: number; z: number } | null; bearingDeg: number | null } {
  const dx = end.x - start.x, dz = end.z - start.z, flat = Math.hypot(dx, dz);
  const rise = end.y - start.y;
  if (flat < EYE_MIN_FLAT) return { flat, rise, unit: null, bearingDeg: null };
  return { flat, rise, unit: { x: round(dx / flat, 5), z: round(dz / flat, 5) }, bearingDeg: round(bearingOf(dx, dz), 2) };
}

/** The name of the item a dropped-item entity holds, or null while the server has not said (the stack arrives in the entity's metadata, after its spawn). */
export function droppedItemName(entity: any): string | null {
  try {
    const stack = entity?.getDroppedItem?.();
    if (stack?.name) return String(stack.name);
  } catch { /* metadata not here yet */ }
  return null;
}
const isItemEntity = (entity: any) => entity?.name === 'item' || entity?.displayName === 'Item';

/**
 * Starts watching for the eye. Call it just before the item is activated; it listens at once. `origin` is where the thrower stands (the base of
 * the line); it is taken from the body when it is not given.
 */
export function watchEyeFlight(bot: BotLike, options: { origin?: Vec3; spawnWaitMs?: number; watchMs?: number; fateMs?: number } = {}): EyeWatcher {
  const origin = (options.origin ?? bot.entity?.position)?.clone?.() ?? new Vec3(0, 0, 0);
  const spawnWaitMs = options.spawnWaitMs ?? 2_000, watchMs = options.watchMs ?? EYE_WATCH_MS, fateMs = options.fateMs ?? EYE_FATE_MS;
  // Item entities that lay about before the throw are not the eye's drop.
  const before = new Set<number>();
  for (const entity of Object.values(bot.entities ?? {})) if (isItemEntity(entity)) before.add((entity as any).id);

  let phase: 'waiting' | 'flying' | 'ending' | 'done' = 'waiting';
  let eyeId = -1, startedAt = 0, goneAt = 0;
  let start: Point3 | null = null, last: Point3 | null = null, samples = 0;
  let fate: EyeFate = 'unknown';
  let drop: EyeFlight['drop'];
  let spawnedResolve: (value: boolean) => void = () => undefined;
  let flightResolve: (value: EyeFlight | null) => void = () => undefined;
  const spawned = new Promise<boolean>(resolve => { spawnedResolve = resolve; });
  const flight = new Promise<EyeFlight | null>(resolve => { flightResolve = resolve; });
  let spawnTimer: ReturnType<typeof setTimeout> | undefined, watchTimer: ReturnType<typeof setTimeout> | undefined, fateTimer: ReturnType<typeof setTimeout> | undefined;

  const record = (gone: boolean): EyeFlight | null => {
    if (!start || !last) return null;
    const vector = flightVector(start, last);
    return {
      id: eyeId, origin: point(origin), start: point(start), end: point(last), flat: round(vector.flat, 3), rise: round(vector.rise, 3), unit: vector.unit, bearingDeg: vector.bearingDeg,
      samples, ms: Math.max(0, (goneAt || Date.now()) - startedAt), gone, fate, ...(drop ? { drop } : {}),
      overhead: vector.flat < EYE_MIN_FLAT && vector.rise < -1,
    };
  };
  const detach = () => {
    for (const timer of [spawnTimer, watchTimer, fateTimer]) if (timer) clearTimeout(timer);
    const remove = (bot.removeListener ?? bot.off)?.bind(bot);
    remove?.('entitySpawn', onSpawn); remove?.('entityMoved', onMoved); remove?.('entityGone', onGone); remove?.('entityUpdate', onUpdate); remove?.('end', onEnd);
    try { bot._client?.removeListener?.('world_event', onWorldEvent); } catch { /* not attached */ }
  };
  const settle = (gone: boolean) => {
    if (phase === 'done') return;
    const wasWaiting = phase === 'waiting';
    phase = 'done';
    detach();
    if (wasWaiting) spawnedResolve(false);
    flightResolve(wasWaiting ? null : record(gone));
  };
  /** An item entity of an eye that appeared near where the eye ended, and was not lying there before the throw. */
  const findDrop = (): EyeFlight['drop'] => {
    if (!last) return undefined;
    for (const entity of Object.values(bot.entities ?? {}) as any[]) {
      if (!isItemEntity(entity) || before.has(entity.id) || !entity.position) continue;
      if (Math.hypot(entity.position.x - last.x, entity.position.z - last.z) > DROP_RADIUS) continue;
      if (droppedItemName(entity) === 'ender_eye') return { id: entity.id, at: point(entity.position) };
    }
    return undefined;
  };
  const decide = () => {
    if (phase !== 'ending') return;
    const found = findDrop();
    if (found) { fate = 'dropped'; drop = found; settle(true); }
  };

  function onSpawn(entity: any) {
    if (phase === 'ending') { decide(); return; }
    if (phase !== 'waiting' || entity?.name !== 'eye_of_ender' || !entity.position) return;
    if (entity.position.distanceTo(origin) > EYE_SPAWN_RADIUS) return;
    phase = 'flying'; eyeId = entity.id; startedAt = Date.now();
    start = point(entity.position); last = start;
    if (spawnTimer) clearTimeout(spawnTimer);
    spawnedResolve(true);
    watchTimer = setTimeout(() => settle(false), watchMs);
  }
  function onMoved(entity: any) {
    if (phase !== 'flying' || entity?.id !== eyeId || !entity.position) return;
    last = point(entity.position); samples++;
  }
  function onGone(entity: any) {
    if (phase !== 'flying' || entity?.id !== eyeId) return;
    // The server discards the eye and, in the same tick, either spawns its item or sends the level event: they are watched for a moment.
    if (entity.position) last = point(entity.position);
    goneAt = Date.now(); phase = 'ending';
    if (watchTimer) clearTimeout(watchTimer);
    fateTimer = setTimeout(() => { decide(); settle(true); }, fateMs);
    decide();
  }
  function onUpdate() { if (phase === 'ending') decide(); }
  function onWorldEvent(packet: any) {
    if (phase !== 'ending' || !last || Number(packet?.effectId) !== EYE_BREAK_EVENT) return;
    const at = packet.location;
    if (at && Math.hypot(Number(at.x) - last.x, Number(at.y) - last.y, Number(at.z) - last.z) > BREAK_RADIUS) return;
    fate = 'shattered'; settle(true);
  }
  function onEnd() { settle(false); }

  bot.on('entitySpawn', onSpawn); bot.on('entityMoved', onMoved); bot.on('entityGone', onGone); bot.on('entityUpdate', onUpdate); bot.on('end', onEnd);
  try { bot._client?.on?.('world_event', onWorldEvent); } catch { /* a body with no raw connection reads no level events: the fate is then dropped or unknown */ }
  spawnTimer = setTimeout(() => { if (phase === 'waiting') settle(false); }, spawnWaitMs);
  return { spawned, flight, cancel: () => settle(false) };
}

/** The compass word of a bearing (8 points). */
export function compassOf(bearingDeg: number): string {
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}

/**
 * What the act's result carries of a thrown eye (`ActResult.eye`). The first five fields are the contract's (the head reads them); the rest are
 * the exact line: where the body stood, the unit vector and the two ends of the flight, how the eye ended, and whether it reached its target.
 */
export interface EyeReport {
  from: Cell; bearingDeg: number; flew: number; to: Cell; broke: boolean;
  /** The body's exact position (feet) when the eye was thrown: the base of the line. */
  origin: Point3;
  /** The horizontal direction of the flight as a unit vector (x east, z south). */
  unit: { x: number; z: number };
  start: Point3; end: Point3;
  /** Up is positive. */
  rise: number;
  /** dropped (an item of the eye was seen to fall: `drop` says where), shattered (the level event was seen), unknown (neither was seen). */
  fate: EyeFate;
  drop?: { id: number; at: Point3 };
  /** The flight was shorter than the 12 blocks an eye flies toward a stronghold farther than that: it reached the stronghold's own x and z, and `end` is there. */
  arrived: boolean;
  samples: number; ms: number;
}

/** An eye flies 12 blocks toward a stronghold farther than that, and swings about that point: a flight clearly shorter reached the stronghold itself. */
export const EYE_FAR_FLIGHT = 12;
export const EYE_ARRIVED_BELOW = 10.5;

/** The act's report of a flight that has a direction, or null (a flight right above the stronghold has none). */
export function eyeReportOf(flight: EyeFlight, from: Cell): EyeReport | null {
  if (!flight.unit || flight.bearingDeg === null) return null;
  const cell = (p: Point3): Cell => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  return {
    from, bearingDeg: flight.bearingDeg, flew: round(flight.flat, 1), to: cell(flight.end), broke: flight.fate === 'shattered',
    origin: flight.origin, unit: flight.unit, start: flight.start, end: flight.end, rise: round(flight.rise, 2), fate: flight.fate,
    ...(flight.drop ? { drop: flight.drop } : {}), arrived: flight.flat < EYE_ARRIVED_BELOW, samples: flight.samples, ms: flight.ms,
  };
}
