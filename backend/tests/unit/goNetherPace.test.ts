import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim, type Stack } from '../helpers/physicsBody.js';
import { bridgeSideCells, fortressOpenAt, go, installBoundedLanding, lastGoTiming, overLava, sprintHazardAt, strandedPack, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import type { StepContext, StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';

// S8 (2026-11-05): the Nether's pace. The lab's Nether walks ran 0.6 to 0.7 m a second, digging a tunnel nearly all the way (460 digs on 233 m); a person runs on
// the netherrack, goes round the hills, and lays walls on a bridge over lava. The pure rules (the sprint's hazards, the bridge's side cells, the bounded landing
// search) and the hand against the real physics and route search (tests/helpers/physicsBody) in small Nether worlds.

const FLOOR = 64;
const R = 40;
type Layer = (x: number, y: number, z: number) => string | null | undefined;
const over = (base: Ground, ...layers: Layer[]): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  return base(x, y, z);
};
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Layer => (x, y, z) =>
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? name : undefined);
const netherFlat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'netherrack' : 'air');
const reader = (ground: Ground) => (x: number, y: number, z: number) => ground(x, y, z);

describe('the sprint left to the body (sprintHazardAt)', () => {
  it('is on over open netherrack, off within two cells of lava, off beside a cliff', () => {
    expect(sprintHazardAt(reader(netherFlat), 0, FLOOR, 0, 3)).toBeNull();
    expect(sprintHazardAt(reader(over(netherFlat, box('lava', 2, 2, FLOOR - 1, FLOOR - 1, 0, 0))), 0, FLOOR, 0, 3)).toMatch(/lava/u);
    expect(sprintHazardAt(reader(over(netherFlat, box('lava', 3, 3, FLOOR - 1, FLOOR - 1, 0, 0))), 0, FLOOR, 0, 3)).toBeNull();
    // A shaft of 10 beside the feet: a fall beyond the drop allowed.
    expect(sprintHazardAt(reader(over(netherFlat, box('air', 1, 1, FLOOR - 10, FLOOR - 1, 0, 0))), 0, FLOOR, 0, 3)).toMatch(/崖/u);
    // A step down of 2 beside the feet is a floor within the drop.
    expect(sprintHazardAt(reader(over(netherFlat, box('air', 1, 1, FLOOR - 2, FLOOR - 1, 0, 0))), 0, FLOOR, 0, 3)).toBeNull();
    // Lava under an open cell beside the feet.
    expect(sprintHazardAt(reader(over(netherFlat, box('air', 1, 1, FLOOR - 3, FLOOR - 1, 0, 0), box('lava', 1, 1, FLOOR - 4, FLOOR - 4, 0, 0))), 0, FLOOR, 0, 3)).not.toBeNull();
    // Not loaded beside the feet: off.
    expect(sprintHazardAt(() => null, 0, FLOOR, 0, 3)).toMatch(/読み込まれていない/u);
  });
});

describe('a bridge over lava (bridgeSideCells, overLava)', () => {
  const lavaSea: Ground = (x, y, z) => (y < FLOOR ? 'lava' : 'air');
  it('names a side floor and a wall on each side across the way, never a cell the route walks', () => {
    const laid = { x: 3, y: FLOOR - 1, z: 0 }, feet = { x: 2, y: FLOOR, z: 0 };
    const cells = bridgeSideCells(reader(lavaSea), laid, feet, [{ x: 3, y: FLOOR, z: 0 }, { x: 4, y: FLOOR, z: 0 }]);
    expect(cells).toEqual([{ floor: { x: 3, y: FLOOR - 1, z: 1 }, wall: { x: 3, y: FLOOR, z: 1 } }, { floor: { x: 3, y: FLOOR - 1, z: -1 }, wall: { x: 3, y: FLOOR, z: -1 } }]);
    // The route turns to z=1 over the floor laid: the way there is along z, the walls across x, and nothing in the cell the route walks next.
    const turning = bridgeSideCells(reader(lavaSea), laid, feet, [{ x: 3, y: FLOOR, z: 0 }, { x: 3, y: FLOOR, z: 1 }]);
    expect(turning.map(cell => [cell.wall.x, cell.wall.z])).toEqual([[4, 0], [2, 0]]);
    // A side cell the route walks is left.
    const walking = bridgeSideCells(reader(lavaSea), laid, feet, [{ x: 3, y: FLOOR, z: 0 }, { x: 4, y: FLOOR, z: 0 }, { x: 4, y: FLOOR, z: 1 }, { x: 3, y: FLOOR, z: 1 }]);
    expect(walking.map(cell => cell.wall.z)).toEqual([-1]);
    // No route: the way from the body leaning over the edge.
    expect(bridgeSideCells(reader(lavaSea), laid, { x: 3.1, z: 0.5 }, []).map(cell => cell.wall.z)).toEqual([1, -1]);
    // A side floor that is already solid: only the wall over it.
    const solidSide = bridgeSideCells(reader(over(lavaSea, box('netherrack', 3, 3, FLOOR - 1, FLOOR - 1, 1, 1))), laid, feet, []);
    expect(solidSide[0]).toEqual({ floor: null, wall: { x: 3, y: FLOOR, z: 1 } });
    // Along z the sides are across x.
    expect(bridgeSideCells(reader(lavaSea), { x: 0, y: FLOOR - 1, z: 5 }, { x: 0, y: FLOOR, z: 4 }, []).map(cell => cell.wall.x)).toEqual([1, -1]);
    expect(overLava(reader(lavaSea), { x: 0, y: FLOOR - 1, z: 0 })).toBe(true);
    expect(overLava(reader(netherFlat), { x: 0, y: FLOOR - 1, z: 0 })).toBe(false);
  });
});

describe('the landing search reads no deeper than the drop allowed (installBoundedLanding)', () => {
  /** A minimal movements over a column world: the reads are counted. */
  const movementsOver = (ground: Ground, maxDropDown: number) => {
    let reads = 0;
    const blockOf = (x: number, y: number, z: number) => {
      reads++;
      const name = ground(x, y, z) ?? 'air';
      return { position: new Vec3(x, y, z), physical: !/^(air|lava|water)$/u.test(name), liquid: /^(lava|water)$/u.test(name), safe: name === 'air' || name === 'water', name };
    };
    const movements: any = {
      maxDropDown, infiniteLiquidDropdownDistance: false, bot: { game: { minY: -64 } },
      getBlock: (pos: any, dx: number, dy: number, dz: number) => blockOf(pos.x + dx, pos.y + dy, pos.z + dz),
      // mineflayer-pathfinder's own (2.4.5), copied for the comparison.
      getLandingBlock(node: any, dir: any) {
        let blockLand = this.getBlock(node, dir.x, -2, dir.z);
        while (blockLand.position && blockLand.position.y > this.bot.game.minY) {
          if (blockLand.liquid && blockLand.safe) return blockLand;
          if (blockLand.physical) {
            if (node.y - blockLand.position.y <= this.maxDropDown) return this.getBlock(blockLand.position, 0, 1, 0);
            return null;
          }
          if (!blockLand.safe) return null;
          blockLand = this.getBlock(blockLand.position, 0, -1, 0);
        }
        return null;
      },
    };
    return { movements, reads: () => reads, reset: () => { reads = 0; } };
  };
  it('finds what the original finds, and stops reading at the drop allowed', () => {
    const worlds: Array<[string, Ground]> = [
      ['a step down', (x, y) => (y < FLOOR - 1 ? 'netherrack' : 'air')],
      ['a drop of 4', (x, y) => (y < FLOOR - 4 ? 'netherrack' : 'air')],
      ['a drop of 5', (x, y) => (y < FLOOR - 5 ? 'netherrack' : 'air')],
      ['the lava sea 40 down', (x, y) => (y < FLOOR - 40 ? 'lava' : 'air')],
      ['water 3 down', (x, y) => (y < FLOOR - 3 ? 'water' : 'air')],
      ['water 9 down', (x, y) => (y < FLOOR - 9 ? 'water' : 'air')],
    ];
    const node = { x: 0, y: FLOOR, z: 0 };
    for (const [name, ground] of worlds) {
      const plain = movementsOver(ground, 4);
      const wanted = plain.movements.getLandingBlock(node, { x: 1, z: 0 });
      const wantedReads = plain.reads();
      const bounded = movementsOver(ground, 4);
      installBoundedLanding(bounded.movements);
      const got = bounded.movements.getLandingBlock(node, { x: 1, z: 0 });
      // Where the original returns a liquid too deep, the drop is refused right after (node.y - y > maxDropDown); the bounded search returns nothing.
      const usable = wanted && !(wanted.liquid && node.y - wanted.position.y > 4) ? wanted : null;
      expect(got?.position ?? null, name).toEqual(usable?.position ?? null);
      expect(bounded.reads(), name).toBeLessThanOrEqual(wantedReads);
    }
    const sea = movementsOver((x, y) => (y < FLOOR - 40 ? 'lava' : 'air'), 4);
    installBoundedLanding(sea.movements);
    sea.movements.getLandingBlock(node, { x: 1, z: 0 });
    expect(sea.reads()).toBeLessThanOrEqual(5);
  });
});

describe('run 62: no way back, and the fortress open floor', () => {
  it('knows a pack with no pickaxe and no block as stranded', () => {
    const pack = (...names: string[]) => ({ inventory: { items: () => names.map(name => ({ name, count: 1 })) } });
    expect(strandedPack(pack())).toBe(true);
    expect(strandedPack(pack('cooked_beef', 'iron_sword'))).toBe(true);
    expect(strandedPack(pack('wooden_pickaxe'))).toBe(false);
    expect(strandedPack(pack('netherrack'))).toBe(false);
    expect(strandedPack(pack('oak_planks'), ['oak_planks'])).toBe(false);
  });
  it('prices a fortress corridor or bridge, not a 1x2 tunnel under its floor', () => {
    // A corridor three wide on nether bricks at y=70 (floor 69), walls at z=+-2; under the floor, netherrack with a tunnel at y=67..68 along x.
    const fortress: Ground = (x, y, z) => {
      if (y === 69) return 'nether_bricks';
      if (y >= 70 && y <= 72) return Math.abs(z) >= 2 ? 'nether_bricks' : 'air';
      if (y >= 67 && y <= 68 && z === 0) return 'air';
      return y < 69 ? 'netherrack' : 'air';
    };
    expect(fortressOpenAt(reader(fortress), 0, 70, 0)).toBe(true);
    expect(fortressOpenAt(reader(fortress), 0, 70, 1)).toBe(true);
    expect(fortressOpenAt(reader(fortress), 0, 67, 0)).toBe(false);
    // A 1x2 tunnel cut through the fortress's own floor level: two sides open only.
    const tunnel: Ground = (x, y, z) => (y === 69 ? 'nether_bricks' : y >= 70 && y <= 71 && z === 0 ? 'air' : y >= 70 ? 'nether_bricks' : 'netherrack');
    expect(fortressOpenAt(reader(tunnel), 0, 70, 0)).toBe(false);
    expect(fortressOpenAt(reader(netherFlat), 0, FLOOR, 0)).toBe(false);
  });
});

// ---- the hand in the Nether ----------------------------------------------------------------------------------------------------------------

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const netherSim = (ground: Ground, items: Stack[] = []) => { const sim = makeSim(ground, { items }); sim.bot.game.dimension = 'the_nether'; return sim; };
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const run = (sim: Sim, args: Omit<GoArgs, 'goals'>, to: { x: number; y: number; z: number }): Promise<StepOutcome> => go(ctxOf(sim), { goals: [to], ...args });
const PICK: Stack = { name: 'diamond_pickaxe', count: 1 };

describe('go in the Nether', () => {
  it('goes back the way it came when it has no pickaxe and no block: a ledge two down is not taken', async () => {
    // The body at y=64 on a terrace; the place is 6 down by a cliff of two-cell steps (falls of two), or by a long way round of one-cell steps along z=8.
    const terrace: Ground = (x, y, z) => {
      if (Math.abs(x) > R || Math.abs(z) > R) return null;
      const top = z >= 6 ? FLOOR - Math.min(6, Math.max(0, x - 2)) : FLOOR - 2 * Math.min(3, Math.max(0, Math.floor((x - 2) / 2) + 1));
      return y < top ? 'netherrack' : 'air';
    };
    const sim = netherSim(terrace, []);
    let maxZ = 0;
    const promise = run(sim, { maxDrop: 3, seconds: 60 }, { x: 10, y: FLOOR - 6, z: 0 });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let elapsed = 0; elapsed < 120_000 && !settled; elapsed += 50) { sim.tick(); maxZ = Math.max(maxZ, sim.bot.entity.position.z); await vi.advanceTimersByTimeAsync(50); }
    const outcome = await promise;
    // It went down the one-cell steps (each climbed back by a jump), not the ledges of two.
    expect(outcome.ok).toBe(true);
    expect(maxZ).toBeGreaterThan(5.5);
    // With a pickaxe it may take the ledges (the straight way).
    const armed = netherSim(terrace, [PICK]);
    let armedMaxZ = 0;
    const armedRun = run(armed, { maxDrop: 3, seconds: 60 }, { x: 10, y: FLOOR - 6, z: 0 });
    let armedDone = false;
    armedRun.then(() => { armedDone = true; }, () => { armedDone = true; });
    for (let elapsed = 0; elapsed < 120_000 && !armedDone; elapsed += 50) { armed.tick(); armedMaxZ = Math.max(armedMaxZ, armed.bot.entity.position.z); await vi.advanceTimersByTimeAsync(50); }
    expect((await armedRun).ok).toBe(true);
    expect(armedMaxZ).toBeLessThan(3);
  });

  it('goes round a netherrack hill on the open ground instead of tunnelling through it', async () => {
    // A hill 4 thick across the way (x=4..7, z=-3..3), 6 high; the way round is 4 cells aside.
    const sim = netherSim(over(netherFlat, box('netherrack', 4, 7, FLOOR, FLOOR + 5, -3, 3)), [PICK]);
    const outcome = await drive(sim, run(sim, { canDig: ['netherrack'], maxDig: 60 }, { x: 11, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(true);
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('runs where nothing hurts near, and walks beside lava', async () => {
    const open = netherSim(netherFlat, [PICK]);
    expect((await drive(open, run(open, { sprint: 'auto' }, { x: 20, y: FLOOR, z: 0 }))).ok).toBe(true);
    expect(lastGoTiming(open.bot)!.sprintMs).toBeGreaterThan(500);
    const never = netherSim(netherFlat, [PICK]);
    expect((await drive(never, run(never, {}, { x: 20, y: FLOOR, z: 0 }))).ok).toBe(true);
    expect(lastGoTiming(never.bot)!.sprintMs).toBe(0);
    // Lava two cells off on both sides of the way, all along it: the way is z=0 and the sprint stays off.
    const lane = netherSim(over(netherFlat, box('lava', -3, 24, FLOOR, FLOOR, 2, 2), box('lava', -3, 24, FLOOR, FLOOR, -2, -2)), [PICK]);
    expect((await drive(lane, run(lane, { sprint: 'auto' }, { x: 20, y: FLOOR, z: 0 }))).ok).toBe(true);
    expect(lastGoTiming(lane.bot)!.sprintMs).toBe(0);
  });

  it('lays walls beside a floor it lays over lava', async () => {
    // A lava gap across the way at x=3..5, the lava's top at the floor's level (y=63).
    const sim = netherSim(over(netherFlat, box('lava', 3, 5, FLOOR - 4, FLOOR - 1, -R, R)), [PICK, { name: 'netherrack', count: 64 }]);
    const outcome = await drive(sim, run(sim, { canPlace: ['netherrack'], maxPlace: 40 }, { x: 8, y: FLOOR, z: 0 }));
    expect(outcome.ok).toBe(true);
    const placed = sim.bot.placedBlocks as string[];
    const walls = placed.filter(entry => /@[345],64,(?:1|-1)$/u.test(entry));
    expect(walls.length).toBeGreaterThanOrEqual(2);
    expect(lastGoTiming(sim.bot)!.walls).toBeGreaterThanOrEqual(2);
  });
});
