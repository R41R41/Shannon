import { ENDERMAN_EYE, endermanLine, planRoof, roofExitForSight, type Cell3, type RoofWorld } from './huntEnderman.js';
import type { BlockReader } from './localMap.js';

type Creature = { id: number; position: Cell3 };
export type CandidateVia = 'centre' | 'exit';
const distance = (a: Cell3, b: Cell3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const inRange = (a: Cell3, b: Cell3) => distance(a, b) >= 8 && distance(a, b) <= 48;

/** Probe head only. An exit is offered only with an existing roof or the caller's explicit future roof. */
export function huntCandidates<T extends Creature>(read: BlockReader, from: Cell3, entities: T[], roof: Cell3 | null,
  occupied: (cell: Cell3) => boolean = () => false) {
  const candidates: Array<T & { via: CandidateVia }> = [];
  for (const entity of entities) {
    if (!inRange(from, entity.position)) continue;
    const eyes = endermanLine(read, from, entity.position, ENDERMAN_EYE);
    const via = eyes.clear ? 'centre' : roof && roofExitForSight(read, roof, entity.position, eyes, occupied).length ? 'exit' : null;
    if (via) candidates.push({ ...entity, via });
  }
  // Keep the explicit near band before distant fallbacks; the head's find() scans in this order.
  return candidates.sort((a, b) => Number(distance(from, a.position) > 30) - Number(distance(from, b.position) > 30)
    || distance(from, a.position) - distance(from, b.position));
}

/** The eight 12m eye directions measure persistent openness; visible counts the individuals present now. */
export function compareRoofClearings(a: { horizons: number; visible: number; distance: number }, b: typeof a): number {
  return b.horizons - a.horizons || b.visible - a.visible || a.distance - b.distance;
}

/** The probe's existing loaded-block site scan, kept outside the large live scene. No movement or target decision here. */
export function chooseRoofClearing(read0: BlockReader, world: RoofWorld, p: Cell3, entities: Creature[], options: {
  relocate: boolean; wide: boolean; blocks: number; visited: (cell: Cell3) => boolean; reject: (reason: string) => void;
  occupied: (cell: Cell3) => boolean;
}) {
  const { relocate, wide, reject } = options, cache = new Map<string, ReturnType<BlockReader>>();
  const read: BlockReader = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (!cache.has(k)) cache.set(k, read0(x, y, z));
    return cache.get(k)!;
  };
  const sites: Array<{ cell: Cell3; visible: number; horizons: number; distance: number }> = [];
  const radius = relocate || wide ? 16 : 7;
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const distance = Math.hypot(Math.floor(p.x) + dx + 0.5 - p.x, Math.floor(p.z) + dz + 0.5 - p.z);
    if (distance > (relocate || wide ? 15.5 : 7) || (relocate && !wide && distance < 8.5)) continue;
    for (let dy = -2; dy <= 2; dy++) {
      const c = { x: Math.floor(p.x) + dx, y: Math.floor(p.y + 0.001) + dy, z: Math.floor(p.z) + dz };
      if (options.visited(c)) { reject('visited'); continue; }
      // The inner 3x3 stays level and clear. The outer ring retains the existing allowance of six bad columns.
      let flat = true, outerBad = 0;
      for (let ux = -2; ux <= 2 && flat; ux++) for (let uz = -2; uz <= 2; uz++) {
        const floor = read(c.x + ux, c.y - 1, c.z + uz), feet = read(c.x + ux, c.y, c.z + uz), head = read(c.x + ux, c.y + 1, c.z + uz);
        const bad = !floor?.solid || (floor.top ?? 1) !== 1 || /lava|water|magma|campfire|slab|stairs|fence|wall|leaves/u.test(floor.name)
          || !feet || !head || feet.solid || head.solid || /lava|water|fire|portal|cobweb/u.test(`${feet.name} ${head.name}`);
        if (bad && Math.abs(ux) <= 1 && Math.abs(uz) <= 1) { flat = false; break; }
        if (bad && ++outerBad > 6) { flat = false; break; }
      }
      if (!flat) { reject('not_flat'); continue; }
      const plan = planRoof(world, c, undefined, undefined, true);
      if (plan.problems.length) { reject('plan:' + String(plan.problems[0]).slice(0, 40)); continue; }
      if (options.blocks < plan.placements.length || (relocate && !wide && plan.caps === 0)) { reject('blocks_or_caps'); continue; }
      const future: BlockReader = (x, y, z) => y === c.y + 2 && Math.abs(x - c.x) <= 1 && Math.abs(z - c.z) <= 1
        ? { name: 'cobblestone', solid: true } : read(x, y, z);
      const from = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 };
      const visible = huntCandidates(future, from, entities, c, options.occupied).length;
      let horizons = 0;
      for (let k = 0; k < 8; k++) if (endermanLine(future, from, {
        x: from.x + 12 * Math.cos(k * Math.PI / 4), y: c.y, z: from.z + 12 * Math.sin(k * Math.PI / 4),
      }, ENDERMAN_EYE).clear) horizons++;
      if (horizons > 0) sites.push({ cell: c, visible, horizons, distance }); else reject('no_horizon');
    }
  }
  return sites.sort(compareRoofClearings)[0] ?? null;
}

/** Read only: ground-level range, eyes at floor+4.62 (endermanLine adds 1.62 to the hypothetical feet). */
export function roofTopCandidates(read: BlockReader, from: Cell3 | null, entities: Creature[]) {
  if (!from || ![from.x, from.y, from.z].every(Number.isFinite)) return { topCandidates: null, topCandidateIds: null };
  const top = { ...from, y: from.y + 3 };
  const ids = new Set(entities.filter(e => inRange(from, e.position)
    && endermanLine(read, top, e.position, ENDERMAN_EYE).clear).map(e => e.id));
  return { topCandidates: ids.size, topCandidateIds: [...ids] };
}

/** Accumulate the same readings written to observations and decision rows, without influencing eligibility. */
export class RoofTopReadings {
  private seen = new Set<number>();
  private measured = false;
  get unique(): number | null { return this.measured ? this.seen.size : null; }
  observe(read: BlockReader, from: Cell3 | null, entities: Creature[]) {
    const result = roofTopCandidates(read, from, entities);
    if (result.topCandidateIds) this.measured = true;
    for (const id of result.topCandidateIds ?? []) this.seen.add(id);
    return result;
  }
}
