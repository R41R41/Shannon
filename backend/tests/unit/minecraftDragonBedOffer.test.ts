import { describe, expect, it } from 'vitest';
import { dragonBedOffers } from '../../src/services/minebot/utils/dragonBedOffer.js';
import { blastAt } from '../../src/services/minebot/utils/crystalBlast.js';
import { boxesOverlap, partBox } from '../../src/services/minebot/utils/dragonParts.js';

const solid = (name: string) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const IRON = { slots: { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' }, 8: { name: 'iron_boots' } } };

/** Island ground below y 64 (feet at 64), the perch 4 up, as the nook fixture observes it. */
function fixture(dx = 0, dy = 0, dz = 0, yaw = 0) {
  const blocks = new Map<string, any>(), key = (p: any) => `${p.x},${p.y},${p.z}`;
  const dragon = { position: { x: dx + 0.5, y: dy + 68, z: dz + 0.5 }, yaw };
  const read = (p: any) => blocks.get(key(p)) ?? (p.y < dy + 64 ? solid('end_stone') : { name: 'air', boundingBox: 'empty', shapes: [] });
  const head = partBox(dragon, 'head'), hx = (head.minX + head.maxX) / 2, hz = (head.minZ + head.maxZ) / 2;
  const stands = [] as Array<{ feet: any; walkMeters: number }>;
  for (let x = Math.floor(hx) - 7; x <= Math.floor(hx) + 7; x++) for (let z = Math.floor(hz) - 7; z <= Math.floor(hz) + 7; z++) {
    const feet = { x: x + 0.5, y: dy + 64, z: z + 0.5 }, d = Math.hypot(feet.x - hx, feet.z - hz);
    if (d >= 2 && d <= 7) stands.push({ feet, walkMeters: d });
  }
  stands.sort((a, b) => a.walkMeters - b.walkMeters);
  const bot = { blockAt: read, health: 20, game: { difficulty: 'normal' }, inventory: IRON };
  return { dragon, read, stands, bot, blocks, key, head };
}

describe('bed offers against a sitting dragon', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7])('offers a reachable, shielded bed at yaw %s', yaw => {
    const f = fixture(110, 6, -31, yaw), offers = dragonBedOffers(f.bot, f.dragon, f.stands, f.read, Infinity);
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      const eye = { ...o.stand, y: o.stand.y + 1.62 };
      for (const p of [o.foot, ...o.build]) expect(Math.hypot(eye.x - p.x - 0.5, eye.y - p.y - 0.5, eye.z - p.z - 0.5)).toBeLessThanOrEqual(4.25);
      // The pillow is the foot's neighbour away from the stance (the body faces it when clicking the foot).
      expect(Math.abs(o.head.x - o.foot.x) + Math.abs(o.head.z - o.foot.z)).toBe(1); expect(o.head.y).toBe(o.foot.y);
      expect(Math.hypot(o.head.x - o.stand.x, o.head.z - o.stand.z)).toBeGreaterThan(Math.hypot(o.foot.x - o.stand.x, o.foot.z - o.stand.z));
      expect(o.selfExpected).toBeLessThanOrEqual(4); expect(o.dragonExpected).toBeGreaterThanOrEqual(20);
      expect(o.build.filter(c => c.role === 'support').length).toBeLessThanOrEqual(4);
      expect(o.build.filter(c => c.role === 'screen').length).toBeLessThanOrEqual(3);
      // Building it for real gives the same self estimate (the projection matches the world the hands would make).
      for (const c of o.build) f.blocks.set(f.key(c), solid(c.role === 'screen' ? 'obsidian' : 'cobblestone'));
      for (const half of [o.foot, o.head]) {
        expect(blastAt(f.bot, { x: half.x + 0.5, y: half.y + 0.5, z: half.z + 0.5 }, o.stand, 5, [o.foot, o.head]).expected).toBeLessThanOrEqual(4);
        expect(boxesOverlap({ minX: half.x, minY: half.y, minZ: half.z, maxX: half.x + 1, maxY: half.y + 1, maxZ: half.z + 1 }, f.head)).toBe(false);
      }
      for (const c of o.build) f.blocks.delete(f.key(c));
    }
  });

  it('carries no world coordinates: the same offer moves with the island', () => {
    const a = fixture(0, 0, 0, 0.3), b = fixture(123, 13, -211, 0.3);
    const oa = dragonBedOffers(a.bot, a.dragon, a.stands, a.read, Infinity)[0], ob = dragonBedOffers(b.bot, b.dragon, b.stands, b.read, Infinity)[0];
    expect(ob.foot).toEqual({ x: oa.foot.x + 123, y: oa.foot.y + 13, z: oa.foot.z - 211 });
    expect(ob.selfExpected).toBeCloseTo(oa.selfExpected, 5);
  });

  it('offers nothing without armour room to spare, from no stance, or past the deadline', () => {
    const f = fixture();
    expect(dragonBedOffers({ ...f.bot, health: 3 }, f.dragon, f.stands, f.read, Infinity)).toEqual([]);
    expect(dragonBedOffers(f.bot, f.dragon, [], f.read, Infinity)).toEqual([]);
    expect(dragonBedOffers(f.bot, f.dragon, f.stands, f.read, 0, () => 1)).toEqual([]);
  });
});
