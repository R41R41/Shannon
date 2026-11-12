import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { ambushLine, shootersInReach, shootersSeeing, type FloorBody } from '../../src/services/minebot/utils/floorReflexes.js';
import { rimSafeAgainst, type Footing } from '../../src/services/minebot/utils/voidFooting.js';
import { defaultFightRange } from '../../src/services/minebot/utils/primitives/fight.js';
import { drawArrivalTicks, drawingBow, inFront } from '../../src/services/minebot/utils/shieldBlock.js';

// Run 8 (11/13): skeletons shot from beyond the reflex's 4 m (the owner: "スケルトンは 4 ブロック以内に来ないで攻撃してくるから反射で攻撃できない"). The fight follows a skeleton
// to 16 m, the cover cuts the line once and waits behind it for one the body may close in on, a rim with no drop behind the body does not stop a blow at one in reach,
// and the shield's reading of a draw is the game's.

function field(items: Array<{ name: string; count?: number }> = [{ name: 'cobblestone', count: 32 }]) {
  const blocks = new Map<string, string>();
  const self = { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5) };
  const bot = {
    entity: self, entities: { 1: self } as Record<number, any>, health: 20, food: 20, heldItem: null,
    inventory: { items: () => items, slots: new Array(46).fill(null) },
    setControlState: () => undefined, look: () => undefined, on: () => undefined,
    blockAt: (p: Vec3) => {
      const at = p.floored(), key = `${at.x},${at.y},${at.z}`;
      const name = blocks.get(key) ?? (at.y < 64 ? 'stone' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: at };
    },
  } as unknown as FloorBody;
  return { bot, blocks };
}

describe('the cover against one skeleton the body may close in on (B2)', () => {
  it('cuts its line with one block a cell or two from the body (no step, no run)', () => {
    const { bot } = field();
    bot.entities![2] = { id: 2, name: 'skeleton', position: new Vec3(9.5, 64, 0.5), height: 1.99 } as any;
    const seeing = shootersSeeing(bot, shootersInReach(bot, bot.entity!.position), bot.entity!.position);
    expect(seeing).toHaveLength(1);
    const line = ambushLine(bot, seeing);
    expect(line?.kind).toBe('line');
    expect(line!.block).toBe('cobblestone');
    expect(Math.hypot(line!.cell.x + 0.5 - 0.5, line!.cell.z + 0.5 - 0.5)).toBeLessThanOrEqual(3);
    expect(line!.detail).toContain('陰で待つ');
  });
  it('has no hand without a block to lay (the cover as before)', () => {
    const { bot } = field([]);
    bot.entities![2] = { id: 2, name: 'skeleton', position: new Vec3(9.5, 64, 0.5), height: 1.99 } as any;
    const seeing = shootersSeeing(bot, shootersInReach(bot, bot.entity!.position), bot.entity!.position);
    expect(ambushLine(bot, seeing)).toBeNull();
  });
});

describe('a blow on a rim (B3)', () => {
  const rim = (sides: Array<[number, number]>, extra: Partial<Footing> = {}): Footing => ({
    sides: sides.map(([dx, dz]) => ({ dx, dz, drop: 10, lava: false })), count: sides.length, deepest: 10, lava: false, bridge: false, pillar: false, ...extra,
  });
  const at = { x: 0.5, z: 0.5 };
  it('is safe when the push (from the enemy toward the body, 45° either side) meets no drop', () => {
    const eastDrop = rim([[1, 0]]);
    expect(rimSafeAgainst(eastDrop, at, { x: 2.5, z: 0.5 })).toBe(true);    // enemy east: pushed west
    expect(rimSafeAgainst(eastDrop, at, { x: -1.5, z: 0.5 })).toBe(false);  // enemy west: pushed east, into the drop
    expect(rimSafeAgainst(eastDrop, at, { x: -1.5, z: -1.5 })).toBe(false); // pushed south-east: 45° from the drop
    expect(rimSafeAgainst(eastDrop, at, { x: 0.5, z: -1.5 })).toBe(true);   // pushed south: the drop is 90° off
  });
  it('is never safe on a bridge, a pillar or beside lava', () => {
    expect(rimSafeAgainst(rim([[1, 0], [-1, 0]], { bridge: true }), at, { x: 0.5, z: -1.5 })).toBe(false);
    expect(rimSafeAgainst(rim([[1, 0]], { lava: true }), at, { x: 2.5, z: 0.5 })).toBe(false);
  });
});

describe('the fight follows a skeleton to 16 m when no range is named (B5)', () => {
  it('16 for a skeleton kind by id or name, 8 for the rest', () => {
    const bot = { entities: { 5: { name: 'skeleton' }, 6: { name: 'zombie' }, 7: { name: 'bogged' } } };
    expect(defaultFightRange(bot, 5)).toBe(16);
    expect(defaultFightRange(bot, '#7')).toBe(16);
    expect(defaultFightRange(bot, 'stray')).toBe(16);
    expect(defaultFightRange(bot, 6)).toBe(8);
    expect(defaultFightRange(bot, 'zombie')).toBe(8);
  });
});

describe('the shield reads a draw by the game (B1)', () => {
  it('reads the hand-in-use bit by the registry\'s key, and times the arrow', () => {
    const registry = { entitiesByName: { skeleton: { metadataKeys: ['a', 'b', 'living_entity_flags'] } } } as any;
    expect(drawingBow({ name: 'skeleton', metadata: [0, 0, 1] }, registry)).toBe(true);
    expect(drawingBow({ name: 'skeleton', metadata: [0, 0, 2] }, registry)).toBe(false);
    expect(drawingBow({ name: 'skeleton', metadata: [] }, registry)).toBe(false);
    expect(drawArrivalTicks(0, 0, 16)).toBeCloseTo(30);
    expect(drawArrivalTicks(0, 500, 0)).toBeCloseTo(10);
    expect(drawArrivalTicks(0, 2000, 8)).toBeCloseTo(5);       // a draw held two seconds is ready: only the flight is left
  });
  it('front is within 80° of the facing, across', () => {
    const from = new Vec3(0, 64, 0);
    expect(inFront(from, 0, new Vec3(0, 70, -5))).toBe(true);      // north, high: the height does not matter
    expect(inFront(from, 0, new Vec3(5, 64, -1.5))).toBe(true);    // 73° off to the east
    expect(inFront(from, 0, new Vec3(5, 64, -0.5))).toBe(false);   // 84° off
    expect(inFront(from, 0, new Vec3(0, 64, 5))).toBe(false);
    expect(inFront(from, undefined, new Vec3(0, 64, -5))).toBe(false);
  });
});
