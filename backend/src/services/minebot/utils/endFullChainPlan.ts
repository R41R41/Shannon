import type { EndObservation } from './dragonState.js';
import type { P3 } from './dragonParts.js';
import type { ActHand } from '../instantSkills/act.js';

// The lab's stand-in HEAD policy. Inputs are observation fields; no bot, terrain reader or I/O.
export type ChainView = EndObservation | null;
export type ChainCrystal = EndObservation['crystals']['list'][number];
export const CHAIN_LIMIT_MS = 40 * 60_000;
export const CRYSTAL_LIMIT_MS = 15 * 60_000;
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
  const d = view?.dragon;
  const facing = d && Number.isFinite(d.yaw) && d.position ? [from, to].map(p => {
    const dx = p.x - d.position.x, dz = p.z - d.position.z, r = Math.hypot(dx, dz);
    return r > 0 ? (dx * Math.sin(d.yaw) + dz * Math.cos(d.yaw)) / r : 1;
  }) : null;
  const reason = !d || !facing || !Number.isFinite(d.distance) ? 'dragon_unknown' :
    view?.dragonFireballs !== 0 ? 'fireball' : !chainCloudClear(view, from, to) ? 'breath' :
    d.phase !== 0 ? 'not_holding_pattern' : d.distance < 48 || chainDistance(d.position, to) < 48 ? 'dragon_near' :
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
export function chainCrystal(view: ChainView, order: 'near' | 'far' = 'near'): ChainCrystal | null {
  return [...(view?.crystals.list ?? [])].sort((a, b) => (order === 'near' ? 1 : -1) * (a.distance - b.distance) || a.id - b.id)[0] ?? null;
}
/** Preserve the body's candidate order; never turn a hypothetical cage opening into an ordinary opening. */
export function chainShot(view: ChainView, crystal: ChainCrystal, cageOpened = false, tried: readonly P3[] = []): P3 | null {
  const opening = view?.crystals.openings?.find(o => o.id === crystal.id);
  const candidates = cageOpened ? [...(opening?.afterCageRemoved ?? []), ...(opening?.positions ?? [])] : crystal.caged === false ?
    [...(view?.crystals.shootSets ?? []).filter(s => s.crystals.includes(crystal.id)).map(s => s.at), ...(opening?.positions ?? [])] : [];
  return candidates.find(p => chainDistance(p, crystal.position) >= 13 && chainDistance(p, crystal.position) <= 64 &&
    !tried.some(q => chainDistance(p, q) < 0.1)) ?? null;
}
/** All physical work still belongs to existing hands, including route search and the live shot refusal. */
export const chainHands = {
  go: (to: P3, seconds = 60, range = 0.5): ActHand => ({ do: 'go', to: chainCell(to), range, maxDig: 0, maxPlace: 0, maxDrop: 1, seconds }),
  crossing: (to: P3): ActHand => ({ do: 'go', to: chainCell(to), range: 1.5, canPlace: ['cobblestone'], maxPlace: 100, maxDig: 0, seconds: 120 }),
  up: (toY: number): ActHand => ({ do: 'vertical', dir: 'up', shape: 'pillar', toY: Math.floor(toY), canDig: ['none'], canPlace: ['cobblestone'], maxPlace: 64, maxDig: 0, liquid: 'stop', seconds: 60 }),
  down: (toY: number): ActHand => ({ do: 'vertical', dir: 'down', shape: 'shaft', toY: Math.floor(toY), canDig: ['cobblestone'], canPlace: ['none'], maxDig: 64, maxPlace: 0, liquid: 'stop', seconds: 60 }),
  dig: (at: P3[]): ActHand => ({ do: 'dig', at, tool: 'iron_pickaxe', collect: false }),
  place: (at: P3[]): ActHand => ({ do: 'place', at, block: 'cobblestone' }),
  shoot: (id: number): ActHand => ({ do: 'shoot', target: id, item: 'bow', charge: 1.05, n: 1 }),
  attack: (): ActHand => ({ do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 12 }),
};
