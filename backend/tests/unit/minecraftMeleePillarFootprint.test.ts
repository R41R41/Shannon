import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { meleeChoice } from '../../src/services/minebot/utils/floorReflexes.js';
import { bodyOverlap } from '../../src/services/minebot/utils/placeFacts.js';

// Synthetic continuous poses on A's saved a3 roof. The live a3 sub-cell pose
// was not recorded; this demonstrates a clearance invariant, not its death cause.
function fixture(z: number, roofZ = 40, shiftX = 0, shiftZ = 0, roofY = 71) {
  const position = new Vec3(111.5 + shiftX, 67, z + shiftZ);
  const enemy = { id: 4692, name: 'wither_skeleton', type: 'hostile', height: 2.4, width: .7,
    position: new Vec3(113.4 + shiftX, 67, z + shiftZ) };
  const bot: any = {
    entity: { position, onGround: true }, health: 20, game: { dimension: 'the_nether' },
    inventory: { items: () => [{ name: 'cobblestone', type: 1, count: 3 }], slots: [] },
    blockAt: (p: Vec3) => {
      const at = p.floored();
      const name = at.y < 67 || (at.y === roofY && at.z === roofZ + shiftZ && at.x >= 103 + shiftX && at.x <= 121 + shiftX)
        ? 'nether_bricks' : 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: at };
    },
  };
  const choose = () => meleeChoice(bot, [{ entity: enemy, distance: 1.9 }], { beingHit: true }).hand;
  return { bot, position, choose };
}

describe('melee pillar clearance uses the physical body footprint', () => {
  it('keeps a three-block pillar when the centred body clears the adjacent roof', () => {
    const f = fixture(41.5);
    expect(bodyOverlap(new Vec3(111.5, 70, 41.5), { x: 111, y: 71, z: 40 })).toBe(0);
    expect(f.choose()).toMatchObject({ kind: 'pillar', n: 3 });
  });

  it('keeps the existing refusal when the roof is in the feet column', () => {
    expect(fixture(41.5, 41).choose()?.kind).not.toBe('pillar');
  });

  it('refuses the clear centre column when the third-level body overlaps the saved adjacent roof', () => {
    const f = fixture(41.1);
    for (let y = 69; y <= 72; y++) expect(f.bot.blockAt(new Vec3(111, y, 41)).name).toBe('air');
    expect(bodyOverlap(f.position, { x: 111, y: 71, z: 40 })).toBe(0);
    expect(bodyOverlap(new Vec3(111.5, 70, 41.1), { x: 111, y: 71, z: 40 })).toBeGreaterThan(0);
    expect(f.choose()?.kind).not.toBe('pillar');
  });

  it('allows exact face contact without an overlapping body volume', () => {
    expect(bodyOverlap(new Vec3(111.5, 70, 41.3), { x: 111, y: 71, z: 40 })).toBe(0);
    expect(fixture(41.3).choose()).toMatchObject({ kind: 'pillar', n: 3 });
  });

  it('also checks the original highest layer met only during the third jump apex', () => {
    const roof = { x: 111, y: 72, z: 40 };
    expect(bodyOverlap(new Vec3(111.5, 70, 41.1), roof)).toBe(0);
    expect(bodyOverlap(new Vec3(111.5, 70.252, 41.1), roof)).toBeGreaterThan(0);
    expect(fixture(41.1, 40, 0, 0, 72).choose()?.kind).not.toBe('pillar');
  });

  it('keeps a roof above the original clearance range outside the decision', () => {
    expect(fixture(41.1, 40, 0, 0, 73).choose()).toMatchObject({ kind: 'pillar', n: 3 });
  });

  it('keeps the same clearance result after translation into negative coordinates', () => {
    expect(fixture(41.1, 40, -224, -84).choose()?.kind).not.toBe('pillar');
    expect(fixture(41.5, 40, -224, -84).choose()).toMatchObject({ kind: 'pillar', n: 3 });
  });

  it('checks a diagonal roof column when the body overlaps the corner of four cells', () => {
    const f = fixture(41.1);
    f.position.x = 111.1;
    const read = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => {
      const at = p.floored();
      if (at.y !== 71) return read(p);
      const name = at.x === 110 && at.z === 40 ? 'nether_bricks' : 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: at };
    };
    expect(bodyOverlap(new Vec3(111.1, 70, 41.1), { x: 110, y: 71, z: 40 })).toBeGreaterThan(0);
    expect(f.choose()?.kind).not.toBe('pillar');
  });

  it('fails closed on an unread overlapped column, while ignoring an unread column outside the footprint', () => {
    for (const z of [41.1, 41.5]) {
      const f = fixture(z);
      const read = f.bot.blockAt;
      f.bot.blockAt = (p: Vec3) => p.floored().z === 40 ? null : read(p);
      if (z === 41.1) expect(f.choose()?.kind).not.toBe('pillar');
      else expect(f.choose()).toMatchObject({ kind: 'pillar', n: 3 });
    }
  });

  it('keeps the clearance work bounded to the overlapped columns and original height range', () => {
    const f = fixture(41.1);
    f.position.x = 111.1;
    const read = f.bot.blockAt;
    const above: Vec3[] = [];
    f.bot.blockAt = (p: Vec3) => {
      const at = p.floored();
      if (at.y >= 70) {
        above.push(at);
        return { name: 'air', boundingBox: 'empty', position: at };
      }
      return read(p);
    };
    expect(f.choose()).toMatchObject({ kind: 'pillar', n: 3 });
    expect(above.length).toBeLessThanOrEqual(12); // Four columns, last three of the original four height layers.
    expect(new Set(above.map(p => `${p.x},${p.z}`)).size).toBe(4);
    expect(above.every(p => p.x >= 110 && p.x <= 111 && p.z >= 40 && p.z <= 41 && p.y <= 72)).toBe(true);
  });
});
