import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { floorlessAt, go, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import { lowerDoorPoints, nodeCell } from '../../src/services/minebot/utils/walkRules.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

// Run 44, hold 1 (2026-10-28; the scene 20261027T184214-act-vpvqh and its box): q51 「畑へ上る」 go to (216,66,206) in a taiga village's field,
// its farmland fenced with open spruce trapdoors. The place's floor was a pumpkin stem; the search ran 5 s out; the walk went for the farmland's own
// cell (a point at y 64.94 read as the cell 64), stepped into a trapdoor's cell and jumped 5 s for the point the pathfinder had put on the panel's
// top; the climb read its feet in the air and laid a level for a cell no jump reaches. Small worlds, the real physics and route search.
const FLOOR = 64;
const R = 24;
// Along z: the body comes from -z; the trapdoor's cell is (0,64,0) (open, facing north: its panel on the far side, z 0.81..1); the field beyond it
// is farmland at (0,64,1..3) with a pumpkin stem on (0,65,1) and wheat on (0,65,2), walled on its sides and end.
const field: Ground = (x, y, z) => {
  if (Math.abs(x) > R || Math.abs(z) > R) return null;
  if (y < FLOOR) return 'stone';
  if (y === FLOOR && x === 0 && z === 0) return 'spruce_trapdoor';
  // Walls on both sides and at the end: the field is entered through the trapdoor's cell only.
  if (y >= FLOOR && y <= FLOOR + 2 && ((Math.abs(x) === 1 && z >= 1 && z <= 4) || (x === 0 && z === 4))) return 'stone';
  if (y === FLOOR && x === 0 && z >= 1 && z <= 3) return 'farmland';
  if (y === FLOOR + 1 && x === 0 && z === 1) return 'pumpkin_stem';
  if (y === FLOOR + 1 && x === 0 && z === 2) return 'wheat';
  return 'air';
};
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('run 44, hold 1: the cell of a route search\'s point', () => {
  it('is the node it was found as, not the top of the floor the pathfinder put the point on', () => {
    expect(nodeCell({ x: 216.5, y: 64.9375, z: 206.5, hash: '216,65,206' })).toEqual({ x: 216, y: 65, z: 206 });
    expect(nodeCell({ x: 217.297, y: 65, z: 206.5, hash: '217,64,206' })).toEqual({ x: 217, y: 64, z: 206 });
    expect(nodeCell({ x: 3.5, y: 64, z: -2.5 })).toEqual({ x: 3, y: 64, z: -3 });
  });

  it('puts a point lifted onto an open trapdoor\'s panel back on its own floor, and leaves other points and those after a dig as they are', () => {
    const sim = makeSim(field);
    const path: any[] = [
      { x: 0.5, y: 64, z: -0.5, hash: '0,64,-1', toBreak: [], toPlace: [] },
      { x: 0.5, y: 65, z: 0.906, hash: '0,64,0', toBreak: [], toPlace: [] },
      { x: 0.5, y: 64.9375, z: 1.5, hash: '0,65,1', toBreak: [], toPlace: [] },
    ];
    expect(lowerDoorPoints(sim.bot, path)).toBe(1);
    expect(path[1]).toMatchObject({ x: 0.5, y: 64, z: 0.5 });
    expect(path[2]).toMatchObject({ x: 0.5, y: 64.9375, z: 1.5 });
    const after: any[] = [{ x: 0.5, y: 64, z: -0.5, hash: '0,64,-1', toBreak: [new Vec3(0, 64, -1)], toPlace: [] }, { x: 0.5, y: 65, z: 0.906, hash: '0,64,0', toBreak: [], toPlace: [] }];
    expect(lowerDoorPoints(sim.bot, after)).toBe(0);
  });
});

describe('run 44, hold 1: a place over a plant, and the walk through a trapdoor\'s cell', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('says at once that a place over a pumpkin stem has no floor, and names the cell under it', async () => {
    const sim = makeSim(field, { start: [0.5, FLOOR, -4.5], items: [{ name: 'cobblestone', count: 16 }] });
    expect(floorlessAt(sim.bot, { x: 0, y: FLOOR + 2, z: 1 }, { names: new Set(['stone', 'dirt']) })).toBe('行き先 (0,66,1) の足元 (0,65,1) は pumpkin_stem で床にならない（立てない・置けない）。(0,65,1) なら farmland の上に立てる');
    expect(floorlessAt(sim.bot, { x: 0, y: FLOOR + 1, z: 1 }, { names: new Set() })).toBeNull();
    expect(floorlessAt(sim.bot, { x: 5, y: FLOOR + 3, z: 5 }, { names: new Set() })).toBeNull();
    const started = Date.now();
    const args: GoArgs = { goals: [{ x: 0, y: FLOOR + 2, z: 1 }], canDig: ['stone', 'dirt'], canPlace: ['cobblestone'], maxDig: 60, seconds: 100 };
    const outcome = await drive(sim, go(ctxOf(sim), args));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^go 止まった no_floor: 行き先 \(0,66,1\) の足元 \(0,65,1\) は pumpkin_stem で床にならない/u);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sim.bot.placedBlocks).toEqual([]);
    // One place of several over a plant is dropped; the others are gone to.
    const two = makeSim(field, { start: [0.5, FLOOR, -4.5] });
    const either = await drive(two, go(ctxOf(two), { goals: [{ x: 0, y: FLOOR + 2, z: 1 }, { x: 2, y: FLOOR, z: -2 }], seconds: 60 }));
    expect(either.ok).toBe(true);
    expect(two.bot.entity.position.distanceTo(new Vec3(2.5, FLOOR, -1.5))).toBeLessThan(1);
  });

  it('gives the executor the point of a trapdoor\'s cell on its floor, not on the panel\'s top, from a block a step up', async () => {
    // As at (218,64,206): a pumpkin before the trapdoor's cell, walked over at y 65. In the run the point put on the panel's top was let go at
    // 0.29 across, the body dropped into the cell beside the panel and jumped for the point (1 up) 5 s. The points the executor walks are the ones
    // `path_update` carries (changed in place after the event): looked at once the go is over.
    const stepped: Ground = (x, y, z) => (y === FLOOR && x === 0 && z === -1 ? 'pumpkin' : field(x, y, z));
    const sim = makeSim(stepped, { start: [0.5, FLOOR + 1, -0.5] });
    const paths: any[][] = [];
    sim.bot.on('path_update', (result: any) => paths.push([...result.path]));
    const outcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 0, y: FLOOR, z: 0 }], seconds: 30 }));
    expect(outcome.text).toMatch(/^go 着いた/u);
    expect(Math.floor(sim.bot.entity.position.z)).toBe(0);
    const inCell = paths.flat().filter(point => point.hash === '0,64,0');
    expect(inCell.length).toBeGreaterThan(0);
    for (const point of inCell) expect([point.x, point.y, point.z]).toEqual([0.5, FLOOR, 0.5]);
  });

  it('walks into the trapdoor\'s cell and over its panel onto the field (the point is not lifted onto the panel)', async () => {
    const sim = makeSim(field, { start: [0.5, FLOOR, -4.5] });
    const outcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 0, y: FLOOR + 1, z: 2 }], seconds: 60 }));
    expect(outcome.text).toMatch(/^go 着いた/u);
    expect(sim.bot.entity.position.z).toBeGreaterThan(2);
    expect(sim.bot.entity.position.y).toBeCloseTo(FLOOR + 0.9375, 2);
  });
});
