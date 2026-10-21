/**
 * The shape of a tunnel the body cuts itself (utils/tunnelWalk), and the memory of the tunnels it has cut.
 *
 * Run 21: a walk across a hill (y 93 down to the water at y 58, y 57 up to the furnace at y 97, ...) was left to the route search, which
 * priced a block dug at 3 steps and a block laid at 5 and so mixed both: it dug a little, laid a bridge block, stepped round, dug again.
 * The seven far walks of the run each put their intermediate point inside the rock, and the body went down and up again, zigzagging, with a
 * stop at every rim; it came back by another zigzag. A person digs one straight line, or a stair at 1:1 (one block along, one block down),
 * and walks back up the same hole.
 *
 * Here the line is a lattice of whole cells: each step moves one cell along x or z and, on some steps, one cell up or down. The cells of
 * the steps are a pure function of the two ends, so a plan can be tested without a world. A tunnel is a combination of three shapes only
 * (run 23, Rai: "vertical, level or a stair, or those together"): a straight run along x or z, a shaft up or down, a stair at 1:1.
 */
import { Vec3 } from 'vec3';
import { nativeActionHost } from '../execution/ActionExecution.js';

export interface StairPlan {
  /** The feet cells in order, the first a step from `from`. */
  cells: Vec3[];
  /** Levels the plan could not take (more than MAX_VERTICAL): left to whoever walks on from the end. */
  shortBy: number;
}

/** The most levels taken straight down or up in one plan (a shaft or a pillar of the cells on the way, not a stair). */
export const MAX_VERTICAL = 70;

/**
 * Which horizontal run comes first: the longer ('long', the default) or the shorter ('short') of the two, or x or z outright. The two
 * orders of an L-shaped tunnel pass different ground; rockTravel prices both and takes the one that can be cut.
 */
export type LegOrder = 'long' | 'short' | 'xz' | 'zx';
function firstAxisOf(order: LegOrder, ax: number, az: number): 'x' | 'z' {
  if (order === 'xz') return 'x';
  if (order === 'zx') return 'z';
  const xLonger = Math.abs(ax) >= Math.abs(az);
  return (order === 'long') === xLonger ? 'x' : 'z';
}

/**
 * Whole cells from `from` towards `to`: one step along the dominant axis at a time (a diagonal alternates x and z, an axis-aligned line
 * is straight) and a level changed on |dy| of the steps, spread evenly (a 1:1 stair when the height asked equals the way along).
 *
 * When the height asked is more than the way along (run 21: the water 32 m below and 19 m off, the furnace 40 m above and 9 m off), a
 * stair at 1:1 cannot take it: the levels over are taken straight, a shaft down (dig the floor, drop) FIRST when going down, a pillar
 * up (tower-up) LAST when going up. They are the stair's own reverse: the way back up the shaft is a pillar, the way back down is a drop.
 */
export function planStairLine(from: Vec3, to: { x: number; y: number; z: number }, order: LegOrder = 'long'): StairPlan {
  const ax = Math.floor(to.x) - from.x, az = Math.floor(to.z) - from.z, dy = Math.floor(to.y) - from.y;
  const along = Math.abs(ax) + Math.abs(az);
  const cells: Vec3[] = [];
  const levels = Math.min(Math.abs(dy), along);
  const sx = Math.sign(ax), sz = Math.sign(az), sy = Math.sign(dy);
  const straight = Math.min(MAX_VERTICAL, Math.abs(dy) - levels);
  let x = from.x, y = from.y, z = from.z;
  // Down: the shaft first.
  if (sy < 0) for (let i = 0; i < straight; i++) cells.push(new Vec3(x, --y, z));
  // The tunnel runs along one axis to the end of it, then along the other: two straight runs, never a diagonal of alternating steps
  // (a diagonal is twice the cells a person would dig for the same ground covered, and run 23's walks dug a zigzag of it).
  const firstAxis = firstAxisOf(order, ax, az);
  const firstLength = firstAxis === 'x' ? Math.abs(ax) : Math.abs(az);
  let taken = 0;
  for (let i = 0; i < along; i++) {
    const alongX = (i < firstLength) === (firstAxis === 'x');
    if (alongX) x += sx; else z += sz;
    const wanted = Math.floor(((i + 1) * levels) / along);
    if (wanted > taken) { y += sy; taken++; }
    cells.push(new Vec3(x, y, z));
  }
  // Up: the pillar last.
  if (sy > 0) for (let i = 0; i < straight; i++) cells.push(new Vec3(x, ++y, z));
  return { cells, shortBy: Math.max(0, Math.abs(dy) - levels - straight) };
}
const key = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;
const parse = (text: string) => { const [x, y, z] = text.split(',').map(Number); return new Vec3(x, y, z); };

/** Edges kept at most; past it the oldest half of the memory is let go. */
const MAX_TRAIL_EDGES = 6000;

/**
 * The cells the body has stood in on a tunnel it cut, joined as they were walked. The way back to where a tunnel began is these cells
 * the other way: each step of a cut stair is a legal step in reverse (the cells above it were dug as well), so nothing new is dug.
 */
export class TunnelTrail {
  private readonly links = new Map<string, Set<string>>();
  private edges = 0;

  add(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): void {
    const from = key(a), to = key(b);
    if (from === to) return;
    for (const [one, other] of [[from, to], [to, from]] as const) {
      let set = this.links.get(one);
      if (!set) this.links.set(one, set = new Set());
      if (!set.has(other)) { set.add(other); this.edges++; }
    }
    if (this.edges > MAX_TRAIL_EDGES) this.forgetOldest();
  }

  get size(): number { return this.links.size; }

  clear(): void { this.links.clear(); this.edges = 0; }

  private forgetOldest(): void {
    // Map keeps insertion order: the first cells were walked first.
    const drop = new Set([...this.links.keys()].slice(0, Math.floor(this.links.size / 2)));
    for (const cell of drop) this.links.delete(cell);
    let edges = 0;
    for (const set of this.links.values()) {
      for (const other of [...set]) if (drop.has(other)) set.delete(other);
      edges += set.size;
    }
    this.edges = edges;
  }

  /**
   * The cells to walk from the trail cell at the body's feet (within a cell across, a level up or down) to the nearest trail cell that
   * satisfies `reached`. Null when the body is not on the trail or the trail does not lead there. `maxCells` bounds the search.
   */
  route(feet: { x: number; y: number; z: number }, reached: (cell: Vec3) => boolean, maxCells = 800): Vec3[] | null {
    let start: string | null = null, best = Infinity;
    for (const cell of this.links.keys()) {
      const c = parse(cell);
      const across = Math.abs(c.x - feet.x) + Math.abs(c.z - feet.z), up = Math.abs(c.y - feet.y);
      if (across <= 1 && up <= 1 && across + up < best) { best = across + up; start = cell; }
    }
    if (start === null) return null;
    const previous = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    for (let head = 0; head < queue.length && queue.length <= maxCells; head++) {
      const here = queue[head];
      if (reached(parse(here))) {
        const path: Vec3[] = [];
        for (let at: string | null = here; at !== null; at = previous.get(at) ?? null) path.push(parse(at));
        path.reverse();
        // The first cell is where the body stands (or beside it): the walk starts after it.
        return path.slice(1);
      }
      for (const next of this.links.get(here) ?? []) {
        if (previous.has(next)) continue;
        previous.set(next, here);
        queue.push(next);
      }
    }
    return null;
  }
}

const trails = new WeakMap<object, TunnelTrail>();
/**
 * The trail of this body, kept for the life of the body object (a new world starts with a new body). Keyed by the native body: a skill
 * works through a motor port made for its action (a new proxy every action), and a trail kept on that would be gone by the way back.
 */
export function trailOf(bot: object): TunnelTrail {
  const host = nativeActionHost(bot);
  let trail = trails.get(host);
  if (!trail) trails.set(host, trail = new TunnelTrail());
  return trail;
}
