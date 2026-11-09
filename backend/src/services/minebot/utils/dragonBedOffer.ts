import { blastAt } from './crystalBlast.js';
import { bedCanReplace, bedCellSupported, bedDamage, bedExposure, supportedBedCells, type BedBlockReader } from './dragonBedGeometry.js';
import { boxesOverlap, inflate, partBox, type P3 } from './dragonParts.js';
import { BLOCK_USE_REACH } from './blockInteractionReach.js';

/**
 * Where a bed could be set and used against a SITTING dragon, for the head to choose (11/9, end lane): e01 never set a bed, because the only
 * guidance was "use at=[the bed's cell]" and the head had to work out the cell, the stance and the shielding from geometry by itself.
 * The body only offers: the stance (feet on footing the caller already proved walkable and clear of the perch), the cells to build from that
 * stance (support under the bed's foot, a screen when the support alone does not shield), the bed's two halves and both estimates.
 * It never builds, places or uses anything by itself. Every hand rechecks (the use hand refuses a blast it judges unsafe).
 */
export interface DragonBedOffer {
  stand: P3; walkMeters: number;
  /** The cell to click with the bed (its foot); the pillow follows the body's facing from `stand`, into `head`. */
  foot: P3; head: P3;
  /** Bottom first, all within reach of `stand`'s eye. support: any solid block; screen: obsidian (a bed's blast breaks cobblestone). */
  build: Array<P3 & { role: 'support' | 'screen' }>;
  /** The body's expected harm (after its armour, the worse of the two halves) and the dragon's head (before the part rule, the head takes it whole). */
  selfExpected: number; dragonExpected: number;
}
type Stand = { feet: P3; walkMeters: number };
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const centre = (p: P3): P3 => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
const cube = (name: string) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const CARDINALS = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
/** The use hand's own line (knowledge): only a blast expected at 4 or less is used in the End. A bed that does not take a fifth of a sword's worth is not offered. */
const ESTIMATES_PER_STAND = 4, SELF_MAX = 4, DRAGON_MIN = 20, MAX_SUPPORT = 4, MAX_SCREEN = 3, REACH = BLOCK_USE_REACH - 0.25;

/** Bounded: stops at `deadline` with what it has. `bot` gives health, difficulty and armour to the blast estimate; `read` the loaded cells. */
export function dragonBedOffers(bot: any, dragon: { position: P3; yaw?: number }, stands: Stand[], read: BedBlockReader, deadline: number,
  now = () => performance.now()): DragonBedOffer[] {
  const head = partBox(dragon, 'head'), headFeet = { x: (head.minX + head.maxX) / 2, y: head.minY, z: (head.minZ + head.maxZ) / 2 };
  const parts = (['head', 'neck', 'body', 'wing1', 'wing2'] as const).map(part => inflate(partBox(dragon, part), 0.05));
  // The dragon's own (main) box is 16 wide and 8 tall from its feet: the server refuses a block in it. Its parts too, to be safe.
  const main = { minX: dragon.position.x - 8, maxX: dragon.position.x + 8, minY: dragon.position.y, maxY: dragon.position.y + 8, minZ: dragon.position.z - 8, maxZ: dragon.position.z + 8 };
  const cellBox = (p: P3) => ({ minX: p.x, minY: p.y, minZ: p.z, maxX: p.x + 1, maxY: p.y + 1, maxZ: p.z + 1 });
  const free = (p: P3) => bedCanReplace(read(p)) && !boxesOverlap(cellBox(p), main) && !parts.some(box => boxesOverlap(cellBox(p), box));
  // Pillows near the head, down to the floor under it (a bed on the floor needs nothing built): the blast must still reach the head (DRAGON_MIN below).
  const pillows: P3[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, -2, -3, -4]) {
    const p = { x: Math.floor(headFeet.x) + dx, y: Math.floor(head.minY) + dy, z: Math.floor(headFeet.z) + dz };
    if (Math.hypot(p.x + 0.5 - headFeet.x, p.y + 0.5 - headFeet.y, p.z + 0.5 - headFeet.z) <= 4.5 && free(p)) pillows.push(p);
  }
  const armour = bot?.inventory, offers: DragonBedOffer[] = [];
  for (const { feet, walkMeters } of stands) {
    if (now() >= deadline) break;
    const eye = { ...feet, y: feet.y + 1.62 }, own = [0, 1].map(dy => key({ x: Math.floor(feet.x), y: Math.floor(feet.y) + dy, z: Math.floor(feet.z) }));
    let best: DragonBedOffer | null = null;
    // Geometry first (cheap), then the blast estimates only for the few most promising: a supported foot before a built one, the pillow nearest the head first.
    const shapes: Array<{ pillow: P3; foot: P3; f: P3; rank: number }> = [];
    for (const pillow of pillows) {
      for (const s of CARDINALS) {
        // The pillow lies where the body faces when it clicks the foot: the foot is on the stance's side of the pillow, the stance in line within 30 degrees.
        const foot = { x: pillow.x + s.x, y: pillow.y, z: pillow.z + s.z }, f = centre(foot);
        const along = (eye.x - f.x) * s.x + (eye.z - f.z) * s.z, across = Math.abs((eye.x - f.x) * s.z - (eye.z - f.z) * s.x);
        if (along < 1.2 || across > along * 0.58 || Math.hypot(eye.x - f.x, eye.y - f.y, eye.z - f.z) > REACH || !free(foot) || own.includes(key(foot)) || own.includes(key(pillow))) continue;
        const c = centre(pillow);
        shapes.push({ pillow, foot, f, rank: (bedCellSupported(read, foot) ? 0 : 100) + Math.hypot(c.x - headFeet.x, c.y - headFeet.y, c.z - headFeet.z) });
      }
    }
    shapes.sort((a, b) => a.rank - b.rank);
    for (const { pillow, foot, f } of shapes.slice(0, ESTIMATES_PER_STAND)) {
      if (now() >= deadline) break;
      {
        const planned = new Map<string, P3 & { role: 'support' | 'screen' }>();
        const projected: BedBlockReader = p => planned.has(key(p)) ? cube(planned.get(key(p))!.role === 'screen' ? 'obsidian' : 'cobblestone') as any : read(p);
        if (!bedCellSupported(projected, foot)) {
          const column = supportedBedCells([{ ...foot, y: foot.y - 1 }], read, MAX_SUPPORT);
          if (!column || column.length > MAX_SUPPORT) continue;
          for (const p of column) planned.set(key(p), { ...p, role: 'support' });
        }
        const estimate = () => {
          const shadow = { blockAt: (p: P3) => projected({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }), health: bot?.health ?? 20,
            game: bot?.game ?? { difficulty: 'normal' }, inventory: armour };
          const blasts = [pillow, foot].map(p => blastAt(shadow, centre(p), feet, 5, [pillow, foot]));
          const c = centre(pillow), dist = Math.hypot(c.x - headFeet.x, c.y - headFeet.y, c.z - headFeet.z), self = Math.max(...blasts.map(b => b.expected));
          // The use hand's own two tests: at most 4 in the End, and its margin under the present health.
          return { self, ok: self <= SELF_MAX && blasts.every(b => b.safe), dragon: bedDamage(dist, bedExposure(projected, c, head, [pillow, foot])) };
        };
        let e = estimate();
        if (!e.ok) {
          // A screen in the stance's next cell toward the bed, from the feet up: the smallest column that brings the harm to 4 or less.
          const step = Math.abs(f.x - feet.x) >= Math.abs(f.z - feet.z) ? { x: Math.sign(f.x - feet.x), z: 0 } : { x: 0, z: Math.sign(f.z - feet.z) };
          const base = { x: Math.floor(feet.x) + step.x, y: Math.floor(feet.y), z: Math.floor(feet.z) + step.z };
          for (let h = 1; h <= MAX_SCREEN && !e.ok; h++) {
            const p = { ...base, y: base.y + h - 1 };
            if ([key(foot), key(pillow), ...own].includes(key(p)) || planned.has(key(p)) || !free(p)) break;
            planned.set(key(p), { ...p, role: 'screen' });
            e = estimate();
          }
        }
        if (!e.ok || !(e.dragon >= DRAGON_MIN)) continue;
        const build = [...planned.values()].sort((a, b) => a.y - b.y);
        if (build.some(p => Math.hypot(eye.x - p.x - 0.5, eye.y - p.y - 0.5, eye.z - p.z - 0.5) > REACH)) continue;
        const offer = { stand: feet, walkMeters, foot, head: pillow, build, selfExpected: e.self, dragonExpected: Math.round(e.dragon * 10) / 10 };
        if (!best || offer.build.length < best.build.length || (offer.build.length === best.build.length && offer.dragonExpected > best.dragonExpected)) best = offer;
      }
    }
    if (best) offers.push(best);
    if (offers.length === 2) break;
  }
  return offers;
}
