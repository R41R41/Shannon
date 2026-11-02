import { Vec3 } from 'vec3';
import { bodyReader } from './localMap.js';
import { BREATH_RADIUS_MIN, boxCentre, boxesOverlap, bodyBoxAt, flameCloudCentre, inflate, isPerched, partBox, shift, type Box, type P3 } from './dragonParts.js';
import { breathCloudsOf, dragonPhaseOf, endDragonOf, fireballPath, fireballsOf, isEnd, phaseSeconds } from './dragonState.js';

/**
 * What in the End can hurt the body where it stands, and the zones it has: the dragon's breath lying about (an area effect cloud, treated as
 * at least 7 blocks wide in radius: it grows from 3 to 7 and the client's number is a tick old), the flame it is about to breathe on the perch
 * (phase 5 at once, phase 7 a second and a quarter in: the cloud comes 2.5 blocks past the head ten ticks into phase 5), a fireball's line
 * for the next 40 ticks (within 7 blocks of it), and the perched dragon's own reach: the head and the neck hurt what is within a block of them,
 * the wings knock back and hurt what is within four blocks (and two up and down). The floor reflex (floorReflexes `dragonTick`) steps out of
 * these; the planner is told the same zones in the observation. The zones are the dragon's server rules, read from what the client sees; the
 * parts of a dragon in flight are not aimed at, so the boxes are only drawn for the perched one.
 */
export type HazardKind = 'breath' | 'flame' | 'fireball' | 'head' | 'neck' | 'wing';
export interface Hazard { kind: HazardKind; centre: P3; /** The place the same push would come from on the other side of the body (a sidestep that may be taken either way: a fireball that lands on the body). */ alternative?: P3; /** The radius of a round zone (0 for a box). */ radius: number; box?: Box; why: string; /** A cloud a fireball gone from sight has just laid, not yet among the client's entities (it is laid in the tick the ball goes, its harm comes 20 ticks after): a rise now clears it, a rise before the ball came does not. */ pending?: true; /** For a fireball: where it comes down, where its cloud will lie (a flight away from the body that ends in it would run into that cloud). */ impact?: P3 }

export { BREATH_RADIUS_MIN };
/** A fireball's line is dangerous within this far (the cloud it lays and the blast round it). */
export const FIREBALL_REACH = 7;
const FIREBALL_TICKS = 40;
/**
 * The cloud a fireball lays is put on the first living thing within 4 blocks of where it lands (DragonFireball.onHit): a body this near the landing is the one it
 * falls on, and it has to step across the line; one farther off runs from where it lands.
 */
const FIREBALL_CAPTURE = 5;
/** A fireball gone from sight has laid, or is laying, its cloud at its landing: the cloud comes into the client's entities a few ticks later (lab: 0.2 s). */
const LANDING_HOLD_MS = 1500;
/** The cloud is a slab half a block high on the ground; the body is clear of it when its feet are over it or its head under it, with a margin. */
const CLOUD_SLAB = 0.5;
const SLAB_MARGIN = 0.3;
/** The head and the neck hurt what is within a block of their box (the dragon hurts what touches the box grown by one); the wings knock back within (4, 2, 4) moved two down. */
const CONTACT = 1.0;
const BOX_MARGIN = 0.1;
/** Phase 7 (roaring) breathes after 2.5 s (40 ticks, and ten into phase 5): the flame is expected from this far into it. */
const ROAR_LEAD_S = 1.25;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The first solid top below `from` (the cloud lies on the ground there), or `from` itself when nothing is loaded. */
function groundBelow(bot: any, from: P3): number {
  const read = bodyReader(bot);
  for (let y = Math.floor(from.y); y >= from.y - 40; y--) if (read(Math.floor(from.x), y, Math.floor(from.z))?.solid) return y + 1;
  return from.y;
}

/** Whether a cloud of radius `r` at `c` reaches a body at `feet` (the slab and the disc), with `clearance` more round it. */
export function cloudReaches(c: P3, r: number, feet: P3, clearance = 0): boolean {
  if (!(feet.y < c.y + CLOUD_SLAB + SLAB_MARGIN && feet.y + 1.8 > c.y - SLAB_MARGIN)) return false;
  return Math.hypot(feet.x - c.x, feet.z - c.z) <= Math.max(r, BREATH_RADIUS_MIN) + clearance;
}

/** The distance from a point to a polyline (the nearest point on it too). */
function nearestOnPath(points: P3[], p: P3): { distance: number; at: P3 } | null {
  let best: { distance: number; at: P3 } | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, len2 = abx * abx + aby * aby + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2)) : 0;
    const at = { x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t };
    const distance = Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z);
    if (!best || distance < best.distance) best = { distance, at };
  }
  return best;
}

/**
 * The point a flee is pushed from for a fireball. Where the ball lands well off the body, that is the landing (lab 2026-11-02: a body that ran from "the nearest point
 * of the line", which lay over it, went toward the landing and had the cloud put on it). Where it lands on the body, a place across the line, 7 blocks off on the other
 * side, so that the push is a sidestep and not a run along the line toward the ball. A ball that lands nowhere in the 40 ticks is run from at its nearest point.
 * The side of a sidestep is a coin: where the body stands on a bridge one wide, only one of the two sides leads along the bridge, and the other is a push into the void
 * (lab r18, 2026-11-03: a body at the front end of a bridge was told there was no safe way for half the balls, was hit by three clouds, fell off, and the water bucket saved it).
 * So the other side is kept as `alternative`, and the flee takes it when the first side leaves no way.
 */
function fireballPush(line: P3[], impact: P3 | null, nearest: P3, feet: P3): { centre: P3; alternative?: P3 } {
  if (!impact) return { centre: nearest };
  if (Math.hypot(impact.x - feet.x, impact.z - feet.z) > FIREBALL_CAPTURE) return { centre: impact };
  const first = line[0], last = line[line.length - 1];
  const dx = last.x - first.x, dz = last.z - first.z, length = Math.hypot(dx, dz);
  if (length < 0.5) return { centre: impact }; // falling straight down: from where it lands
  const nx = -dz / length, nz = dx / length;
  const side = (feet.x - nearest.x) * nx + (feet.z - nearest.z) * nz >= 0 ? 1 : -1;
  return {
    centre: { x: feet.x - side * nx * FIREBALL_REACH, y: feet.y, z: feet.z - side * nz * FIREBALL_REACH },
    alternative: { x: feet.x + side * nx * FIREBALL_REACH, y: feet.y, z: feet.z + side * nz * FIREBALL_REACH },
  };
}

/** Where each fireball in sight was going to land, as of the last look, and the landings of those that have gone from sight since (kept for LANDING_HOLD_MS). */
const flights = new WeakMap<object, Map<number, { impact: P3 | null; at: number }>>();
const landings = new WeakMap<object, Array<{ impact: P3; at: number }>>();
function landedFireballs(bot: object, flying: Array<{ id: number; impact: P3 | null }>, now: number): Array<{ impact: P3; at: number }> {
  const before = flights.get(bot) ?? new Map<number, { impact: P3 | null; at: number }>();
  const down = (landings.get(bot) ?? []).filter(entry => now - entry.at <= LANDING_HOLD_MS);
  const present = new Set(flying.map(ball => ball.id));
  for (const [id, was] of before) if (!present.has(id) && was.impact && now - was.at <= 1000) down.push({ impact: was.impact, at: now });
  flights.set(bot, new Map(flying.map(ball => [ball.id, { impact: ball.impact, at: now }])));
  landings.set(bot, down);
  return down;
}

/**
 * The hazards that reach the body now. `clearance` widens every zone (the reflex starts at 0 and runs on until the body is `clearance` clear of
 * them, so that it does not stop on the edge and start again at the next tick).
 */
export function dragonHazards(bot: any, options: { clearance?: number; now?: number } = {}): Hazard[] {
  if (!isEnd(bot) || !bot.entity?.position) return [];
  const clearance = options.clearance ?? 0, now = options.now ?? Date.now();
  const feet = bot.entity.position as P3;
  const out: Hazard[] = [];
  // 1. the breath lying about
  const clouds = breathCloudsOf(bot);
  for (const cloud of clouds) {
    if (cloudReaches(cloud.position, cloud.radius ?? 0, feet, clearance)) {
      out.push({ kind: 'breath', centre: cloud.position, radius: Math.max(cloud.radius ?? 0, BREATH_RADIUS_MIN), why: `竜の息の雲 (${cloud.position.x.toFixed(0)},${cloud.position.y.toFixed(0)},${cloud.position.z.toFixed(0)}) 半径${round1(Math.max(cloud.radius ?? 0, BREATH_RADIUS_MIN))}` });
    }
  }
  // 2. the dragon on its perch: the flame to come, and its own reach
  const dragon = endDragonOf(bot);
  if (dragon) {
    const phase = dragonPhaseOf(bot, dragon);
    if (isPerched(phase)) {
      const placed = { position: dragon.position as P3, yaw: Number(dragon.yaw ?? 0) };
      const seconds = phaseSeconds(bot, dragon, phase, now);
      if (phase === 5 || (phase === 7 && seconds >= ROAR_LEAD_S)) {
        const spot = flameCloudCentre(placed);
        const centre = { x: spot.x, y: groundBelow(bot, spot), z: spot.z };
        // Where the real cloud already lies, it is the cloud above that counts.
        const lying = clouds.some(cloud => Math.hypot(cloud.position.x - centre.x, cloud.position.z - centre.z) <= 3);
        if (!lying && cloudReaches(centre, BREATH_RADIUS_MIN, feet, clearance)) {
          out.push({ kind: 'flame', centre, radius: BREATH_RADIUS_MIN, why: `竜が息を吐く（phase ${phase}）頭の2.5先 (${centre.x.toFixed(0)},${centre.y.toFixed(0)},${centre.z.toFixed(0)}) 半径${BREATH_RADIUS_MIN}` });
        }
      }
      const me = bodyBoxAt(feet);
      const grown = CONTACT + BOX_MARGIN + clearance;
      for (const part of ['head', 'neck'] as const) {
        const zone = inflate(partBox(placed, part), grown);
        if (boxesOverlap(zone, me)) out.push({ kind: part, centre: boxCentre(partBox(placed, part)), radius: 0, box: zone, why: `竜の${part === 'head' ? '頭' : '首'}の1マス内` });
      }
      for (const part of ['wing1', 'wing2'] as const) {
        const zone = inflate(shift(inflate(partBox(placed, part), 4, 2, 4), 0, -2, 0), BOX_MARGIN + clearance);
        if (boxesOverlap(zone, me)) out.push({ kind: 'wing', centre: boxCentre(partBox(placed, part)), radius: 0, box: zone, why: '竜の翼の4マス内（押される）' });
      }
    }
  }
  // 3. a fireball's line, 40 ticks ahead; and the breath that a fireball gone from sight is laying where it came down
  const read = bodyReader(bot);
  const chest = { x: feet.x, y: feet.y + 0.9, z: feet.z };
  const flying: Array<{ id: number; impact: P3 | null }> = [];
  for (const ball of fireballsOf(bot)) {
    const path = fireballPath(read, ball, FIREBALL_TICKS);
    flying.push({ id: ball.id, impact: path.impact });
    const line = [{ x: ball.position.x, y: ball.position.y, z: ball.position.z }, ...path.points, ...(path.impact ? [path.impact] : [])];
    const near = nearestOnPath(line, chest);
    if (near && near.distance <= FIREBALL_REACH + clearance) {
      const push = fireballPush(line, path.impact, near.at, feet);
      out.push({ kind: 'fireball', centre: push.centre, ...(push.alternative ? { alternative: push.alternative } : {}), ...(path.impact ? { impact: path.impact } : {}), radius: FIREBALL_REACH, why: `竜の火の玉 #${ball.id} の線から${near.distance.toFixed(1)}m（${path.impact ? `着弾 (${path.impact.x.toFixed(0)},${path.impact.y.toFixed(0)},${path.impact.z.toFixed(0)})` : '40tick先まで当たらず'}）` });
    }
  }
  for (const landing of landedFireballs(bot, flying, now)) {
    // Once the cloud itself is in sight it is the cloud above that counts.
    const lying = clouds.some(cloud => Math.hypot(cloud.position.x - landing.impact.x, cloud.position.z - landing.impact.z) <= 4);
    if (!lying && cloudReaches(landing.impact, BREATH_RADIUS_MIN, feet, clearance)) {
      out.push({ kind: 'breath', centre: landing.impact, radius: BREATH_RADIUS_MIN, pending: true, why: `竜の火の玉が (${landing.impact.x.toFixed(0)},${landing.impact.y.toFixed(0)},${landing.impact.z.toFixed(0)}) に落ちた: 息の雲が出る` });
    }
  }
  return out;
}

/** The places the hazards push the body from, for the flee's heading; `mirrored`: a sidestep taken on the other side (`Hazard.alternative`) wherever there is one. */
export const hazardCentres = (hazards: Hazard[], mirrored = false): Vec3[] => hazards.map(hazard => { const at = mirrored ? hazard.alternative ?? hazard.centre : hazard.centre; return new Vec3(at.x, at.y, at.z); });

/**
 * The dragon's breath lying in the world as a route search wants it (the End only): where each cloud is and how far it reaches (7 at least: it grows from 3, and the
 * client's number is a tick old). A `go` that is drawn again after the floor reflex has lifted the body over a cloud must not walk it back down into the cloud (lab 2026-11-02, w10:
 * the second `go` stepped into the cloud, was cut by the reflex a second time, and the body lost 6).
 */
export function lyingCloudZones(bot: any): Array<{ centre: P3; radius: number }> {
  if (!isEnd(bot)) return [];
  try {
    return breathCloudsOf(bot).map(cloud => ({ centre: { x: cloud.position.x, y: cloud.position.y, z: cloud.position.z }, radius: Math.max(cloud.radius ?? 0, BREATH_RADIUS_MIN) }));
  } catch { return []; }
}

/** Whether a body with its feet in the cell (x, y, z) would stand in one of these clouds (the slab and the disc, a half block more round it): the cloud in words, or null. */
export function cloudZoneAtCell(zones: ReadonlyArray<{ centre: P3; radius: number }>, x: number, y: number, z: number, clearance = 0.5): string | null {
  const feet = { x: x + 0.5, y, z: z + 0.5 };
  for (const zone of zones) {
    if (cloudReaches(zone.centre, zone.radius, feet, clearance)) return `竜の息の雲 (${zone.centre.x.toFixed(0)},${zone.centre.y.toFixed(0)},${zone.centre.z.toFixed(0)}) 半径${round1(zone.radius)}`;
  }
  return null;
}
