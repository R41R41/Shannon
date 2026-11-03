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
