import { Vec3 } from 'vec3';
import { bodyReader, type BlockReader, type Cell } from './localMap.js';
import { feetCentre, inland, standing, walkGround } from './dragonWalk.js';
import type { P3 } from './dragonParts.js';
import { blockInSight, eyeOf } from './probeTools.js';

/** Read-only geometry formerly inline in cage_section. No target choice or motor calls. */
export function cageRoots(bot: any, crystal: P3, wall?: P3): Cell[] {
  const ground = walkGround(bot, { deadline: performance.now() + 150, radius: 112, maxCells: 16000 });
  return ground.cells.filter(n => {
    const p = feetCentre(n.cell), horizontal = Math.hypot(p.x - crystal.x, p.z - crystal.z);
    if (horizontal < 3 || horizontal > 4.5) return false;
    if (wall && Math.hypot(p.x - wall.x - 0.5, p.z - wall.z - 0.5) > 3.5) return false;
    for (let y = n.cell.y; y < Math.floor(crystal.y); y++) {
      const b = ground.read(n.cell.x, y, n.cell.z);
      if (!b || !/^(air|cave_air|void_air)$/u.test(b.name)) return false;
    }
    return true;
  }).sort((a, b) => a.walkMeters - b.walkMeters).map(n => n.cell);
}
export function cageWall(bot: any, crystal: P3, preferred?: P3): P3[] {
  const eyes = bot.entity.position.offset(0, 1.62, 0), bars: P3[] = [];
  const cx = Math.floor(crystal.x), cy = Math.floor(crystal.y), cz = Math.floor(crystal.z);
  for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) for (let y = cy; y <= cy + 2; y++) {
    const p = new Vec3(x, y, z);
    if (bot.blockAt(p)?.name === 'iron_bars' && eyes.distanceTo(p.offset(0.5, 0.5, 0.5)) <= 4.2) bars.push({ x, y, z });
  }
  bars.sort((a, b) => Math.hypot(a.x + 0.5 - eyes.x, a.y + 0.5 - eyes.y, a.z + 0.5 - eyes.z) - Math.hypot(b.x + 0.5 - eyes.x, b.y + 0.5 - eyes.y, b.z + 0.5 - eyes.z));
  // An observed ballistic blocker can be BEHIND another bar (r136). Offer an exposed column, as dig requires.
  const visible = (p: P3) => blockInSight(bodyReader(bot), eyeOf(bot.entity.position), p).visible;
  const first = (preferred && bars.find(p => p.x === preferred.x && p.z === preferred.z && visible(p))) || bars.find(visible);
  return bars.filter(p => p.x === first?.x && p.z === first?.z);
}

/** Existing full blocks already guard/support the ring. Unknown/liquid/thin occupied cells are not build offers. */
export function cageGuardWork(bot: any, cells: readonly P3[]): P3[] | null {
  const read = bodyReader(bot), work: P3[] = [];
  for (const p of cells) {
    const b = read(p.x, p.y, p.z);
    if (!b) return null;
    if (b.solid === true && /^(cobblestone|end_stone|obsidian|bedrock)$/u.test(b.name)) continue;
    if (!/^(air|cave_air|void_air)$/u.test(b.name)) return null;
    work.push(p);
  }
  return work;
}
export function cageGuardCells(position: P3, wall: readonly P3[]): { ring: P3[]; close: P3[]; feet: Cell; toward: number[] } {
  const f = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const toward = Math.abs(wall[0].x - f.x) >= Math.abs(wall[0].z - f.z) ? [Math.sign(wall[0].x - f.x), 0] : [0, Math.sign(wall[0].z - f.z)];
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const ring = sides.map(([a, b]) => ({ x: f.x + a, y: f.y - 1, z: f.z + b }));
  for (const dy of [0, 1]) for (const [a, b] of sides) if (!(a === toward[0] && b === toward[1])) ring.push({ x: f.x + a, y: f.y + dy, z: f.z + b });
  return { ring, close: [0, 1].map(dy => ({ x: f.x + toward[0], y: f.y + dy, z: f.z + toward[1] })), feet: f, toward };
}

const cageAir = (read: BlockReader, p: P3) => /^(air|cave_air|void_air)$/u.test(read(p.x, p.y, p.z)?.name ?? '');
const cageFloor = (read: BlockReader, p: P3) => {
  const b = read(p.x, p.y - 1, p.z);
  return b?.solid === true && (b.top === undefined || b.top === 1) && /^(end_stone|cobblestone|obsidian)$/u.test(b.name);
};
/** A one-cell, cardinal drop immediately beside the built column. Reads only: no landing/route choice or bucket I/O.
 * Offer a one-block-deep pocket: an uncontained source spreads into the root and vertical(liquid:stop) refuses ascent.
 * Digging this one natural cell and pouring into it are explicit HEAD hands before ascent. Unknown cells close the offer. */
export function cageWaterLandings(bot: any, root: P3, top: number): Cell[] {
  const read = bodyReader(bot), found: Cell[] = [];
  if (!Number.isInteger(top) || top - root.y < 3 || top - root.y > 64) return found;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const source = { x: Math.floor(root.x) + dx, y: Math.floor(root.y) - 1, z: Math.floor(root.z) + dz };
    if (read(source.x, source.y, source.z)?.name !== 'end_stone' || !cageFloor(read, source) || !inland(read, { ...source, y: root.y })) continue;
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => cageFloor(read, { x: source.x + a, y: source.y + 1, z: source.z + b }))) continue;
    let clear = true;
    for (let y = source.y + 1; y <= top + 1; y++) if (!cageAir(read, { ...source, y })) { clear = false; break; }
    if (clear) found.push(source);
  }
  return found;
}
export const cageWaterSource = (bot: any, source: P3): boolean => {
  const b = bodyReader(bot)(source.x, source.y, source.z);
  return b?.name === 'water' && b.level === 0;
};
/** Recheck the SAME prepared water and its floor. Only the top ring's three removable cobblestones may obstruct it.
 * Deeper guards, bars, unknown terrain or an occupied falling column forbid the drop. */
export function cageWaterExit(bot: any, root: P3, source: P3, top: number): Cell[] | null {
  if (Math.abs(root.x - source.x) + Math.abs(root.z - source.z) !== 1 || source.y !== root.y - 1 || !cageWaterSource(bot, source)) return null;
  const read = bodyReader(bot), remove: Cell[] = [];
  if (!cageFloor(read, source)) return null;
  for (let y = source.y + 1; y <= top + 1; y++) {
    const p = { ...source, y }, b = read(p.x, p.y, p.z);
    if (cageAir(read, p)) continue;
    if (y >= top - 1 && b?.name === 'cobblestone') remove.push(p);
    else return null;
  }
  return remove.reverse(); // expose the lower blocks by digging from above
}
/** Landing/scoop proof independent of onGround (water can clear that flag): full support <=0.35 below feet.
 * No water-supported floating body, void, slab or different source is accepted as a dry footing. */
export function cageDryFooting(bot: any): boolean {
  const p = bot.entity?.position;
  if (!p || Math.abs(p.y - Math.round(p.y)) > 0.35) return false;
  return cageFloor(bodyReader(bot), { x: Math.floor(p.x), y: Math.round(p.y), z: Math.floor(p.z) });
}
/** Dry, full supported neighbours one step out of the prepared pocket; the built pillar is occupied and is excluded. */
export function cagePoolExits(bot: any, source: P3): Cell[] {
  const read = bodyReader(bot);
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: source.x + dx, y: source.y + 1, z: source.z + dz }))
    .filter(p => standing(read, p));
}
/** Ground-only shadow offers: reachable supported cells on the far side of the observed tower from the dragon,
 * with real obsidian intersecting its eye ray. The HEAD may choose one; go owns the route. */
export function cageShadowFootings(bot: any, dragon: P3, tower: P3): P3[] {
  const walk = walkGround(bot, { deadline: performance.now() + 50, radius: 16, maxCells: 900 });
  return walk.cells.filter(n => {
    const p = feetCentre(n.cell);
    if ((p.x - tower.x) * (dragon.x - tower.x) + (p.z - tower.z) * (dragon.z - tower.z) >= 0) return false;
    const length = Math.hypot(dragon.x - p.x, dragon.z - p.z), steps = Math.min(64, Math.ceil(length / 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i * 0.5 / length; // bounded 32 m ray: the tower is within the walk's 16 m radius + root offset
      if (walk.read(Math.floor(p.x + (dragon.x - p.x) * t), Math.floor(p.y + 1.62 + (dragon.y - p.y - 1.62) * t),
        Math.floor(p.z + (dragon.z - p.z) * t))?.name === 'obsidian') return true;
    }
    return false;
  }).sort((a, b) => a.walkMeters - b.walkMeters).map(n => feetCentre(n.cell));
}

/** Read-only recovery offers, after landing. Walks use full support and <=1 m steps; no invented drop or obsidian shaft.
 * A shaft offer has a continuous cobblestone column onto natural island ground. go/vertical recheck it at execution. */
export function cageRecoveryFootings(bot: any): Array<{ at: P3; ground: P3; kind: 'ground' | 'shaft' }> {
  if (!bot.entity?.onGround) return [];
  const walk = walkGround(bot, { deadline: performance.now() + 100, radius: 16, maxCells: 1200 });
  const found: Array<{ at: P3; ground: P3; kind: 'ground' | 'shaft'; meters: number }> = [];
  for (const n of walk.cells) {
    const { x, y, z } = n.cell, at = feetCentre(n.cell);
    let bottom = y;
    while (bottom > Math.max(1, y - 64) && walk.read(x, bottom - 1, z)?.name === 'cobblestone') bottom--;
    const ground = { x, y: bottom, z };
    if (walk.read(x, bottom - 1, z)?.name !== 'end_stone' || !inland(walk.read, ground)) continue;
    found.push({ at, ground: feetCentre(ground), kind: bottom === y ? 'ground' : 'shaft', meters: n.walkMeters });
  }
  return found.sort((a, b) => a.meters - b.meters).map(({ meters: _meters, ...p }) => p);
}

/** Loaded natural island footings, independent of the End seed and arrival coordinates. The planner selects a destination.
 * Unlike walkGround this can see across the arrival gap; only go may prove/build a route to the offered footing. */
export function islandFootings(bot: any, toward: P3, radius = 80): P3[] {
  const at = bot.entity.position, read = bodyReader(bot), found: P3[] = [];
  const deadline = performance.now() + 100;
  const dxTarget = toward.x - at.x, dzTarget = toward.z - at.z, distance = Math.hypot(dxTarget, dzTarget);
  const scale = distance ? Math.min(1, radius / 2 / distance) : 0;
  const centre = { x: Math.floor(at.x + dxTarget * scale), z: Math.floor(at.z + dzTarget * scale) };
  const sorted = () => found.sort((a, b) => Math.hypot(a.x - toward.x, a.z - toward.z) - Math.hypot(b.x - toward.x, b.z - toward.z));
  // Near rings first; bounded reads even if the host clock is frozen in a test.
  for (let r = 0; r <= radius; r += 2) for (let dx = -r; dx <= r; dx += 2) for (let dz = -r; dz <= r; dz += 2) {
    if (r && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
    if (performance.now() >= deadline) return sorted();
    const x = centre.x + dx, z = centre.z + dz;
    if (Math.hypot(x + 0.5 - at.x, z + 0.5 - at.z) > radius) continue;
    for (let y = Math.min(160, Math.floor(at.y) + 24); y >= Math.max(1, Math.floor(at.y) - 16); y--) {
      const cell = { x, y, z };
      if (read(x, y - 1, z)?.name === 'end_stone' && standing(read, cell) && inland(read, cell)) { found.push(feetCentre(cell)); break; }
    }
    if (found.length >= 32) return sorted();
  }
  return sorted();
}
