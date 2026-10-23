import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';

// mb-llmc-cand 5 (2026-10-24, run 37 late): the frame's creature rows say what they are.
//   1. "#6545 item 0.7m (229,-55,197)": an item entity says its kind and count, and whether the body threw it itself;
//   2. a hostile within 24 m says lineOfSight, pathToMe, dy, shooter and one word (reach) for the three states the planner names.
const { captureWorldObservation: observeWorld } = await import('../../src/services/minebot/cognition/worldFrame.js');
const { walkableWayTo, SHOOTER_KINDS } = await import('../../src/services/minebot/utils/threatReach.js');
const { noteSelfDropped } = await import('../../src/services/minebot/utils/selfDropped.js');

type Cell = { name: string; boundingBox: 'block' | 'empty' };
const STONE: Cell = { name: 'stone', boundingBox: 'block' };
const AIR: Cell = { name: 'air', boundingBox: 'empty' };

/** Floor at y=63 (feet at 64); `shape` overrides. */
function body(shape: (x: number, y: number, z: number) => Cell | null, entities: Record<string, any>, extra: Record<string, unknown> = {}) {
  return {
    llmCentric: true,
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 }, health: 20, food: 20, game: { dimension: 'overworld' }, inventory: { items: () => [] },
    registry: { entitiesByName: { zombie: { type: 'hostile' }, skeleton: { type: 'hostile' }, blaze: { type: 'hostile' }, item: { type: 'other' } } },
    blockAt: (p: Vec3) => { const c = shape(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return c ? { ...c, position: p } : null; },
    entities, ...extra,
  } as any;
}
const flat = (x: number, y: number, z: number): Cell => (y <= 63 ? STONE : AIR);
const mob = (id: number, name: string, at: [number, number, number]) => ({ id, name, position: new Vec3(...at), height: name === 'zombie' || name === 'skeleton' ? 1.95 : 1.8 });
const row = (frame: any, id: number) => [...frame.nearbyEntities, ...(frame.nearbyThreats ?? [])].find((e: any) => e.id === id);

describe('item entities say what they are', () => {
  const item = (id: number, name: string | null, count: number, at: [number, number, number]) => ({ id, name: 'item', position: new Vec3(...at),
    getDroppedItem: () => (name ? { name, count } : null) });
  it('kind and count; unreadable metadata says neither', () => {
    const frame = observeWorld(body(flat, { 1: item(1, 'cobblestone', 3, [1.5, 64, 0.5]), 2: item(2, null, 0, [2.5, 64, 0.5]) })) as any;
    expect(row(frame, 1)).toMatchObject({ name: 'item', itemName: 'cobblestone', itemCount: 3 });
    expect(row(frame, 1).droppedByMe).toBeUndefined();
    expect(row(frame, 2).itemName).toBeUndefined();
    expect(row(frame, 2).itemCount).toBeUndefined();
  });
  it('one the body threw itself is marked droppedByMe', () => {
    const entities = { 1: item(1, 'cobblestone', 64, [1.5, 64, 0.5]), 2: item(2, 'diamond', 1, [2.5, 64, 0.5]) };
    const bot = body(flat, entities);
    noteSelfDropped(bot, 'cobblestone', [entities[1] as any]);
    const frame = observeWorld(bot) as any;
    expect(row(frame, 1).droppedByMe).toBe(true);
    expect(row(frame, 2).droppedByMe).toBeUndefined();
  });
  it('a creature has none of these fields', () => {
    const frame = observeWorld(body(flat, { 5: mob(5, 'zombie', [6.5, 64, 0.5]) })) as any;
    expect(row(frame, 5).itemName).toBeUndefined();
  });
});

describe('a hostile says how it stands to the body', () => {
  it('open ground: in sight, a way, dy, not a shooter', () => {
    const frame = observeWorld(body(flat, { 5: mob(5, 'zombie', [8.5, 64, 0.5]) })) as any;
    expect(row(frame, 5)).toMatchObject({ lineOfSight: true, pathToMe: 'yes', dy: 0, shooter: false, reach: 'in_sight' });
  });
  it('a skeleton is a shooter; a mob 3 m above says dy 3', () => {
    const frame = observeWorld(body(flat, { 6: mob(6, 'skeleton', [8.5, 67, 0.5]) })) as any;
    expect(row(frame, 6)).toMatchObject({ shooter: true, dy: 3 });
    expect(SHOOTER_KINDS.has('zombie')).toBe(false);
  });
  it('behind a wall with a way round: no sight, a path', () => {
    // A wall at x=4, two blocks high, z from -3 to 3: the zombie walks round the end.
    const shape = (x: number, y: number, z: number): Cell => (y <= 63 || (x === 4 && y <= 65 && z >= -3 && z <= 3) ? STONE : AIR);
    const frame = observeWorld(body(shape, { 7: mob(7, 'zombie', [8.5, 64, 0.5]) })) as any;
    expect(row(frame, 7)).toMatchObject({ lineOfSight: false, pathToMe: 'yes', reach: 'path_no_sight' });
  });
  it('shut in by rock: no sight, no path, walled', () => {
    // The mob stands in a one-cell pocket at x=8, z=0 (feet y=64, head y=65): rock on every side, above and below.
    const shape = (x: number, y: number, z: number): Cell => {
      if (y <= 63) return STONE;
      const pocket = x === 8 && z === 0 && y >= 64 && y <= 65;
      return !pocket && x >= 7 && x <= 9 && z >= -1 && z <= 1 && y <= 66 ? STONE : AIR;
    };
    const frame = observeWorld(body(shape, { 8: mob(8, 'zombie', [8.5, 64, 0.5]) })) as any;
    expect(row(frame, 8)).toMatchObject({ lineOfSight: false, pathToMe: 'no', reach: 'walled' });
  });
  it('beyond 24 m nothing is added', () => {
    const frame = observeWorld(body(flat, { 9: mob(9, 'zombie', [30.5, 64, 0.5]) })) as any;
    expect(row(frame, 9).pathToMe).toBeUndefined();
    expect(row(frame, 9).reach).toBeUndefined();
  });
  it('a blaze (a flyer) over a pit: its way is the air, not the floor', () => {
    const shape = (x: number, y: number, z: number): Cell => (y <= 63 && !(x >= 3 && x <= 6) ? STONE : AIR);
    const frame = observeWorld(body(shape, { 10: mob(10, 'blaze', [5.5, 66, 0.5]) })) as any;
    expect(row(frame, 10)).toMatchObject({ shooter: true, pathToMe: 'yes' });
  });
  it('only the nearest 8 are judged', () => {
    const entities: Record<string, any> = {};
    for (let i = 0; i < 10; i++) entities[100 + i] = mob(100 + i, 'zombie', [3.5 + i, 64, 0.5]);
    const frame = observeWorld(body(flat, entities)) as any;
    expect(frame.nearbyThreats.filter((t: any) => t.reach !== undefined).length).toBe(8);
  });
});

describe('walkableWayTo (the cheap estimate)', () => {
  const bot = (shape: (x: number, y: number, z: number) => Cell) => ({ blockAt: (p: Vec3) => ({ ...shape(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }) }) as any;
  it('a plateau 6 high with no way down: no walkable way', () => {
    const shape = (x: number, y: number, z: number): Cell => (y <= 63 || (x >= 10 && y <= 69) ? STONE : AIR);
    // The plateau is bounded (x 10..14) so the search ends; the mob on it does not drop 6.
    const bounded = (x: number, y: number, z: number): Cell => (x > 14 ? STONE : shape(x, y, z));
    expect(walkableWayTo(bot(bounded), new Vec3(12.5, 70, 0.5), 1.95, new Vec3(0.5, 64, 0.5))).toBe('no');
  });
  it('a stair of 1-block steps: yes', () => {
    const shape = (x: number, y: number, z: number): Cell => (y <= 63 + Math.max(0, Math.min(5, Math.floor((x - 4) / 2))) ? STONE : AIR);
    expect(walkableWayTo(bot(shape), new Vec3(14.5, 69, 0.5), 1.95, new Vec3(0.5, 64, 0.5))).toBe('yes');
  });
  it('not loaded around the start is unknown, never no', () => {
    expect(walkableWayTo({ blockAt: () => null } as any, new Vec3(5.5, 64, 0.5), 1.8, new Vec3(0.5, 64, 0.5))).toBe('unknown');
  });
  it('a budget that runs out is unknown, never no', () => {
    const open = (x: number, y: number, z: number): Cell => (y <= 63 ? STONE : x >= 20 && x <= 21 ? STONE : AIR);
    expect(walkableWayTo(bot(open), new Vec3(60.5, 64, 0.5), 1.8, new Vec3(0.5, 64, 0.5), -1)).toBe('unknown');
  });
});
