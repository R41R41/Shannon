import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go, GO_EXPOSED_STOPS, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext, StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { installExposureDigGuard, ThreatExposedError } from '../../src/services/minebot/utils/exposureGuard.js';
import { digRefusedAt, noteRefusedDig, REFUSED_THREAT_MOVED_M, REFUSED_THREAT_MS } from '../../src/services/minebot/utils/refusedDigs.js';

// Run 46 (hold 4): the exposure guard refused 50 digs of a go cell after cell (a zombie behind the rock, 8 to 16 m off), the route was drawn at the next cell each time,
// and the go ran out of its time in a 3 m box. A cell the guard refused stays closed to the routes for as long as that hostile stays where it was; a go refused cell after
// cell, or left with no other way, stops with `threat_exposed` and says who would see the body.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('a refusal for a hostile holds while the hostile stays where it was', () => {
  it('is closed past the old quarter of a minute while the hostile has not moved 3 m, and ends when it moves on or is gone', () => {
    const cell = new Vec3(5, 64, 0);
    const bot: any = { entities: { 7: { position: new Vec3(9.5, 64, 0.5) } } };
    noteRefusedDig(bot, cell, REFUSED_THREAT_MS, 1_000, { id: 7, position: { x: 9.5, y: 64, z: 0.5 } });
    expect(digRefusedAt(bot, cell, 2_000)).toBe(true);
    expect(digRefusedAt(bot, cell, 60_000)).toBe(true);
    bot.entities[7].position = new Vec3(9.5 + REFUSED_THREAT_MOVED_M - 0.5, 64, 0.5);   // moved a little: the same walls still
    expect(digRefusedAt(bot, cell, 61_000)).toBe(true);
    bot.entities[7].position = new Vec3(9.5 + REFUSED_THREAT_MOVED_M + 1, 64, 0.5);     // moved on
    expect(digRefusedAt(bot, cell, 62_000)).toBe(false);
    // gone
    noteRefusedDig(bot, cell, REFUSED_THREAT_MS, 70_000, { id: 7, position: { x: 12, y: 64, z: 0.5 } });
    delete bot.entities[7];
    expect(digRefusedAt(bot, cell, 71_000)).toBe(false);
    // not for a hostile (lava): the time only
    noteRefusedDig(bot, cell, 15_000, 80_000);
    expect(digRefusedAt(bot, cell, 94_000)).toBe(true);
    expect(digRefusedAt(bot, cell, 96_000)).toBe(false);
  });
});

const FLOOR = 64;
const air = new Set<string>();
const stoneCells = new Set<string>();
const cuboid = (set: Set<string>, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set.add(`${x},${y},${z}`);
};
/**
 * A shell of obsidian (never dug), carved: chamber A (the body) x 0..1, a one-thick stone wall at x=2, the cave of a sealed zombie x 3..8, a stone wall at x=9, a stone corridor
 * x 10..13, chamber B x 14..15; all two high (y 64..65) at z=0. With `detour`, a stone way at z=3 round the cave (2 thick of obsidian between), from A to B.
 */
function world(detour: boolean, wide = false): Ground {
  air.clear(); stoneCells.clear();
  cuboid(air, 0, 1, FLOOR, FLOOR + 1, 0, 0); cuboid(air, 14, 15, FLOOR, FLOOR + 1, 0, 0);
  cuboid(stoneCells, 2, 2, FLOOR, FLOOR + 1, 0, 0); cuboid(stoneCells, 9, 13, FLOOR, FLOOR + 1, 0, 0);
  // wide: the cave is seven wide and the stone before it too, so that there are many cells to try (each refused one is another the route is drawn at)
  if (wide) { cuboid(air, 3, 8, FLOOR, FLOOR + 1, -3, 3); cuboid(stoneCells, 2, 2, FLOOR, FLOOR + 1, -3, 3); cuboid(stoneCells, 0, 1, FLOOR, FLOOR + 1, -3, 3); cuboid(air, 0, 1, FLOOR, FLOOR + 1, 0, 0); cuboid(stoneCells, 9, 9, FLOOR, FLOOR + 1, -3, 3); }
  else cuboid(air, 3, 8, FLOOR, FLOOR + 1, 0, 0);
  if (detour) { cuboid(stoneCells, 1, 1, FLOOR, FLOOR + 1, 1, 3); cuboid(stoneCells, 2, 14, FLOOR, FLOOR + 1, 3, 3); cuboid(stoneCells, 14, 14, FLOOR, FLOOR + 1, 1, 2); }
  return (x, y, z) => {
    if (x < -2 || x > 17 || z < -4 || z > 4 || y > FLOOR + 3) return x < -2 || x > 17 || z < -4 || z > 4 ? 'obsidian' : y > FLOOR + 3 ? 'obsidian' : null;
    if (y < FLOOR - 1) return 'obsidian';
    if (y === FLOOR - 1) return 'obsidian';
    const key = `${x},${y},${z}`;
    if (air.has(key)) return 'air';
    if (stoneCells.has(key)) return 'stone';
    return 'obsidian';
  };
}
function setup(detour: boolean, wide = false) {
  const sim = makeSim(world(detour, wide), { start: [0.5, FLOOR, 0.5], items: [{ name: 'diamond_pickaxe', count: 1 }] });
  const bot: any = sim.bot;
  bot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(5.5, FLOOR, 0.5), height: 1.95, isValid: true };
  installExposureDigGuard(bot);
  return sim;
}
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const run = (sim: Sim, args: Partial<GoArgs> = {}) => go(ctxOf(sim), { goals: [{ x: 14, y: FLOOR, z: 0 }], canDig: ['stone'], seconds: 90, maxDig: 80, ...args });

describe('go: a wall with a hostile behind it that the guard will not let be opened', () => {
  it('with no other way, stops at once with threat_exposed and the reason, not after its time and not in a box', async () => {
    const sim = setup(false);
    const started = Date.now();
    const outcome: StepOutcome = await drive(sim, run(sim));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^go 止まった threat_exposed: 掘ると zombie（約\d+m）から身体が見える所を通らないと進めない（守りが掘りを止めたマス \d+ 個 /u);
    expect(outcome.text).toContain('wait-time');
    expect(Date.now() - started).toBeLessThan(30_000);
    // the cave was never opened
    expect(sim.world.nameAt(2, FLOOR, 0)).toBe('stone');
    expect(sim.bot.dugBlocks.filter((line: string) => /@2,/u.test(line))).toEqual([]);
    expect(sim.bot.exposureDigGuard.refused).toBeGreaterThanOrEqual(1);
  });

  it('with another way (a detour of stone at z=3), goes round and arrives, the cave wall untouched', async () => {
    const sim = setup(true);
    const outcome: StepOutcome = await drive(sim, run(sim));
    expect(outcome.ok).toBe(true);
    expect(Math.floor(sim.bot.entity.position.x)).toBeGreaterThanOrEqual(14);
    expect(sim.world.nameAt(2, FLOOR, 0)).toBe('stone');
    expect(sim.world.nameAt(9, FLOOR, 0)).toBe('stone');
  });

  it('refused cell after cell (a wide wall), stops with the reason after no more than GO_EXPOSED_STOPS cells and has not tried the rest', async () => {
    const sim = setup(false, true);
    // The guard's verdict is the test's own here (every cell of the wall at x=2 would open the cave): what is tried is the go's.
    const bot: any = sim.bot, dig = bot.dig;
    bot.dig = (block: any, ...rest: any[]) => {
      if (block.position.x !== 2) return dig.call(bot, block, ...rest);
      noteRefusedDig(bot, block.position, REFUSED_THREAT_MS, Date.now(), { id: 2, position: { x: 5.5, y: FLOOR, z: 0.5 } });   // as the guard marks what it refuses
      return Promise.reject(new ThreatExposedError(block, { name: 'zombie', distance: 6 }));
    };
    const outcome: StepOutcome = await drive(sim, run(sim));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^go 止まった threat_exposed: 掘ると zombie.*守りが掘りを止めたマス d+ 個 /u);
    const cells = Number(/マス (d+) 個/u.exec(outcome.text)![1]);
    expect(cells).toBeGreaterThanOrEqual(2);
    expect(cells).toBeLessThanOrEqual(GO_EXPOSED_STOPS);
    expect(sim.world.nameAt(2, FLOOR, 0)).toBe('stone');
  });
});
