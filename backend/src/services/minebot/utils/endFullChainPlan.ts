import type { EndObservation } from './dragonState.js';
import type { P3 } from './dragonParts.js';
import type { ActHand } from '../instantSkills/act.js';

// The lab's stand-in HEAD policy. Inputs are observation fields; no bot, terrain reader or I/O.
export type ChainView = EndObservation | null;
export type ChainCrystal = EndObservation['crystals']['list'][number];
export const CHAIN_LIMIT_MS = 40 * 60_000;
export const CRYSTAL_LIMIT_MS = 15 * 60_000;
export const CRYSTAL_WAIT_MS = 20_000;
export const CAGE_TRAVEL_WAIT_MS = 30_000;
/** Lab HEAD: do not send a reflex-cut island walk back out at ten health or less. */
export function chainWalkRetry(result: { lines: string[]; parsed?: any }, retries: number, health: number): boolean {
  const cut = result.parsed?.outcome?.cutBy ?? result.parsed?.stoppedBy;
  return retries < 2 && Number.isFinite(health) && health > 10 &&
    (['reflex', 'interrupted_by_reflex'].includes(cut) || result.lines.some(s => /反射:|interrupted_by_reflex/u.test(s)));
}
export const chainCell = (p: P3): P3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
export const chainDistance = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const chainSitting = (phase: number | null | undefined) => phase === 5 || phase === 6 || phase === 7;
export const chainWait = (view: ChainView): P3 | null => view?.dragon?.approach?.wait?.[0] ?? null;
export const chainBasin = (view: ChainView): P3 | null => view?.dragon?.phase === 6 ? view.dragon.approach?.basin?.[0] ?? null : null;
export const chainClear = (view: ChainView): boolean => !!view && view.crystals.remaining === 0 && view.crystals.list.length === 0 && view.crystals.unseen.length === 0;
export const chainPause = (view: ChainView, paused: boolean): boolean => view?.dragon?.phase === 6 ||
  (paused && (view?.dragon?.phase == null || chainSitting(view.dragon.phase)));
/** Stand-in HEAD judgement, not a reflex or a route planner. Only observation fields inform the timing.
 * Holding-pattern flight, >=48 m away and outside the forward cone at BOTH ends is an opportunity, not a safety guarantee. */
export function chainTravel(view: ChainView, from: P3, to: P3) {
  const timing = chainCompareTravel(view, from, to);
  const reason = timing.reason === 'dragon_unknown' ? timing.reason :
    view?.dragonFireballs !== 0 ? 'fireball' : !chainCloudClear(view, from, to) ? 'breath' :
    view?.dragon?.phase !== 0 ? 'not_holding_pattern' : timing.reason;
  return { ...timing, ok: reason === 'flight_away', reason };
}
/** Comparison HEAD: distance/yaw opportunity, without a phase or hazard-free-flight prerequisite.
 * This only chooses when to ask go; normal hand refusals and resident reflexes still take priority. */
export function chainCompareTravel(view: ChainView, from: P3, to: P3) {
  const d = view?.dragon;
  const facing = d && Number.isFinite(d.yaw) && d.position ? [from, to].map(p => {
    const dx = p.x - d.position.x, dz = p.z - d.position.z, r = Math.hypot(dx, dz);
    return r > 0 ? (dx * Math.sin(d.yaw) + dz * Math.cos(d.yaw)) / r : 1;
  }) : null;
  const reason = !d || !facing || !Number.isFinite(d.distance) ? 'dragon_unknown' :
    d.distance < 48 || chainDistance(d.position, to) < 48 ? 'dragon_near' :
    Math.max(...facing) > 0.25 ? 'dragon_facing' : 'flight_away';
  return { ok: reason === 'flight_away', reason, phase: d?.phase ?? null, distance: d?.distance ?? null, yaw: d?.yaw ?? null, facing };
}
/** Conservative straight corridor test; go still computes and checks the actual route. Missing cloud data closes the gate. */
export function chainCloudClear(view: ChainView, from: P3, to: P3 = from): boolean {
  if (!view || !Array.isArray(view.dragonBreath)) return false;
  const dx = to.x - from.x, dz = to.z - from.z, squared = dx * dx + dz * dz;
  return view.dragonBreath.every(c => {
    const t = squared ? Math.max(0, Math.min(1, ((c.x - from.x) * dx + (c.z - from.z) * dz) / squared)) : 0;
    return c.y < Math.min(from.y, to.y) - 4 || c.y > Math.max(from.y, to.y) + 4 ||
      Math.hypot(c.x - from.x - dx * t, c.z - from.z - dz * t) > Math.max(7, c.dangerRadius, c.radius) + 3;
  });
}
/** Previously reached natural ground must be away from the portal; approach.wait is the body's explicit exception. */
export function chainRetreat(view: ChainView, candidates: readonly P3[]): P3 | null {
  return candidates.find(p => chainCloudClear(view, p) &&
    ((view?.dragon?.approach?.wait ?? []).some(w => chainDistance(w, p) < 0.1) ||
      (!!view?.perch && Math.hypot(p.x - view.perch.x, p.z - view.perch.z) >= 18))) ?? null;
}
export const chainOnShaft = (at: P3, root: P3) => Math.floor(at.x) === Math.floor(root.x) && Math.floor(at.z) === Math.floor(root.z);
export type CageDescent = 'shaft_down' | 'water_drop';
export interface CagePolicy { descent: CageDescent; guard: boolean; ascentGuard?: boolean }
/** Lab HEAD choice, deliberately visible here instead of an environment/body switch. */
export const FAST_CAGE_POLICY: CagePolicy = { descent: 'water_drop', guard: false };
export function chainDescent(requested: CageDescent, height: number, bucket: boolean, landingKnown: boolean) {
  const reason = requested === 'shaft_down' ? 'requested_shaft' : !Number.isFinite(height) || height < 3 ? 'below_three' :
    !bucket ? 'no_water_bucket' : !landingKnown ? 'no_landing_column' : 'prepared_water';
  return { mode: reason === 'prepared_water' ? 'water_drop' as const : 'shaft_down' as const, reason };
}
export interface DragonMotionSample { at: number; id: number; position: P3 }
export const chainDragonSample = (view: ChainView, at: number): DragonMotionSample | null => {
  const d = view?.dragon;
  return d?.position && [at, d.id, d.position.x, d.position.y, d.position.z].every(Number.isFinite) ?
    { at, id: d.id, position: { ...d.position } } : null;
};
/** Stand-in HEAD judgement throughout cage work, never a floor reflex. Estimate m/s from two observations;
 * a >=4 m/s closing path passing within 12 m in the next 3 s calls for a pause. Thresholds are hypotheses for S1.
 * Missing/stale motion also pauses; yaw alone cannot prove a charge. No seed, phase or world coordinate is assumed. */
export function chainDragonRush(before: DragonMotionSample | null, now: DragonMotionSample | null, feet: P3) {
  const dt = before && now ? (now.at - before.at) / 1000 : 0;
  if (!before || !now || before.id !== now.id || dt < 0.2 || dt > 1.5 || ![feet.x, feet.y, feet.z].every(Number.isFinite))
    return { ok: false, reason: 'motion_unknown', velocity: null, speed: null, closing: null, closestSeconds: null, miss: null };
  const a = before.position, b = now.position;
  const velocity = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt };
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z), distance = chainDistance(feet, b);
  const dot = (feet.x - b.x) * velocity.x + (feet.y - b.y) * velocity.y + (feet.z - b.z) * velocity.z;
  const closing = distance ? dot / distance : speed;
  const closestSeconds = speed ? dot / (speed * speed) : 0;
  const t = Math.max(0, Math.min(3, closestSeconds));
  const miss = chainDistance(feet, { x: b.x + velocity.x * t, y: b.y + velocity.y * t, z: b.z + velocity.z * t });
  const rush = closing >= 4 && closestSeconds >= 0 && closestSeconds <= 3 && miss <= 12;
  return { ok: !rush, reason: rush ? 'dragon_rush' : 'motion_clear', velocity, speed, closing, closestSeconds, miss };
}
export function chainCrystal(view: ChainView, order: 'near' | 'far' = 'near'): ChainCrystal | null {
  return [...(view?.crystals.list ?? [])].sort((a, b) => (order === 'near' ? 1 : -1) * (a.distance - b.distance) || a.id - b.id)[0] ?? null;
}
/** Lab HEAD: favour a shared standing point, then the body's shorter WALK distance (not crystal distance).
 * Keep the selected set in the scene until its observed targets are finished; these are offers, not guaranteed hits. */
export function chainShootSet(view: ChainView, target?: number): NonNullable<EndObservation['crystals']['shootSets']>[number] | null {
  const live = view?.crystals.list.filter(c => c.caged === false) ?? [];
  return (view?.crystals.shootSets ?? []).map(s => ({ ...s, crystals: [...new Set(s.crystals)].filter(id => {
    const c = live.find(c => c.id === id);
    return !!c && chainDistance(s.at, c.position) >= 13 && chainDistance(s.at, c.position) <= 64;
  }) })).filter(s => s.crystals.length && Number.isFinite(s.walkMeters) && (target === undefined || s.crystals.includes(target)))
    .sort((a, b) => Number(b.crystals.length > 1) - Number(a.crystals.length > 1) ||
      a.walkMeters - b.walkMeters || b.crystals.length - a.crystals.length)[0] ?? null;
}
/** Prefer observed shootSets by walk distance; never turn a hypothetical cage opening into an ordinary opening. */
export function chainShot(view: ChainView, crystal: ChainCrystal, cageOpened = false, tried: readonly P3[] = []): P3 | null {
  const opening = view?.crystals.openings?.find(o => o.id === crystal.id);
  const candidates = cageOpened ? [...(opening?.afterCageRemoved ?? []), ...(opening?.positions ?? [])] : crystal.caged === false ?
    [...(view?.crystals.shootSets ?? []).filter(s => s.crystals.includes(crystal.id)).sort((a, b) => a.walkMeters - b.walkMeters).map(s => s.at), ...(opening?.positions ?? [])] : [];
  return candidates.find(p => chainDistance(p, crystal.position) >= 13 && chainDistance(p, crystal.position) <= 64 &&
    !tried.some(q => chainDistance(p, q) < 0.1)) ?? null;
}
/** All physical work still belongs to existing hands, including route search and the live shot refusal. */
export const chainHands = {
  shield: (): ActHand => ({ do: 'equip', item: 'shield', slot: 'offhand' }),
  go: (to: P3, seconds = 60, range = 0.5): ActHand => ({ do: 'go', to: chainCell(to), range, maxDig: 0, maxPlace: 0, maxDrop: 1, seconds }),
  crossing: (to: P3): ActHand => ({ do: 'go', to: chainCell(to), range: 1.5, canPlace: ['cobblestone'], maxPlace: 100, maxDig: 0, seconds: 120 }),
  up: (toY: number): ActHand => ({ do: 'vertical', dir: 'up', shape: 'pillar', toY: Math.floor(toY), canDig: ['none'], canPlace: ['cobblestone'], maxPlace: 64, maxDig: 0, liquid: 'stop', seconds: 60 }),
  down: (toY: number, water?: P3): ActHand => water ?
    { do: 'go', to: chainCell(water), range: 0, waterOk: true, maxDrop: 1, maxDig: 0, maxPlace: 0, seconds: 15 } :
    { do: 'vertical', dir: 'down', shape: 'shaft', toY: Math.floor(toY), canDig: ['cobblestone'], canPlace: ['none'], maxDig: 64, maxPlace: 0, liquid: 'stop', seconds: 60 },
  water: (at: P3): ActHand => ({ do: 'use', item: 'water_bucket', at: [chainCell(at)], face: 'down' }),
  scoop: (at: P3): ActHand => ({ do: 'use', item: 'bucket', at: [chainCell(at)] }),
  dig: (at: P3[]): ActHand => ({ do: 'dig', at, tool: 'iron_pickaxe', collect: false }),
  place: (at: P3[]): ActHand => ({ do: 'place', at, block: 'cobblestone' }),
  shoot: (id: number): ActHand => ({ do: 'shoot', target: id, item: 'bow', charge: 1.05, n: 1 }),
  attack: (): ActHand => ({ do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 12 }),
};
