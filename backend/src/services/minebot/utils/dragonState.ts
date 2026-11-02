import { Vec3 } from 'vec3';
import { entityHealth } from './mapMarks.js';
import { bodyReader, type BlockReader } from './localMap.js';
import { toldVelocity } from './toldVelocity.js';
import { blastAt, CRYSTAL_REACH } from './crystalBlast.js';
import { boxCentre, boxDistance, DRAGON_MAX_HEALTH, isPerched, partBox, phaseName, type P3 } from './dragonParts.js';

/**
 * What the body reads of the End fight, for the observation (`state.end`) and for the parts that act on it (the dragon strike, the dragon
 * reflex, the crystal shot). Reading only: nothing here moves the body. Where a number is a guess (the parts of a dragon in flight), it
 * says so in its name.
 */

type Bot = any;
export const isEnd = (bot: Bot): boolean => String(bot?.game?.dimension ?? '').replace(/^minecraft:/u, '') === 'the_end';

/** Where a field sits in an entity's metadata, from the game's data for this version (1.21.4 / 1.21.11: phase 16, beam_target 8, radius 8, particle 10). */
const FALLBACK: Record<string, number> = { 'ender_dragon.phase': 16, 'end_crystal.beam_target': 8, 'area_effect_cloud.radius': 8, 'area_effect_cloud.particle': 10 };
export function metaIndex(bot: Bot, entityName: string, key: string): number {
  const keys = bot?.registry?.entitiesByName?.[entityName]?.metadataKeys;
  const at = Array.isArray(keys) ? keys.indexOf(key) : -1;
  return at >= 0 ? at : FALLBACK[`${entityName}.${key}`] ?? -1;
}

/** The dragon in sight of the client (the one nearest the body when two are loaded), or null. */
export function endDragonOf(bot: Bot): any | null {
  const at = bot?.entity?.position;
  let best: any = null, bestDistance = Infinity;
  for (const entity of Object.values(bot?.entities ?? {}) as any[]) {
    if (entity?.name !== 'ender_dragon' || !entity.position) continue;
    const distance = at ? entity.position.distanceTo(at) : 0;
    if (distance < bestDistance) { best = entity; bestDistance = distance; }
  }
  return best;
}

/** The dragon's phase (0..10) from its metadata, or null when the client has not been told. */
export function dragonPhaseOf(bot: Bot, dragon: any): number | null {
  const at = metaIndex(bot, 'ender_dragon', 'phase');
  const value = at >= 0 ? dragon?.metadata?.[at] : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
}

/** How long (seconds) the dragon has been in this phase, as this body has watched: 0 at the first look and at a change. Call it each time the phase is read. */
const clocks = new WeakMap<object, { id: number; phase: number | null; since: number }>();
export function phaseSeconds(bot: Bot, dragon: any, phase: number | null, now = Date.now()): number {
  const held = clocks.get(bot);
  if (!held || held.id !== dragon.id || held.phase !== phase) { clocks.set(bot, { id: dragon.id, phase, since: now }); return 0; }
  return (now - held.since) / 1000;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const at3 = (p: P3): P3 => ({ x: round1(p.x), y: round1(p.y), z: round1(p.z) });
const solid = (block: ReturnType<BlockReader>) => !!block && block.solid === true;

/**
 * The top of the exit portal's bedrock pillar at x 0, z 0 (the first cell above it): where the dragon perches. Null while the column is not
 * loaded. The pillar does not move, so the answer is kept (and read again if the cell no longer holds bedrock).
 */
const fountains = new WeakMap<object, P3>();
export function fountainOf(bot: Bot): P3 | null {
  const read = bodyReader(bot);
  const kept = fountains.get(bot);
  if (kept && read(0, kept.y - 1, 0)?.name === 'bedrock') return kept;
  for (let y = 110; y >= 30; y--) {
    if (read(0, y, 0)?.name === 'bedrock') {
      // The pillar's top: the first bedrock with air above it (the floor of the island is bedrock-free at x 0, z 0 in the End).
      const found = { x: 0.5, y: y + 1, z: 0.5 };
      fountains.set(bot, found);
      return found;
    }
  }
  return null;
}

/** A crystal's cage: iron bars round it (the two guarded spikes: bars two cells out on every side and a roof over it). null when the cells are not loaded. */
export function crystalCaged(bot: Bot, crystal: { position: P3 }): boolean | null {
  const read = bodyReader(bot);
  const cx = Math.floor(crystal.position.x), cz = Math.floor(crystal.position.z), cy = Math.floor(crystal.position.y);
  let known = 0, bars = 0;
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
    const block = read(cx + dx, cy + 1, cz + dz);
    if (block) { known++; if (block.name === 'iron_bars') bars++; }
  }
  const roof = read(cx, cy + 2, cz);
  if (roof) { known++; if (roof.name === 'iron_bars') bars++; }
  if (known === 0) return null;
  return bars >= 3;
}

export interface CrystalView {
  id: number; x: number; y: number; z: number; caged: boolean | null; dist: number; /** Its beam is on the dragon: it is healing it. */ healing?: true;
  /** Within its blast's reach: the health the body would lose if it blew where the body stands now (an estimate: utils/crystalBlast). */ blast?: number;
}
/** The crystals loaded, nearest first. */
export function crystalsOf(bot: Bot): CrystalView[] {
  const at = bot?.entity?.position;
  const beam = metaIndex(bot, 'end_crystal', 'beam_target');
  const out: CrystalView[] = [];
  for (const entity of Object.values(bot?.entities ?? {}) as any[]) {
    if (entity?.name !== 'end_crystal' || !entity.position) continue;
    const target = beam >= 0 ? entity.metadata?.[beam] : undefined;
    const dist = at ? round1(entity.position.distanceTo(at)) : 0;
    let blast: number | undefined;
    if (at && dist < CRYSTAL_REACH) { try { blast = blastAt(bot, entity.position).expected; } catch { blast = undefined; } }
    out.push({ id: entity.id, ...at3(entity.position), caged: crystalCaged(bot, entity), dist, ...(target ? { healing: true as const } : {}), ...(blast !== undefined ? { blast } : {}) });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

const isBreath = (bot: Bot, value: unknown): boolean => {
  const v = value as any;
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return /(^|:)dragon_breath$/u.test(v);
  if (typeof v === 'number') return v === bot?.registry?.particlesByName?.dragon_breath?.id;
  return [v.type, v.name, v.particle, v.type?.name].some(label => typeof label === 'string' && /(^|:)dragon_breath$/u.test(label));
};
export interface CloudView { id: number; position: P3; radius: number | null }
/** The dragon's breath that lies in the world now (area effect clouds of the dragon_breath particle). */
export function breathCloudsOf(bot: Bot): CloudView[] {
  const particle = metaIndex(bot, 'area_effect_cloud', 'particle'), radius = metaIndex(bot, 'area_effect_cloud', 'radius');
  const out: CloudView[] = [];
  for (const entity of Object.values(bot?.entities ?? {}) as any[]) {
    if (entity?.name !== 'area_effect_cloud' || !entity.position || !isBreath(bot, particle >= 0 ? entity.metadata?.[particle] : undefined)) continue;
    const r = radius >= 0 ? Number(entity.metadata?.[radius]) : Number.NaN;
    out.push({ id: entity.id, position: entity.position, radius: Number.isFinite(r) && r > 0 ? r : null });
  }
  return out;
}

/** A dragon's fireball: where it is and how it moves now (blocks a tick, the speed the server told: utils/toldVelocity). */
export interface FireballView { id: number; position: P3; velocity: P3 }
export function fireballsOf(bot: Bot): FireballView[] {
  const out: FireballView[] = [];
  for (const entity of Object.values(bot?.entities ?? {}) as any[]) {
    if (entity?.name !== 'dragon_fireball' || !entity.position) continue;
    const told = toldVelocity(bot, entity.id) ?? entity.velocity;
    if (!told || !(Math.hypot(told.x, told.y, told.z) > 1e-6)) continue;
    out.push({ id: entity.id, position: entity.position, velocity: told });
  }
  return out;
}

/** Where a fireball goes in the next ticks: it speeds (s + 0.1) * 0.95 a tick along its line, and stops at the first solid cell. */
export function fireballPath(read: BlockReader, ball: FireballView, ticks = 40): { points: P3[]; impact: P3 | null } {
  const speed0 = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z);
  const dir = { x: ball.velocity.x / speed0, y: ball.velocity.y / speed0, z: ball.velocity.z / speed0 };
  const points: P3[] = [];
  let p = { x: ball.position.x, y: ball.position.y, z: ball.position.z }, speed = speed0;
  for (let tick = 0; tick < ticks; tick++) {
    for (let sub = 1; sub <= 3; sub++) {
      const q = { x: p.x + dir.x * speed * sub / 3, y: p.y + dir.y * speed * sub / 3, z: p.z + dir.z * speed * sub / 3 };
      if (solid(read(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)))) return { points, impact: q };
    }
    p = { x: p.x + dir.x * speed, y: p.y + dir.y * speed, z: p.z + dir.z * speed };
    points.push(p);
    speed = (speed + 0.1) * 0.95;
  }
  return { points, impact: null };
}

export interface DragonView {
  id: number; health: number | null; phase: number | null; phaseName: string | null; /** Seconds in this phase, as watched. */ phaseFor: number;
  perched: boolean; at: P3; yaw: number; /** The head's box centre when perched (an estimate in flight is not given). */ head: P3 | null;
  /** The eye's distance to the head's box, and whether a blow is in reach now (perched, within 3 m). */ headReach: number | null; strike: boolean;
}
export const STRIKE_REACH = 3.0;
export function dragonView(bot: Bot, dragon: any, now = Date.now()): DragonView {
  const phase = dragonPhaseOf(bot, dragon);
  const perched = isPerched(phase);
  const eye = bot?.entity?.position ? new Vec3(bot.entity.position.x, bot.entity.position.y + 1.62, bot.entity.position.z) : null;
  const headBox = perched ? partBox({ position: dragon.position, yaw: dragon.yaw }, 'head') : null;
  const headReach = headBox && eye ? round1(boxDistance(eye, headBox)) : null;
  return { id: dragon.id, health: entityHealth(bot, dragon), phase, phaseName: phaseName(phase), phaseFor: round1(phaseSeconds(bot, dragon, phase, now)), perched,
    at: at3(dragon.position), yaw: round1(Number(dragon.yaw ?? 0)), head: headBox ? at3(boxCentre(headBox)) : null, headReach, strike: headReach !== null && headReach <= STRIKE_REACH };
}

export interface EndObservation {
  dragon: DragonView | null;
  /** The top of the exit portal's pillar (where the dragon perches), or null while it is not loaded. */
  fountain: P3 | null;
  crystals: { left: number; caged: number; list: CrystalView[] };
  /** The dragon's breath clouds lying in the world, and the fireballs flying (the reflex's own judgement is `dragonHazards`). */
  clouds: Array<{ x: number; y: number; z: number; r: number | null }>;
  fireballs: number;
}
/** `state.end` for the observation: only in the End, null elsewhere. */
export function endObservation(bot: Bot, now = Date.now()): EndObservation | null {
  if (!isEnd(bot)) return null;
  const dragon = endDragonOf(bot);
  const crystals = crystalsOf(bot);
  return {
    dragon: dragon ? dragonView(bot, dragon, now) : null,
    fountain: fountainOf(bot),
    crystals: { left: crystals.length, caged: crystals.filter(crystal => crystal.caged === true).length, list: crystals.slice(0, 10) },
    clouds: breathCloudsOf(bot).slice(0, 4).map(cloud => ({ ...at3(cloud.position), r: cloud.radius === null ? null : round1(cloud.radius) })),
    fireballs: fireballsOf(bot).length,
  };
}
export { DRAGON_MAX_HEALTH };
