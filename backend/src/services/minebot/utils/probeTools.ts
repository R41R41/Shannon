import { symbolFor, isOpenSymbol, type BlockReader, type Cell, type MapBlock } from './localMap.js';
import { BLOCK_REACH } from './blockReach.js';
import { LoopSlicer } from './loadedBlockScan.js';
import { wayWords } from './worldScanState.js';
import type { HandRecord } from './handHistory.js';
import { footingAt, footingWords } from './voidFooting.js';
import { BESIDE, blockedWords, cellWay, climbRise, enterable, floorOf, isClimbable, isLava, isTall, isWater, MAX_CLIMB, MAX_FALL, passable, standable, whyNotStand } from './walkRules.js';

export { enterable, isWater, MAX_FALL, passable, standable } from './walkRules.js';

/**
 * The body's reading tools (r4 contract 1, `probe`): read only, fixed computations over the blocks the body has and the creatures it
 * sees, no LLM and no choice. Each answer starts with a short Japanese sentence that says a dangerous fact as it is ("下 7 段は空気（落差
 * 7）", "この先 2 マスは水深 3"), never in words that read as a way to go (arch-check 6, S1: "切れ目：足元の土" was read as "dig the dirt for a
 * foothold" and the decision dropped seven blocks into a cave). The core is pure but for its reader, so tests give it fixed blocks.
 */

// ===== Cells as a body meets them: the walk's own rules (utils/walkRules, r5) =====

const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/u;
const AIR = new Set(['air', 'cave_air', 'void_air']);

const solidOf = (block: MapBlock) => block.solid ?? !isOpenSymbol(symbolFor(block));
const climbable = isClimbable;

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const unkey = (k: string): Cell => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const at = (cell: Cell) => `(${cell.x},${cell.y},${cell.z})`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const nameOf = (block: MapBlock | null) => block ? block.name : '未ロード';

// ===== path =====

export interface PathBreak { at: Cell; reason: 'drop' | 'wall' | 'water' | 'lava' | 'gap' | 'low' | 'unloaded'; n?: number; block?: string; depth?: number; text: string }
export interface PathAnswer {
  v: 1; kind: 'path'; text: string; reachable: boolean;
  steps?: number; swim?: number; up?: number; down?: number; maxDrop?: number; maxWaterDepth?: number;
  points?: Cell[]; goal?: Cell; breaks?: PathBreak[]; nearest?: Cell; nearestGap?: number;
  /** r5: whether a body can stand in the target cell itself (false: the text begins "的そのものには立てない（…）"). */
  onTarget?: boolean;
  stands?: Array<{ at: Cell; eye: number; steps: number | null }>; searched: number; limited?: boolean; ms: number;
}
interface Search { dist: Map<string, number>; prev: Map<string, string>; limited: boolean }

/** The search's bounds: cells, time, and the box round the way (blocks beyond the start and the target). */
export const PATH_LIMITS = { cells: 60_000, ms: 1500, margin: 24, below: 24, above: 16, farthest: 256 };

/**
 * Breadth first over the cells a body can be in, moving as the walk does (no dig, no block laid): a step across, a step up of one with room
 * over the head, a drop of three at most (into water any height), swimming up and down in water and on a ladder. Stops at a goal cell, at
 * PATH_LIMITS.cells, or past the time, giving the loop back meanwhile.
 */
async function walkSearch(read: BlockReader, from: Cell, goals: Set<string>, box: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number },
  slicer: LoopSlicer, deadline: number, maxCells: number): Promise<Search & { goal: string | null }> {
  const dist = new Map<string, number>(), prev = new Map<string, string>();
  const start = key(from.x, from.y, from.z);
  dist.set(start, 0);
  const queue: Cell[] = [from];
  let goal: string | null = goals.has(start) ? start : null, limited = false;
  const inside = (x: number, y: number, z: number) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
  const push = (c: Cell, x: number, y: number, z: number) => {
    if (!inside(x, y, z)) return;
    const k = key(x, y, z);
    if (dist.has(k)) return;
    const ck = key(c.x, c.y, c.z);
    dist.set(k, dist.get(ck)! + 1); prev.set(k, ck); queue.push({ x, y, z });
    if (goals.has(k)) goal = k;
  };
  for (let i = 0; i < queue.length && !goal; i++) {
    if (dist.size >= maxCells || performance.now() > deadline) { limited = true; break; }
    if ((i & 255) === 0 && slicer.due()) await slicer.pause();
    const c = queue[i];
    const here = read(c.x, c.y, c.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = c.x + dx, z = c.z + dz;
      if (standable(read, x, c.y, z)) { push(c, x, c.y, z); continue; }
      // A climb of one: room over the head, and no more than the route search climbs (r7: 1.2 from the floor stood on; a fence is no step).
      if (standable(read, x, c.y + 1, z) && passable(read(c.x, c.y + 2, c.z)) && climbRise(read, c.x, c.y, c.z, x, z) <= MAX_CLIMB + 1e-9) { push(c, x, c.y + 1, z); continue; }
      if (!passable(read(x, c.y, z)) || !passable(read(x, c.y + 1, z))) continue;
      // Off the edge: the cell it lands in, within three (water too: the walk's movements keep infiniteLiquidDropdownDistance off). The
      // cells fallen through are open ones (leaves and doors under the feet are not broken or opened: they are landed on, or no way).
      let fall = 0;
      for (let k = 1; k <= MAX_FALL + 1; k++) {
        const cell = read(x, c.y - k, z);
        if (isWater(cell)) { if (k <= MAX_FALL) push(c, x, c.y - k, z); fall = k; break; }
        if (!enterable(cell)) { if (k - 1 >= 1 && k - 1 <= MAX_FALL && floorOf(cell)) push(c, x, c.y - k + 1, z); fall = k - 1; break; }
        fall = k;
      }
      // The walk's safe parkour (utils/setMovements): a gap of one to three jumped to the same height, only where falling into it would
      // be a drop of three at most (or water).
      if (fall >= 1 && enterable(read(c.x, c.y + 2, c.z)) && enterable(read(x, c.y, z)) && enterable(read(x, c.y + 1, z))) {
        for (let gap = 1; gap <= 3; gap++) {
          const gx = c.x + dx * gap, gz = c.z + dz * gap;
          if (!enterable(read(gx, c.y, gz)) || !enterable(read(gx, c.y + 1, gz)) || !enterable(read(gx, c.y + 2, gz))) break;
          if (gapFall(read, gx, c.y, gz) > MAX_FALL) break;
          const lx = c.x + dx * (gap + 1), lz = c.z + dz * (gap + 1);
          if (standable(read, lx, c.y, lz) && enterable(read(lx, c.y + 2, lz))) { push(c, lx, c.y, lz); break; }
        }
      }
    }
    if (isWater(here) || climbable(here)) {
      if (standable(read, c.x, c.y + 1, c.z)) push(c, c.x, c.y + 1, c.z);
      const below = read(c.x, c.y - 1, c.z);
      if (isWater(below) || climbable(below)) push(c, c.x, c.y - 1, c.z);
    }
  }
  return { dist, prev, limited, goal };
}

/** How far a body would fall into a gap cell before landing (water: 0; nothing to land on within 64: Infinity), as setMovements' gapDrop. */
function gapFall(read: BlockReader, x: number, y: number, z: number): number {
  for (let depth = 1; depth <= 64; depth++) {
    const block = read(x, y - depth, z);
    if (!block || isLava(block)) return Infinity;
    if (isWater(block)) return 0;
    if (!enterable(block)) return depth - 1;
  }
  return Infinity;
}

function pathOf(prev: Map<string, string>, to: string): Cell[] {
  const out: Cell[] = [];
  for (let k: string | undefined = to; k; k = prev.get(k)) out.push(unkey(k));
  return out.reverse();
}

/** The way's points for walk's `path`: where it turns, goes up or down, or enters or leaves water; at most `most`, the last the goal. */
function wayPoints(read: BlockReader, path: Cell[], most = 16): Cell[] {
  const points: Cell[] = [];
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    const turn = (b.x - a.x) !== (c.x - b.x) || (b.z - a.z) !== (c.z - b.z) || b.y !== a.y || c.y !== b.y;
    const water = isWater(read(a.x, a.y, a.z)) !== isWater(read(b.x, b.y, b.z));
    if (turn || water) points.push(b);
  }
  if (path.length > 1) points.push(path[path.length - 1]);
  if (points.length <= most) return points;
  const out: Cell[] = [];
  for (let i = 1; i <= most; i++) out.push(points[Math.round((i * points.length) / most) - 1]);
  return out;
}

/** How deep the water is at a cell (the water cells down from it). */
function waterDepth(read: BlockReader, cell: Cell): number {
  let depth = 0;
  while (depth < 32 && isWater(read(cell.x, cell.y - depth, cell.z))) depth++;
  return depth;
}
/** How many cells of open air are under a cell (0: a floor right under it), and what is at the bottom. */
function airBelow(read: BlockReader, x: number, y: number, z: number, most = 48): { n: number; bottom: MapBlock | null; bottomY: number } {
  let n = 0;
  for (; n < most; n++) {
    const block = read(x, y - 1 - n, z);
    if (!block || !enterable(block) || isWater(block)) return { n, bottom: block, bottomY: y - 1 - n };
  }
  return { n, bottom: read(x, y - 1 - n, z), bottomY: y - 1 - n };
}

/** Why a body at `c` cannot step into `n` (beside it, toward the target): the exact fact, in words that say the danger. */
function stepFact(read: BlockReader, c: Cell, n: Cell): PathBreak {
  const feet = read(n.x, n.y, n.z), head = read(n.x, n.y + 1, n.z);
  if (!feet || !head) return { at: n, reason: 'unloaded', text: `${at(n)} は読み込まれていない（未ロード）` };
  if (isLava(feet) || isLava(head)) return { at: n, reason: 'lava', block: 'lava', text: `${at(n)} は溶岩` };
  // A shut iron door (or another block not walked into) in the way: said by its name, as the walk says it.
  for (const [cell, block] of [[n, feet], [{ ...n, y: n.y + 1 }, head]] as const) {
    const way = cellWay(block);
    if (way === 'iron_door' || way === 'harm') return { at: cell, reason: 'wall', n: 1, block: block.name, text: blockedWords(block, cell)! };
  }
  if (!passable(feet)) {
    let h = 0;
    while (h < 8 && !passable(read(n.x, n.y + h, n.z))) h++;
    // r7: a fence or a wall is neither climbed nor stood on; a block a cell up from a low floor (a slab) is more than the climb.
    if (h === 1 && isTall(feet)) return { at: n, reason: 'wall', n: 1, block: feet.name, text: `${at(n)} は ${feet.name}（高さ 1.5。柵・塀は上れず、上にも立てない）` };
    if (h === 1 && passable(read(n.x, n.y + 2, n.z)) && passable(read(c.x, c.y + 2, c.z))) {
      const rise = climbRise(read, c.x, c.y, c.z, n.x, n.z);
      if (rise > MAX_CLIMB + 1e-9) return { at: n, reason: 'wall', n: 1, block: feet.name, text: `${at(n)} の ${feet.name} へは上り ${round1(rise)}（今の床 ${at({ ...c, y: c.y - 1 })} が低い。walk の上りは ${MAX_CLIMB} まで）` };
    }
    if (h === 1 && passable(read(n.x, n.y + 1, n.z)) && passable(read(n.x, n.y + 2, n.z)) && !passable(read(c.x, c.y + 2, c.z))) {
      const over = read(c.x, c.y + 2, c.z);
      return { at: { x: c.x, y: c.y + 2, z: c.z }, reason: 'low', block: nameOf(over), text: `${at(n)} の 1 段を上るには、頭の上 ${at({ x: c.x, y: c.y + 2, z: c.z })} の ${nameOf(over)} がつかえる（高さ 1 のすき間）` };
    }
    return { at: n, reason: 'wall', n: h, block: feet.name, text: `${at(n)} は ${feet.name} の壁（高さ ${h >= 8 ? '8 以上' : h}）` };
  }
  if (!passable(head)) return { at: { ...n, y: n.y + 1 }, reason: 'low', block: head.name, text: `${at(n)} は頭の高さ ${at({ ...n, y: n.y + 1 })} が ${head.name}（高さ 1 のすき間）` };
  if (isWater(feet)) {
    const depth = waterDepth(read, n);
    return { at: n, reason: 'water', n: depth, text: `${at(n)} から先は水深 ${depth >= 32 ? '32 以上' : depth}` };
  }
  const fall = airBelow(read, n.x, n.y, n.z);
  const dx = Math.sign(n.x - c.x), dz = Math.sign(n.z - c.z);
  // The hole's width along the way: the next cell with a floor at the same height within 4.
  let width = 1;
  while (width <= 4 && !standable(read, n.x + dx * width, n.y, n.z + dz * width)) width++;
  const bottom = fall.bottom ? `底 y=${fall.bottomY} ${fall.bottom.name}` : `底 y=${fall.bottomY} は未ロード`;
  if (isLava(fall.bottom)) return { at: n, reason: 'lava', n: fall.n, block: 'lava', text: `${at(n)} の下 ${fall.n} 段は空気で、その下は溶岩（落差 ${fall.n}）` };
  const depthWords = `下 ${fall.n >= 48 ? '48 以上' : fall.n} 段は空気（落差 ${fall.n}、${bottom}）`;
  if (width <= 4) return { at: n, reason: 'gap', n: width, depth: fall.n, text: `${at(n)} から先は幅 ${width} の穴。${depthWords}` };
  return { at: n, reason: 'drop', n: fall.n, depth: fall.n, text: `${at(n)} の${depthWords}` };
}

/** Cells round a target a body could stand in to reach it (eye within BLOCK_REACH of its centre) with nothing solid between. */
function standSpots(read: BlockReader, target: Cell, dist: Map<string, number>, most: number): Array<{ at: Cell; eye: number; steps: number | null }> {
  const spots: Array<{ at: Cell; eye: number; steps: number | null }> = [];
  const centre: [number, number, number] = [target.x + 0.5, target.y + 0.5, target.z + 0.5];
  for (let dx = -5; dx <= 5; dx++) for (let dy = -6; dy <= 3; dy++) for (let dz = -5; dz <= 5; dz++) {
    const c = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
    if (c.x === target.x && c.z === target.z && (c.y === target.y || c.y + 1 === target.y)) continue;
    const eye: [number, number, number] = [c.x + 0.5, c.y + 1.62, c.z + 0.5];
    const d = Math.hypot(eye[0] - centre[0], eye[1] - centre[1], eye[2] - centre[2]);
    if (d > BLOCK_REACH || !standable(read, c.x, c.y, c.z)) continue;
    if (solidBetween(read, eye, centre).length) continue;
    spots.push({ at: c, eye: round1(d), steps: dist.get(key(c.x, c.y, c.z)) ?? null });
  }
  spots.sort((a, b) => (a.steps ?? 1e9) - (b.steps ?? 1e9) || a.eye - b.eye);
  return spots.slice(0, most);
}

/**
 * path: whether `to` is reached from `from` without digging or laying a block, by the walk's rules. Reached: the steps, how many swum, up
 * and down, the deepest water and the biggest drop on the way, and the way's points (walk's `path`). Not reached: the nearest cell reached,
 * up to three breaks with their exact fact, and the cells near the target a body could stand in and reach it from.
 */
export async function probePath(read: BlockReader, from: Cell, to: Cell, options: { slicer?: LoopSlicer; limits?: Partial<typeof PATH_LIMITS> } = {}): Promise<PathAnswer> {
  const started = performance.now();
  const limits = { ...PATH_LIMITS, ...options.limits };
  const slicer = options.slicer ?? new LoopSlicer(8);
  const straight = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const head = `${at(from)}→${at(to)} 直線 ${round1(straight)}m`;
  if (straight > limits.farthest) {
    return { v: 1, kind: 'path', reachable: false, searched: 0, ms: 0, limited: true, text: `${head}：遠すぎて調べない（${limits.farthest}m まで）。途中の点を的にして調べる` };
  }
  const goals = new Set<string>();
  // The walk goes to the target cell itself; when no body can stand there (run 28 +1,100: "着くのは的の隣" while the walk stopped on "立つ床が
  // 無い"), the text says so first, and the cells beside it are what is searched for.
  const onTarget = standable(read, to.x, to.y, to.z);
  const notStand = onTarget ? null : whyNotStand(read, to);
  if (onTarget) goals.add(key(to.x, to.y, to.z));
  else {
    for (const [dx, dy, dz] of BESIDE) {
      if (standable(read, to.x + dx, to.y + dy, to.z + dz)) goals.add(key(to.x + dx, to.y + dy, to.z + dz));
    }
  }
  const standNote = (beside: Cell | null) => notStand ? `的そのものには立てない（${notStand.text}）。${beside ? `隣 ${at(beside)} まで。` : ''}` : '';
  const m = limits.margin;
  const box = { x0: Math.min(from.x, to.x) - m, x1: Math.max(from.x, to.x) + m, z0: Math.min(from.z, to.z) - m, z1: Math.max(from.z, to.z) + m,
    y0: Math.max(-64, Math.min(from.y, to.y) - limits.below), y1: Math.min(319, Math.max(from.y, to.y) + limits.above) };
  const search = await walkSearch(read, from, goals, box, slicer, started + limits.ms, limits.cells);
  const startNote = standable(read, from.x, from.y, from.z) ? '' : `（出発 ${at(from)} は立てる所ではない）`;
  if (search.goal) {
    const path = pathOf(search.prev, search.goal);
    let swim = 0, up = 0, down = 0, maxDrop = 0, maxWaterDepth = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (isWater(read(b.x, b.y, b.z))) { swim++; maxWaterDepth = Math.max(maxWaterDepth, waterDepth(read, b)); }
      if (b.y > a.y) up++;
      if (b.y < a.y) { down++; if (b.x !== a.x || b.z !== a.z) maxDrop = Math.max(maxDrop, a.y - b.y); }
    }
    const goal = unkey(search.goal);
    const facts = [`泳ぎ ${swim}`, `上り ${up}`, `下り ${down}`];
    if (maxWaterDepth) facts.push(`水深 最大 ${maxWaterDepth}`);
    if (maxDrop) facts.push(`落差 最大 ${maxDrop}`);
    slicer.end();
    const points = wayPoints(read, path);
    const beside = goal.x !== to.x || goal.y !== to.y || goal.z !== to.z;
    return { v: 1, kind: 'path', reachable: true, steps: path.length - 1, swim, up, down, maxDrop, maxWaterDepth, points, goal, onTarget, searched: search.dist.size,
      ms: Math.round(performance.now() - started),
      text: `${standNote(beside ? goal : null)}${head}：${beside ? `隣 ${at(goal)} まで` : ''}掘らず置かずに歩いて行ける${startNote}。${path.length - 1} マス（${facts.join('・')}）。道の点 ${points.length}` };
  }
  // Not reached: the reached cells nearest the target, and what stands between each and the next cell toward it.
  const reached = [...search.dist.keys()].map(unkey).map(cell => ({ cell, d: Math.hypot(cell.x - to.x, cell.y - to.y, cell.z - to.z) }))
    .sort((a, b) => a.d - b.d);
  const nearest = reached[0]?.cell;
  const breaks: PathBreak[] = [];
  const used: Cell[] = [];
  for (const { cell } of reached) {
    if (breaks.length >= 3) break;
    if (used.some(other => Math.hypot(other.x - cell.x, other.z - cell.z) < 3 && Math.abs(other.y - cell.y) < 3)) continue;
    const dx = to.x - cell.x, dz = to.z - cell.z;
    if (!dx && !dz) {
      // Straight up or down from here: what the column between holds, as runs (a hollow in it said as air with its height).
      const dy = to.y - cell.y;
      if (!dy) continue;
      used.push(cell);
      const between = probeColumn(read, cell.x, cell.z, dy > 0 ? cell.y + 2 : to.y, dy > 0 ? to.y : cell.y - 1);
      const runs = between.runs.slice(0, 5).map(run => `${run.top === run.bottom ? `y=${run.top}` : `y=${run.top}〜${run.bottom}`} ${run.name}${run.n > 1 ? `×${run.n}` : ''}`).join(' / ');
      const air = between.runs.filter(run => run.name === '空気').reduce((most, run) => Math.max(most, run.n), 0);
      breaks.push({ at: cell, reason: dy < 0 && air > MAX_FALL ? 'drop' : 'wall', n: Math.abs(dy),
        text: `的は ${at(cell)} の真${dy > 0 ? '上' : '下'} ${Math.abs(dy)} 段（間：${runs}${between.runs.length > 5 ? ' …' : ''}）` });
      continue;
    }
    const ways: Array<[number, number]> = Math.abs(dx) >= Math.abs(dz) ? [[Math.sign(dx), 0], ...(dz ? [[0, Math.sign(dz)] as [number, number]] : [])]
      : [[0, Math.sign(dz)], ...(dx ? [[Math.sign(dx), 0] as [number, number]] : [])];
    for (const [sx, sz] of ways) {
      const next = { x: cell.x + sx, y: cell.y, z: cell.z + sz };
      if (search.dist.has(key(next.x, next.y, next.z)) || search.dist.has(key(next.x, next.y + 1, next.z))) continue;
      const fact = stepFact(read, cell, next);
      // Seen from water (a bank too high to climb out onto), it says so.
      if (isWater(read(cell.x, cell.y, cell.z))) fact.text = `水の中 ${at(cell)} から：${fact.text}`;
      breaks.push(fact);
      used.push(cell);
      break;
    }
  }
  const stands = standSpots(read, to, search.dist, 3);
  slicer.end();
  const lines = [`${standNote(null)}${head}：掘らず置かずには行けない${startNote}${search.limited ? `（上限 ${search.dist.size} マスまで調べた所では）` : ''}。`];
  if (nearest) lines.push(`行ける所で的に一番近いのは ${at(nearest)}（的まで ${round1(reached[0].d)}m）。`);
  if (breaks.length) lines.push(`切れ目：${breaks.map(b => b.text).join('／')}。`);
  lines.push(stands.length ? `的に届いて見える立つ所：${stands.map(s => `${at(s.at)} 目から${s.eye}m ${s.steps === null ? '行けない' : `道 ${s.steps} マス`}`).join('／')}`
    : `的に届いて見える立つ所は無い（${BLOCK_REACH}m 内に立てる所が無いか、間に固いブロック）`);
  return { v: 1, kind: 'path', reachable: false, onTarget, ...(nearest ? { nearest, nearestGap: round1(reached[0].d) } : {}), breaks, stands, searched: search.dist.size,
    ...(search.limited ? { limited: true } : {}), ms: Math.round(performance.now() - started), text: lines.join('') };
}

// ===== sight =====

/** The solid cells a straight line from `a` to `b` passes through (not the first or the last cell), in order. */
export function solidBetween(read: BlockReader, a: [number, number, number], b: [number, number, number]): Cell[] {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const steps = Math.max(1, Math.ceil(d / 0.05));
  const first = key(Math.floor(a[0]), Math.floor(a[1]), Math.floor(a[2])), last = key(Math.floor(b[0]), Math.floor(b[1]), Math.floor(b[2]));
  const seen = new Set<string>(), out: Cell[] = [];
  for (let i = 1; i < steps; i++) {
    const x = Math.floor(a[0] + (b[0] - a[0]) * i / steps), y = Math.floor(a[1] + (b[1] - a[1]) * i / steps), z = Math.floor(a[2] + (b[2] - a[2]) * i / steps);
    const k = key(x, y, z);
    if (k === first || k === last || seen.has(k)) continue;
    seen.add(k);
    const block = read(x, y, z);
    if (!block || (solidOf(block) && !isWater(block))) out.push({ x, y, z });
  }
  return out;
}

/**
 * Whether the eye sees some face of a block (r5, dig: run 28's "Digging aborted" ×31 were cells behind stone). The centre and each face
 * open to the air are looked at; seen when one of them has nothing solid between. Not seen: the solid cells on the line to the centre.
 */
export function blockInSight(read: BlockReader, eye: [number, number, number], cell: Cell): { visible: boolean; between: Array<{ at: Cell; name: string }> } {
  const centre: [number, number, number] = [cell.x + 0.5, cell.y + 0.5, cell.z + 0.5];
  const points: Array<[number, number, number]> = [centre];
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const next = read(cell.x + dx, cell.y + dy, cell.z + dz);
    if (next && solidOf(next) && !isWater(next)) continue;
    points.push([centre[0] + dx * 0.45, centre[1] + dy * 0.45, centre[2] + dz * 0.45]);
  }
  for (const point of points) if (!solidBetween(read, eye, point).length) return { visible: true, between: [] };
  return { visible: false, between: solidBetween(read, eye, centre).slice(0, 4).map(c => ({ at: c, name: nameOf(read(c.x, c.y, c.z)) })) };
}

export interface SightCreature { id: number; name: string; position: { x: number; y: number; z: number }; height?: number; width?: number }
export interface SightAnswer { v: 1; kind: 'sight'; text: string; visible: boolean; reach: boolean; reachLimit: number; distance: number;
  between: Array<{ at: Cell; name: string }>; target: { at: Cell; name: string } }
export { BLOCK_REACH };
export const HIT_REACH = 3;

/** The eye of a body standing at a feet position (a cell's centre when `cell`). */
export function eyeOf(position: { x: number; y: number; z: number }, cell = false): [number, number, number] {
  return cell ? [position.x + 0.5, position.y + 1.62, position.z + 0.5] : [position.x, position.y + 1.62, position.z];
}

/** sight: from an eye to a block's centre, or to a creature: seen or not, in reach, the distance, the solid cells between. */
export function probeSight(read: BlockReader, eye: [number, number, number], target: { block: Cell } | { creature: SightCreature }): SightAnswer {
  let point: [number, number, number], reachLimit: number, distance: number, name: string, cell: Cell;
  if ('block' in target) {
    cell = target.block;
    point = [cell.x + 0.5, cell.y + 0.5, cell.z + 0.5];
    reachLimit = BLOCK_REACH; name = nameOf(read(cell.x, cell.y, cell.z));
    distance = Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
  } else {
    const c = target.creature, h = c.height ?? 1.8, w = (c.width ?? 0.6) / 2;
    cell = { x: Math.floor(c.position.x), y: Math.floor(c.position.y + 1e-3), z: Math.floor(c.position.z) };
    point = [c.position.x, c.position.y + h * 0.5, c.position.z];
    reachLimit = HIT_REACH; name = `${c.name} #${c.id}`;
    // A blow reaches the nearest point of its box.
    const nx = Math.max(c.position.x - w, Math.min(eye[0], c.position.x + w)), ny = Math.max(c.position.y, Math.min(eye[1], c.position.y + h)), nz = Math.max(c.position.z - w, Math.min(eye[2], c.position.z + w));
    distance = Math.hypot(nx - eye[0], ny - eye[1], nz - eye[2]);
  }
  const between = solidBetween(read, eye, point).slice(0, 8).map(c => ({ at: c, name: nameOf(read(c.x, c.y, c.z)) }));
  const visible = between.length === 0, reach = distance <= reachLimit;
  const what = 'block' in target ? `${at(cell)} ${name}` : `${name} ${at(cell)}`;
  const text = `${what}：${visible ? '見える（間に固いブロックは無い）' : `見えない。間に固いブロック ${between.length}${between.length >= 8 ? ' 以上' : ''}：${between.slice(0, 4).map(b => `${at(b.at)} ${b.name}`).join('、')}${between.length > 4 ? ' ほか' : ''}`}。`
    + `目から ${round1(distance)}m（${reach ? '届く' : '届かない'}、${'block' in target ? `掘る・使う・置くは ${BLOCK_REACH}m まで` : '打てるのは 3m まで'}）`;
  return { v: 1, kind: 'sight', text, visible, reach, reachLimit, distance: round1(distance), between, target: { at: cell, name } };
}

// ===== column =====

export interface ColumnRun { top: number; bottom: number; name: string; n: number }
/**
 * r8 (run 32: respawned in stone at y=48, 860 s of bare-handed stairs up): in her own column, what is over her head up to the first open
 * cell: `solid` cells to dig, `openAt` the first y that is open (null: not within 64 or not loaded), `runs` the blocks in order with the
 * seconds one of each takes with the best tool carried (`each`, null when not known), `seconds` the sum. Facts only: the way is the planner's.
 */
export interface ColumnAbove { solid: number; openAt: number | null; opensTo: string; runs: Array<{ name: string; n: number; each: number | null }>; seconds: number | null; text: string }
export interface ColumnAnswer { v: 1; kind: 'column'; text: string; x: number; z: number; runs: ColumnRun[]; dangers: string[]; above?: ColumnAbove }
export const COLUMN_MAX = 96;
/** How far over the head the column is read for what has to be dug (the first open cell ends it). */
const ABOVE_SPAN = 64;

const columnLabel = (block: MapBlock | null) => {
  if (!block) return '未ロード';
  if (AIR.has(block.name)) return '空気';
  if (block.name === 'water') return (block.level ?? 0) === 0 ? '水' : '流れる水';
  if (block.name === 'lava') return (block.level ?? 0) === 0 ? '溶岩' : '流れる溶岩';
  return block.name;
};
const isAirLabel = (label: string) => label === '空気';

/**
 * column: one x,z column from yTo down to yFrom as runs of the same block ("y=40〜33 空気×8"), and the dangers first: a drop of more than
 * three (air over a floor, said from her feet when it is her column: "足の下 8 段は空気（落差 8）"), water and its depth, lava, and sand or
 * gravel (it falls when what is under it opens).
 */
export function probeColumn(read: BlockReader, x: number, z: number, yFrom: number, yTo: number, feet?: Cell | null,
  /** The milliseconds one block at (x, y, z) takes to break with the best tool carried (null: not known). */ digMs?: (x: number, y: number, z: number) => number | null): ColumnAnswer {
  let top = Math.max(yFrom, yTo), bottom = Math.min(yFrom, yTo);
  top = Math.min(319, top); bottom = Math.max(-64, bottom);
  if (top - bottom + 1 > COLUMN_MAX) bottom = top - COLUMN_MAX + 1;
  const runs: ColumnRun[] = [];
  for (let y = top; y >= bottom; y--) {
    const name = columnLabel(read(x, y, z));
    const last = runs[runs.length - 1];
    if (last && last.name === name) { last.bottom = y; last.n++; } else runs.push({ top: y, bottom: y, name, n: 1 });
  }
  const mine = !!feet && feet.x === x && feet.z === z;
  const span = (run: ColumnRun) => run.top === run.bottom ? `y=${run.top}` : `y=${run.top}〜${run.bottom}`;
  const floorOfRun = (index: number) => runs[index + 1]?.name ?? columnLabel(read(x, runs[index].bottom - 1, z));
  /**
   * An air run is a drop when something is under it and either something is over it (a hollow under a floor: S5's shaft that would open
   * into a cave) or it reaches below her feet (the far side of an edge). Open sky over the ground is not.
   */
  const isDrop = (index: number) => {
    const run = runs[index], floor = floorOfRun(index);
    if (floor === '空気' || floor === '未ロード') return false;
    const over = index > 0 ? runs[index - 1].name : columnLabel(read(x, run.top + 1, z));
    return (over !== '空気' && over !== '未ロード') || (!!feet && run.bottom < feet.y);
  };
  const dangers: string[] = [];
  // Her own drop first: the air under her feet.
  if (mine && feet!.y <= top && feet!.y - 1 >= bottom) {
    const fall = airBelow(read, x, feet!.y, z);
    if (fall.n > MAX_FALL) dangers.push(`足の下 ${fall.n} 段は空気（落差 ${fall.n}、底 y=${fall.bottomY} ${nameOf(fall.bottom)}）`);
  }
  runs.forEach((run, index) => {
    if (isAirLabel(run.name) && run.n > MAX_FALL && !(mine && feet!.y <= run.top && feet!.y >= run.bottom) && isDrop(index)) {
      // Her own run is said above (from her feet); a hollow under something, or air reaching below her feet, is a drop of its height.
      dangers.push(`${span(run)} 空気×${run.n}（落差 ${run.n}、底 y=${run.bottom - 1} ${floorOfRun(index)}）`);
    }
    if (run.name === '水' || run.name === '流れる水') dangers.push(`${span(run)} ${run.name}×${run.n}（水深 ${run.n}）`);
    if (run.name === '溶岩' || run.name === '流れる溶岩') dangers.push(`${span(run)} ${run.name}×${run.n}`);
    if (FALLING.test(run.name)) dangers.push(`${span(run)} ${run.name}×${run.n}（砂・砂利：下が空くと落ちる）${mine && run.top === feet!.y - 1 ? '。足元が砂・砂利' : ''}`);
  });
  /** An air run's drop: from her feet when the run holds them, else its height when there is a floor under it. */
  const runDrop = (run: ColumnRun, index: number): string => {
    if (!isAirLabel(run.name)) return '';
    if (mine && feet!.y <= run.top && feet!.y >= run.bottom) return feet!.y - run.bottom > MAX_FALL ? `（足 y=${feet!.y}・足の下 ${feet!.y - run.bottom} 段は空気）` : `（足 y=${feet!.y}）`;
    return run.n > MAX_FALL && isDrop(index) ? `（落差 ${run.n}）` : '';
  };
  const runText = runs.slice(0, 24).map((run, index) => `${span(run)} ${run.name}${run.n > 1 ? `×${run.n}` : ''}${runDrop(run, index)}`).join(' / ');
  const above = mine ? columnAbove(read, x, z, feet!.y + 2, digMs) : undefined;
  const text = `${dangers.length ? `危ない：${dangers.join('／')}。` : ''}${above ? `${above.text}。` : ''}列 (${x},${z}) y=${top}〜${bottom}${mine ? `（足 y=${feet!.y}）` : ''}：${runText}${runs.length > 24 ? ' …' : ''}`;
  return { v: 1, kind: 'column', text, x, z, runs, dangers, ...(above ? { above } : {}) };
}

/** What is over the head from `fromY` (the cell over the head) up to the first open cell, as exact numbers; undefined when the head is clear. */
function columnAbove(read: BlockReader, x: number, z: number, fromY: number, digMs?: (x: number, y: number, z: number) => number | null): ColumnAbove | undefined {
  const runs: Array<{ name: string; n: number; each: number | null }> = [];
  let solid = 0, openAt: number | null = null, opensTo = '', unloaded = false;
  for (let y = fromY; y < fromY + ABOVE_SPAN && y <= 319; y++) {
    const block = read(x, y, z);
    if (!block) { unloaded = true; break; }
    if (enterable(block)) { openAt = y; opensTo = AIR.has(block.name) ? '空気' : isWater(block) ? '水' : block.name; break; }
    const last = runs[runs.length - 1];
    if (last && last.name === block.name) last.n++;
    else {
      let each: number | null = null;
      try { const ms = digMs?.(x, y, z); each = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms / 100) / 10 : null; } catch { each = null; }
      runs.push({ name: block.name, n: 1, each });
    }
    solid++;
  }
  if (!solid) return undefined;
  const known = runs.every(run => run.each !== null);
  const seconds = known ? Math.round(runs.reduce((sum, run) => sum + run.n * run.each!, 0)) : null;
  const eachWords = runs.some(run => run.each !== null) ? `。今の持ち物で 1 段 ${runs.filter(run => run.each !== null).map(run => `${run.name} 約 ${run.each} 秒`).join('・')}${seconds !== null ? `（合わせて約 ${seconds} 秒）` : ''}` : '';
  const ends = openAt !== null ? `、y=${openAt} から${opensTo}` : unloaded ? '、その先は未ロード' : `、${ABOVE_SPAN} 段の先まで固い`;
  const text = `真上: 頭の上 y=${fromY}〜${fromY + solid - 1} の ${solid} 段が固い（${runs.map(run => `${run.name}×${run.n}`).join('・')}）${ends}${eachWords}`;
  return { solid, openAt, opensTo, runs, seconds, text };
}

// ===== around =====

export interface AroundCreature { id: number; name: string; at: Cell; dy: number; distance: number; hostile: boolean; visible: boolean; facing: boolean; closing: number | null }
/** `bottom` (r8): what a drop ends on: `lava`, `water`, or the floor's block name. */
export interface AroundDanger { kind: 'lava' | 'water' | 'drop' | 'fire'; at: Cell; distance: number; n?: number; bottom?: string }
/**
 * mb-llmc-cand (run 36: a placed water ran into the body's own passage and could not be taken back): the water round her, the sources
 * (level 0: a bucket fills at one, and only at one) apart from the flow (level 1-7, 8 and over: falling), the nearest three of each with
 * the facts of using it: the distance from the eye, whether it is within the hand's reach (BLOCK_REACH) and whether nothing solid lies on
 * the line from the eye (`visible`; `reach && visible` is a source she can fill a bucket at, or take her own water back from, now).
 */
export interface AroundWaterCell { at: Cell; distance: number; eye: number; level: number; reach: boolean; visible: boolean }
export interface AroundWater { sources: number; flowing: number; nearestSources: AroundWaterCell[]; nearestFlowing: AroundWaterCell[] }
export interface AroundAnswer {
  v: 1; kind: 'around'; text: string; radius: number; creatures: AroundCreature[]; dangers: AroundDanger[];
  /** Absent when no water lies within the radius. */
  water?: AroundWater;
  /**
   * r8 (run 32): the cells round the feet that fall three or more or end in lava (utils/voidFooting). Absent when there is none. `text` is the
   * line the answer's text begins with ("足場: 幅 1 の橋・左右とも空所（落差 28、下は溶岩）。押されたら落ちる"): the map shows no fall deeper than five.
   */
  footing?: { voids: number; deepest: number; lava: boolean; bridge: boolean; pillar: boolean; text: string };
}
export interface AroundEntity { id: number; name: string; position: { x: number; y: number; z: number }; yaw?: number; headYaw?: number; height?: number; hostile: boolean; closing?: number | null }

/** Whether a creature's face points at `to` within 30 degrees (mineflayer's yaw: 0 looks north, -z; turning left grows it). */
function facesToward(entity: AroundEntity, to: { x: number; z: number }): boolean {
  const yaw = typeof entity.headYaw === 'number' ? entity.headYaw : entity.yaw;
  if (typeof yaw !== 'number') return false;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const vx = to.x - entity.position.x, vz = to.z - entity.position.z, len = Math.hypot(vx, vz);
  if (len < 0.1) return true;
  return (fx * vx + fz * vz) / len >= Math.cos(Math.PI / 6);
}

/** around: the creatures within `radius` (nearest first) and the dangerous blocks round her: lava, fire, water, and the edges she would drop more than three from. */
export function probeAround(read: BlockReader, position: { x: number; y: number; z: number }, entities: AroundEntity[], radius: number): AroundAnswer {
  const r = Math.max(1, Math.min(16, Math.round(radius)));
  const feet: Cell = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
  const eye: [number, number, number] = [position.x, position.y + 1.62, position.z];
  const creatures = entities.map(entity => ({ entity, d: Math.hypot(entity.position.x - position.x, entity.position.y - position.y, entity.position.z - position.z) }))
    .filter(entry => entry.d <= r).sort((a, b) => a.d - b.d).slice(0, 12).map(({ entity, d }) => {
      const cell = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y + 1e-3), z: Math.floor(entity.position.z) };
      const visible = solidBetween(read, eye, [entity.position.x, entity.position.y + (entity.height ?? 1.8) * 0.85, entity.position.z]).length === 0;
      return { id: entity.id, name: entity.name, at: cell, dy: cell.y - feet.y, distance: round1(d), hostile: entity.hostile, visible,
        facing: facesToward(entity, position), closing: typeof entity.closing === 'number' ? round1(entity.closing) : null };
    });
  // The blocks: lava and fire within r (±4 up and down), water, and the edges of a drop near her (within 6 on her level).
  const found: AroundDanger[] = [];
  let lava = 0, water = 0, fire = 0;
  const nearest: Partial<Record<'lava' | 'water' | 'fire', AroundDanger>> = {};
  const waterCells: AroundWaterCell[] = [];
  let sourceCount = 0, flowCount = 0;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -4; dy <= 4; dy++) {
    const x = feet.x + dx, y = feet.y + dy, z = feet.z + dz;
    const block = read(x, y, z);
    if (!block) continue;
    const kind = isLava(block) ? 'lava' : block.name === 'fire' || block.name === 'soul_fire' ? 'fire' : block.name === 'water' ? 'water' : null;
    if (!kind) continue;
    const distance = round1(Math.hypot(x + 0.5 - position.x, y - position.y, z + 0.5 - position.z));
    if (distance > r) continue;
    if (kind === 'water') {
      const level = Number(block.level ?? 0);
      const eyeDistance = Math.hypot(x + 0.5 - eye[0], y + 0.5 - eye[1], z + 0.5 - eye[2]);
      if (level === 0) sourceCount++; else flowCount++;
      waterCells.push({ at: { x, y, z }, distance, eye: round1(eyeDistance), level, reach: eyeDistance <= BLOCK_REACH, visible: true });
    }
    if (kind === 'lava') lava++; else if (kind === 'water') water++; else fire++;
    if (!nearest[kind] || nearest[kind]!.distance > distance) nearest[kind] = { kind, at: { x, y, z }, distance };
  }
  if (nearest.lava) found.push({ ...nearest.lava, n: lava });
  if (nearest.fire) found.push({ ...nearest.fire, n: fire });
  const drops: AroundDanger[] = [];
  const reach = Math.min(r, 6);
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
    const x = feet.x + dx, z = feet.z + dz;
    if (!enterable(read(x, feet.y, z)) || !enterable(read(x, feet.y + 1, z)) || isWater(read(x, feet.y, z))) continue;
    if (standable(read, x, feet.y, z)) continue;
    // An open cell on her level with no floor, beside a cell she could stand in: an edge.
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => standable(read, x + ax, feet.y, z + az))) continue;
    const fall = airBelow(read, x, feet.y, z);
    if (fall.n <= MAX_FALL || isWater(fall.bottom)) continue;
    drops.push({ kind: 'drop', at: { x, y: feet.y, z }, distance: round1(Math.hypot(x + 0.5 - position.x, z + 0.5 - position.z)), n: fall.n,
      bottom: fall.bottom ? (isLava(fall.bottom) ? 'lava' : isWater(fall.bottom) ? 'water' : fall.bottom.name) : '未ロード' });
  }
  drops.sort((a, b) => a.distance - b.distance);
  found.push(...drops.slice(0, 3));
  if (nearest.water) found.push({ ...nearest.water, n: water });
  found.sort((a, b) => (a.kind === 'water' ? 1 : 0) - (b.kind === 'water' ? 1 : 0) || a.distance - b.distance);
  const dangers = found.slice(0, 8);
  const nearestWater = (cells: AroundWaterCell[]): AroundWaterCell[] => cells.sort((a, b) => a.eye - b.eye).slice(0, 3)
    .map(cell => ({ ...cell, visible: solidBetween(read, eye, [cell.at.x + 0.5, cell.at.y + 0.5, cell.at.z + 0.5]).length === 0 }));
  const waterFacts: AroundWater | undefined = waterCells.length ? { sources: sourceCount, flowing: flowCount,
    nearestSources: nearestWater(waterCells.filter(cell => cell.level === 0)), nearestFlowing: nearestWater(waterCells.filter(cell => cell.level !== 0)) } : undefined;
  const waterItem = (cell: AroundWaterCell) => `${at(cell.at)} ${wayWords(position, cell.at)} 目から ${cell.eye}m${cell.reach ? '・届く' : '・届かない'}${cell.visible ? '・見える' : '・間に壁'}`
    + (cell.level === 0 ? '' : cell.level >= 8 ? '・下へ落ちる流れ' : `・流れ ${cell.level}`);
  const waterBreakdown = waterFacts
    ? `水の内訳：源 ${waterFacts.sources} マス${waterFacts.nearestSources.length ? `（近い順 ${waterFacts.nearestSources.map(waterItem).join('／')}）` : ''}、流れ ${waterFacts.flowing} マス${waterFacts.nearestFlowing.length ? `（近い順 ${waterFacts.nearestFlowing.map(waterItem).join('／')}）` : ''}。` : '';
  const words = (danger: AroundDanger) => danger.kind === 'lava' ? `溶岩 ${at(danger.at)} ${wayWords(position, danger.at)}（${danger.n} マス）`
    : danger.kind === 'fire' ? `火 ${at(danger.at)} ${wayWords(position, danger.at)}`
    : danger.kind === 'drop' ? `${at(danger.at)} ${wayWords(position, danger.at)} は下 ${danger.n} 段が空気（落差 ${danger.n}${danger.bottom === 'lava' ? '、底は溶岩' : ''}）`
    : `水 ${at(danger.at)} ${wayWords(position, danger.at)}（${danger.n} マス）`;
  const creatureWords = (c: AroundCreature) => `${c.name} #${c.id}${c.hostile ? '（敵）' : ''} ${wayWords(position, c.at)} ${c.visible ? '見える' : '間に壁'}`
    + `${c.facing ? (c.closing !== null && c.closing >= 0.3 ? `・こちらを向いて近づく ${c.closing}m/s` : '・こちらを向いている') : c.closing !== null && c.closing >= 0.3 ? `・近づく ${c.closing}m/s` : ''}`;
  const hostile = creatures.filter(c => c.hostile);
  // r8: the footing under her, first: what a push from a creature beside her would drop her from (the map shows no fall deeper than five).
  const rim = footingAt(read, feet);
  const footing = rim.count ? { voids: rim.count, deepest: rim.deepest, lava: rim.lava, bridge: rim.bridge, pillar: rim.pillar, text: `足場: ${footingWords(rim)}。押されたら落ちる` } : undefined;
  const text = [
    footing ? `${footing.text}。` : '',
    dangers.some(d => d.kind !== 'water') ? `危ない：${dangers.filter(d => d.kind !== 'water').map(words).join('／')}。` : '',
    creatures.length ? `${r}m 内の生き物 ${creatures.length}（敵 ${hostile.length}）：${creatures.slice(0, 8).map(creatureWords).join('／')}。` : `${r}m 内に生き物は無い。`,
    // `nearest.water` has no count (the copy with `n` is the one pushed to `found`): its words ended "（undefined マス）" (inspection s44).
    nearest.water ? words({ ...nearest.water, n: water }) + (waterBreakdown ? '。' : '') : '',
    waterBreakdown,
  ].join('');
  return { v: 1, kind: 'around', text, radius: r, creatures, dangers, ...(footing ? { footing } : {}), ...(waterFacts ? { water: waterFacts } : {}) };
}

// ===== history =====

export interface HistoryAnswer { v: 1; kind: 'history'; text: string; at: Cell; radius: number; entries: Array<{ ago: number; do: string; status: string; line: string; at: Cell }> }
const STATUS_WORDS: Record<string, string> = { done: '済', failed: '失', stopped: '止' };

/** history: the hands of the acts at or from a place, newest first (at most ten). */
export function probeHistory(records: HandRecord[], place: Cell, radius: number, now = Date.now()): HistoryAnswer {
  const entries = records.slice(0, 10).map(record => ({ ago: Math.max(0, Math.round((now - record.t) / 1000)), do: record.do, status: record.status, line: record.line, at: record.at }));
  const stops = entries.filter(entry => entry.status !== 'done').length;
  const text = entries.length
    ? `${at(place)} の ${radius}m 内の最近の手 ${entries.length}（止まり・失敗 ${stops}、新しい順）：${entries.map(entry => `${entry.ago}秒前 ${entry.do} ${STATUS_WORDS[entry.status] ?? entry.status} ${at(entry.at)} ${entry.line}`).join('／')}`
    : `${at(place)} の ${radius}m 内に、この接続で記録した手は無い`;
  return { v: 1, kind: 'history', text: text.length <= 3000 ? text : `${text.slice(0, 2999)}…`, at: place, radius, entries };
}
