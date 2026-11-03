import { Vec3 } from 'vec3';
import { bodyReader, type Cell } from './localMap.js';
import { feetCentre, inland, standing, walkGround } from './dragonWalk.js';
import type { P3 } from './dragonParts.js';

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
  const first = (preferred && bars.find(p => p.x === preferred.x && p.z === preferred.z)) || bars[0];
  return bars.filter(p => p.x === first?.x && p.z === first?.z);
}
export function cageGuardCells(position: P3, wall: readonly P3[]): { ring: P3[]; close: P3[]; feet: Cell; toward: number[] } {
  const f = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const toward = Math.abs(wall[0].x - f.x) >= Math.abs(wall[0].z - f.z) ? [Math.sign(wall[0].x - f.x), 0] : [0, Math.sign(wall[0].z - f.z)];
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const ring = sides.map(([a, b]) => ({ x: f.x + a, y: f.y - 1, z: f.z + b }));
  for (const dy of [0, 1]) for (const [a, b] of sides) if (!(a === toward[0] && b === toward[1])) ring.push({ x: f.x + a, y: f.y + dy, z: f.z + b });
  return { ring, close: [0, 1].map(dy => ({ x: f.x + toward[0], y: f.y + dy, z: f.z + toward[1] })), feet: f, toward };
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
