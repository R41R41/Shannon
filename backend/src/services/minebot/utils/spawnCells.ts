import type { StandBlock, StandCell, StandReader } from './standability.js';

/** Vanilla Java 1.21.11 ordinary blaze spawner, without custom SpawnData.
 * Block geometry only: no light/floor test, entity occupancy, six-mob cap or activation test.
 * shapes are local collision AABBs. boundingBox alone cannot describe a slab/fence.
 * Unknown geometry produces bounds, never an invented exact probability.
 */
export interface SpawnCell extends StandCell {
  weight: number;
  pMin: number;
  pMax: number;
  state: 'blocked' | 'open' | 'partial' | 'unknown';
}
export interface SpawnCells { cells: SpawnCell[]; pMin: number; pMax: number }
export interface SpawnBlockStep { at: StandCell; pMin: number; pMax: number; perMinute: number }
export interface SpawnBlockPlan extends SpawnCells { steps: SpawnBlockStep[]; reached: boolean }
type Rect = { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; unknown: boolean };
type Atom = { x: number; y: number; z: number; weight: number; unknown: boolean; cell: number };
const FULL = [0, 0, 0, 1, 1, 1] as const;
const AIR = new Set(['air', 'cave_air', 'void_air', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'fire', 'soul_fire', 'light']);
const CUBES = new Set(['cobblestone', 'stone', 'netherrack', 'nether_bricks', 'red_nether_bricks', 'cracked_nether_bricks', 'chiseled_nether_bricks', 'spawner', 'bedrock', 'obsidian', 'blackstone', 'basalt']);
const key = (p: StandCell) => `${p.x},${p.y},${p.z}`;
// EntityType.BLAZE dimensions are Java floats, widened to doubles by getSpawnAABB.
const HALF = Math.fround(Math.fround(0.6) / 2), HEIGHT = Math.fround(1.8);

/** CDF of 4*(U-V); integrate across block boundaries, not at block centres. */
export function spawnAxisCdf(t: number): number {
  if (t <= -4) return 0;
  if (t >= 4) return 1;
  return t < 0 ? (t + 4) ** 2 / 32 : 1 - (4 - t) ** 2 / 32;
}
const mass = (lo: number, hi: number, centre: number) => spawnAxisCdf(hi - centre) - spawnAxisCdf(lo - centre);

/** 20 TPS; four independent trials per active tick, cap inactive. p=0 never spawns. */
export function blazeSpawnRate(p: number): { q: number; batch: number; retryTicks: number; cycleTicks: number; perMinute: number } {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('p must be in [0,1]');
  const q = p === 1 ? 1 : -Math.expm1(4 * Math.log1p(-p));
  return { q, batch: q ? 4 * p / q : 0, retryTicks: q ? 1 / q : Infinity,
    cycleTicks: q ? 499.5 + 1 / q : Infinity, perMinute: q ? 4800 * p / (1 + 499.5 * q) : 0 };
}

function geometry(b: StandBlock | null | undefined): { boxes: readonly (readonly number[])[]; unknown: boolean } {
  if (!b) return { boxes: [[0, 0, 0, 1, 1.5, 1]], unknown: true };
  const name = b.name.replace(/^minecraft:/u, '');
  // At an integer feet height any nonempty liquid in either intersected cell obstructs Mob spawning.
  if (name === 'lava' || name === 'water') return { boxes: [FULL], unknown: false };
  if (b.shapes !== undefined) {
    if (b.shapes.every(s => s.length === 6 && s.every(Number.isFinite)
      && s[0] >= 0 && s[2] >= 0 && s[1] >= 0 && s[3] <= 1 && s[5] <= 1 && s[4] <= 1.5
      && s[0] <= s[3] && s[1] <= s[4] && s[2] <= s[5])) return { boxes: b.shapes, unknown: false };
    return { boxes: [[0, 0, 0, 1, 1.5, 1]], unknown: true };
  }
  if (AIR.has(name)) return { boxes: [], unknown: false };
  if (name === 'soul_sand') return { boxes: [[0, 0, 0, 1, 0.875, 1]], unknown: false };
  if (CUBES.has(name)) return { boxes: [FULL], unknown: false };
  return { boxes: [[0, 0, 0, 1, 1.5, 1]], unknown: true };
}

function model(read: StandReader, spawner: StandCell, candidates: readonly StandCell[]) {
  if (![spawner.x, spawner.y, spawner.z].every(Number.isInteger)) throw new Error('integer spawner required');
  const rects: Rect[] = [], sx = spawner.x + 0.5, sz = spawner.z + 0.5;
  for (let x = spawner.x - 5; x <= spawner.x + 5; x++) for (let z = spawner.z - 5; z <= spawner.z + 5; z++) {
    for (let y = spawner.y - 2; y <= spawner.y + 2; y++) {
      const g = geometry(read(x, y, z));
      for (const b of g.boxes) if (b[3] > b[0] && b[4] > b[1] && b[5] > b[2]) rects.push({
        x0: x + b[0] - HALF, x1: x + b[3] + HALF, z0: z + b[2] - HALF, z1: z + b[5] + HALF,
        y0: y + b[1], y1: y + b[4], unknown: g.unknown,
      });
    }
  }
  // All collision/candidate edges and block boundaries partition the continuous distribution exactly.
  const cuts = (centre: number, axis: 'x' | 'z') => [...new Set([
    centre - 4, centre + 4,
    ...Array.from({ length: 10 }, (_, i) => Math.floor(centre) - 4 + i),
    ...rects.flatMap(r => axis === 'x' ? [r.x0, r.x1] : [r.z0, r.z1]),
    ...candidates.flatMap(p => [p[axis] - HALF, p[axis] + 1 + HALF]),
  ].filter(v => v >= centre - 4 && v <= centre + 4))].sort((a, b) => a - b);
  const xs = cuts(sx, 'x'), zs = cuts(sz, 'z'), cells: SpawnCell[] = [], index = new Map<string, number>();
  for (let y = spawner.y - 1; y <= spawner.y + 1; y++) for (let x = spawner.x - 4; x <= spawner.x + 4; x++) for (let z = spawner.z - 4; z <= spawner.z + 4; z++) {
    index.set(key({ x, y, z }), cells.length);
    cells.push({ x, y, z, weight: mass(x, x + 1, sx) * mass(z, z + 1, sz) / 3, pMin: 0, pMax: 0, state: 'blocked' });
  }
  const atoms: Atom[] = [];
  for (let y = spawner.y - 1; y <= spawner.y + 1; y++) {
    const active = rects.filter(r => r.y0 < y + HEIGHT && r.y1 > y);
    for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < zs.length; j++) {
      const x = (xs[i] + xs[i + 1]) / 2, z = (zs[j] + zs[j + 1]) / 2;
      const hits = active.filter(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
      if (hits.some(r => !r.unknown)) continue;
      const weight = mass(xs[i], xs[i + 1], sx) * mass(zs[j], zs[j + 1], sz) / 3;
      const cell = index.get(key({ x: Math.floor(x), y, z: Math.floor(z) }))!;
      const unknown = hits.length > 0;
      cells[cell].pMax += weight;
      if (!unknown) cells[cell].pMin += weight;
      atoms.push({ x, y, z, weight, unknown, cell });
    }
  }
  for (const c of cells) c.state = c.pMax < 1e-15 ? 'blocked' : c.pMax - c.pMin > 1e-15 ? 'unknown' : c.weight - c.pMax < 1e-15 ? 'open' : 'partial';
  return { cells, atoms, pMin: cells.reduce((n, c) => n + c.pMin, 0), pMax: cells.reduce((n, c) => n + c.pMax, 0) };
}

export function spawnCells(read: StandReader, spawner: StandCell): SpawnCells {
  const { cells, pMin, pMax } = model(read, spawner, []);
  return { cells, pMin, pMax };
}

/** Greedy full cubes in replaceable cells; caller may protect paths and require reachable placement faces.
 * p is absolute per trial, not a percentage of the original room. Ties keep candidate order.
 * cells describe BEFORE; steps describe each hypothetical addition. Does not mutate read/world/candidates.
 */
export function greedySpawnBlocks(read: StandReader, spawner: StandCell, options: {
  candidates?: readonly StandCell[]; maxBlocks?: number; targetPerMinute?: number;
  minPerMinute?: number;
  eligible?: (at: StandCell, placed: readonly StandCell[]) => boolean;
} = {}): SpawnBlockPlan {
  const candidates = (options.candidates ?? [0, 1].flatMap(dy =>
    Array.from({ length: 81 }, (_, i) => ({ x: spawner.x + Math.floor(i / 9) - 4, y: spawner.y + dy, z: spawner.z + i % 9 - 4 }))))
    .filter((p, i, all) => [p.x, p.y, p.z].every(Number.isInteger) && all.findIndex(q => key(p) === key(q)) === i
      && /^(air|cave_air|void_air|fire|soul_fire)$/u.test(read(p.x, p.y, p.z)?.name ?? ''));
  const m = model(read, spawner, candidates), alive = new Set(m.atoms.map((_, i) => i));
  const masks = candidates.map(p => m.atoms.flatMap((a, i) => a.x > p.x - HALF && a.x < p.x + 1 + HALF
    && a.z > p.z - HALF && a.z < p.z + 1 + HALF && p.y < a.y + HEIGHT && p.y + 1 > a.y ? [i] : []));
  const steps: SpawnBlockStep[] = [], placed: StandCell[] = [], used = new Set<number>();
  let pMin = m.pMin, pMax = m.pMax;
  const target = options.targetPerMinute ?? 2.7;
  while (steps.length < (options.maxBlocks ?? candidates.length) && blazeSpawnRate(Math.min(1, pMax)).perMinute > target) {
    let best = -1, gain = 1e-15;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i) || options.eligible?.(candidates[i], placed) === false) continue;
      const benefit = masks[i].reduce((n, k) => n + (alive.has(k) ? m.atoms[k].weight : 0), 0);
      if (blazeSpawnRate(Math.max(0, Math.min(1, pMax - benefit))).perMinute < (options.minPerMinute ?? 0)) continue;
      if (benefit > gain) { best = i; gain = benefit; }
    }
    if (best < 0) break;
    used.add(best); placed.push({ ...candidates[best] });
    for (const k of masks[best]) if (alive.delete(k)) { pMax -= m.atoms[k].weight; if (!m.atoms[k].unknown) pMin -= m.atoms[k].weight; }
    pMin = Math.max(0, pMin); pMax = Math.max(0, pMax);
    steps.push({ at: { ...candidates[best] }, pMin, pMax, perMinute: blazeSpawnRate(Math.min(1, pMax)).perMinute });
  }
  return { cells: m.cells, pMin: m.pMin, pMax: m.pMax, steps, reached: blazeSpawnRate(Math.min(1, pMax)).perMinute <= target };
}
