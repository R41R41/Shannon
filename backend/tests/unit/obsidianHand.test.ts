import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim, type Stack } from '../helpers/handsSim.js';
import { obsidian, obsidianProblem, planPours, pourSpots, type ObsidianArgs } from '../../src/services/minebot/utils/primitives/obsidian.js';
import { StepStopped, type StepContext, type StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { bodyReader, feetCell } from '../../src/services/minebot/utils/localMap.js';
import Act, { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { normalizeSkillSchema } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

// The hand `obsidian` against the real client physics (prismarine-physics) and the real route search and executor (mineflayer-pathfinder), in small
// worlds (tests/helpers/handsSim): the body is moved 50 ms of physics for every 50 ms of fake time; a bucket is a ray from the eye, water runs and
// sets the lava it touches (above it or beside it), digging takes the obsidian's time and is told by the server's packet, the drop lies where it fell.
// A world is a function from a cell to a block name (null: not loaded); the feet stand at y=64 on stone below it. Lava does not flow in this world.
// No server and no API.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const R = 40;
type Layer = (x: number, y: number, z: number) => string | null | undefined;
const ground = (radius: number): Ground => (x, y, z) => (Math.abs(x) > radius || Math.abs(z) > radius ? null : y < FLOOR ? 'stone' : 'air');
const flat = ground(R);
const over = (base: Ground, ...layers: Layer[]): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  return base(x, y, z);
};
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Layer => (x, y, z) =>
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? name : undefined);
/** A lake of lava sources, the top layer level with the shore (y=63). */
const lake = (x0 = 8, x1 = 14, z0 = -4, z1 = 4): Layer => box('lava', x0, x1, 62, 63, z0, z1);
const ctxOf = (sim: HandsSim, controller = new AbortController(), ms = 600_000): StepContext => ({
  bot: sim.bot, stop: controller.signal, deadline: Date.now() + ms, facing: 'north', base: { x: 0, y: FLOOR, z: 0 },
});
/** Runs the physics and the fake clock until the promise is settled (or `maxMs` of fake time has gone). */
async function drive<T>(sim: HandsSim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 400_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
/** The world let run on: water runs, lava sets, whatever was left to a timer. */
async function settle(sim: HandsSim, ms = 2000) { for (let t = 0; t < ms; t += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); } }
const stacks = (...list: Stack[]) => list;
const WATER: Stack = { name: 'water_bucket', count: 1 };
const PICK: Stack = { name: 'diamond_pickaxe', count: 1 };
const at = (x: number, y: number, z: number) => ({ x, y, z });
const run = (sim: HandsSim, args: ObsidianArgs, controller?: AbortController) => obsidian(ctxOf(sim, controller), args);
const counts = (outcome: StepOutcome) => {
  const found = /黒曜石 (\d+) 個・水の注ぎ (\d+) 回・立ち直し (\d+) 回/u.exec(outcome.text);
  return found ? { obsidian: Number(found[1]), pours: Number(found[2]), restands: Number(found[3]) } : null;
};

describe('obsidian: a lava source on a shore', () => {
  it('waits for the inventory packet after the picked drop disappears (run 49 hold 2)', async () => {
    const sim = makeHandsSim(over(flat, box('obsidian', 8, 8, 63, 63, 0, 0)), { items: stacks(PICK) });
    const items = sim.bot.inventory.items;
    let seenAt: number | undefined;
    sim.bot.inventory.items = () => {
      const all = items();
      if (all.some((item: Stack) => item.name === 'obsidian')) seenAt ??= Date.now();
      return all.filter((item: Stack) => item.name !== 'obsidian' || (seenAt !== undefined && Date.now() >= seenAt + 500));
    };
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.ok).toBe(true);
    expect(counts(outcome)!.obsidian).toBe(1);
    expect(sim.bot.inventory.items().some((item: Stack) => item.name === 'obsidian')).toBe(true);
  });

  it('does not count a vanished drop as collected without an inventory increase', async () => {
    const sim = makeHandsSim(over(flat, box('obsidian', 8, 8, 63, 63, 0, 0)), { items: stacks(PICK) });
    const items = sim.bot.inventory.items;
    sim.bot.inventory.items = () => items().filter((item: Stack) => item.name !== 'obsidian');
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.ok).toBe(false);
    expect(counts(outcome)!.obsidian).toBe(0);
  });

  it('counts a drop delivered during the last recovery of water, after earlier scoops were refused', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const activate = sim.bot.activateItem, items = sim.bot.inventory.items;
    let refused = 0;
    sim.bot.activateItem = () => {
      if (sim.bot.heldItem?.name === 'bucket' && refused++ < 6) return;
      activate();
      if (sim.bot.scooped.length) {
        // The server's collection packet during the successful recovery; only a drop of the block actually dug is delivered.
        for (const [id, drop] of Object.entries<any>(sim.bot.entities)) {
          if (drop.getDroppedItem?.()?.name === 'obsidian') { sim.give('obsidian', 1); delete sim.bot.entities[id]; }
        }
      }
    };
    // The collection packet becomes visible with the final successful scoop, as when that recovery passes through the drop.
    sim.bot.inventory.items = () => items().filter((item: Stack) => item.name !== 'obsidian' || sim.bot.scooped.length > 0);
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(refused).toBeGreaterThan(6);
    expect(sim.count('obsidian')).toBe(1);
    expect(sim.count('water_bucket')).toBe(1);
    expect(outcome.ok).toBe(true);
    expect(counts(outcome)!.obsidian).toBe(1);
  });

  it('pours the water where it runs onto the lava, mines the obsidian, takes the drop and the water back, in one hand', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    let lowest = 99;
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }), () => { lowest = Math.min(lowest, sim.bot.entity.position.y); });
    // Run 47 (hold 7): no diagonal step leaves or enters water, so the walk out of the poured water may take one more stand than before (0 or 1).
    expect(outcome.text).toMatch(/^obsidian 済 黒曜石 1 個・水の注ぎ 1 回・立ち直し [01] 回・水回収済/u);
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(1);
    expect(sim.count('water_bucket')).toBe(1);
    expect(sim.count('bucket')).toBe(0);
    // The source was dug as obsidian with the diamond pickaxe, and the water is out of the world again once its flow has gone.
    expect(sim.bot.dugBlocks).toContain('obsidian@8,63,0');
    await settle(sim);
    expect(sim.nameAt(7, 64, 0)).toBe('air');
    expect(sim.nameAt(8, 64, 0)).toBe('air');
    // Never in the lava: the feet were never lower than the shore.
    expect(lowest).toBeGreaterThan(63.9);
    expect(sim.bot.health).toBe(20);
    // One pour, one scoop; the water ran in from a cell on the floor beside the one over the lava.
    expect(sim.bot.poured).toHaveLength(1);
    expect(sim.bot.scooped).toHaveLength(1);
    // Lava lies under the block (a lake two deep): its drop would burn, so the water stayed over the hole until the block was out.
    const order = sim.log.filter(line => /^(pour|dig|scoop)/u.test(line)).map(line => line.split(' ')[0]);
    expect(order).toEqual(['pour', 'dig', 'scoop']);
  });

  it('takes the water back first and digs dry where the drop would not burn (a lake one deep, its rim set by the water)', async () => {
    const sim = makeHandsSim(over(flat, box('lava', 8, 14, 63, 63, -4, 4)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.text).toMatch(/^obsidian 済 黒曜石 1 個・水の注ぎ 1 回・立ち直し 0 回・水回収済/u);
    expect(sim.count('obsidian')).toBe(1);
    expect(sim.count('water_bucket')).toBe(1);
    const order = sim.log.filter(line => /^(pour|dig|scoop)/u.test(line)).map(line => line.split(' ')[0]);
    expect(order).toEqual(['pour', 'scoop', 'dig']);
  });

  it('mines a block the first water set on its way (a cell of the lake beside it) with the lava under it covered by water first', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const first = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(first.ok).toBe(true);
    await settle(sim);
    // The cells beside it were set by the same water: obsidian already, so the next hand needs no lava set; it has lava under it, so it pours to cover the hole.
    const beside = sim.nameAt(8, 63, 1) === 'obsidian' ? at(8, 63, 1) : at(8, 63, -1);
    expect(sim.nameAt(beside.x, beside.y, beside.z)).toBe('obsidian');
    const second = await drive(sim, run(sim, { at: [beside] }));
    expect(second.text).toMatch(/^obsidian 済 黒曜石 1 個・水の注ぎ 1 回・立ち直し 0 回・水回収済/u);
    expect(sim.count('obsidian')).toBe(2);
    expect(sim.count('water_bucket')).toBe(1);
  });

  it('takes the count it was asked for from the sources named, one by one', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0), at(10, 63, 0), at(8, 63, 3)], count: 3 }));
    expect(outcome.ok).toBe(true);
    expect(counts(outcome)!.obsidian).toBe(3);
    expect(sim.count('obsidian')).toBe(3);
    expect(sim.count('water_bucket')).toBe(1);
  });

  it('does not search for lava it was not given: the other lake is never gone to', async () => {
    // A second lake 20 blocks off to the west, with a shore of its own; only the east lake's source is named.
    const west: Layer = box('lava', -20, -14, 62, 63, -4, 4);
    const sim = makeHandsSim(over(flat, lake(), west), { items: stacks(WATER, PICK) });
    let westmost = 99;
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }), () => { westmost = Math.min(westmost, sim.bot.entity.position.x); });
    expect(outcome.ok).toBe(true);
    expect(westmost).toBeGreaterThan(-1);
    expect(sim.bot.poured.every((cell: string) => Number(cell.split(',')[0]) > 0)).toBe(true);
    expect(sim.nameAt(-14, 63, 0)).toBe('lava');
  });
});

describe('obsidian: a connected pool', () => {
  const surface = (x0: number, width: number, depth: number) =>
    Array.from({ length: width * depth }, (_, i) => at(x0 + i % width, 63, Math.floor(i / width)));

  it.each([8, 12])('sets a 3 by 3 surface with one pour at x=%i, then mines all nine dry (count omitted)', async x0 => {
    const cells = surface(x0, 3, 3);
    const sim = makeHandsSim(over(flat, box('lava', x0, x0 + 2, 63, 63, 0, 2)), { items: stacks(WATER, PICK) });
    const beforeDigs: number[] = [];
    const dry: boolean[] = [];
    const dig = sim.bot.dig;
    sim.bot.dig = async (block: any) => {
      if (block.name === 'obsidian') {
        beforeDigs.push(cells.filter(cell => sim.nameAt(cell.x, cell.y, cell.z) === 'obsidian').length);
        dry.push(sim.count('water_bucket') === 1);
      }
      return dig(block);
    };
    const ctx = ctxOf(sim);
    ctx.progress = vi.fn();
    const outcome = await drive(sim, obsidian(ctx, { at: cells, seconds: 180 }));
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(9);
    expect(beforeDigs[0]).toBe(9);
    expect(dry).toEqual(new Array(9).fill(true));
    expect(sim.bot.poured).toHaveLength(1);
    expect(sim.bot.scooped).toHaveLength(1);
    expect(sim.bot.dugBlocks.slice().sort()).toEqual(cells.map(cell => `obsidian@${cell.x},${cell.y},${cell.z}`).sort());
    expect(sim.count('water_bucket')).toBe(1);
    expect(ctx.progress).toHaveBeenCalledWith(expect.stringContaining('湖面 9/9'));
    expect(sim.bot.health).toBe(20);
  }, 120_000);

  it('stops mining at count even when the pour set more named cells', async () => {
    const cells = surface(8, 2, 1);
    const sim = makeHandsSim(over(flat, box('lava', 8, 9, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: cells, count: 1 }));
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(1);
    expect(sim.bot.dugBlocks).toHaveLength(1);
    expect(cells.filter(cell => sim.nameAt(cell.x, cell.y, cell.z) === 'obsidian')).toHaveLength(1);
    expect(sim.count('water_bucket')).toBe(1);
  });

  it('moves along a long surface and pours again for sources beyond the first flow', async () => {
    const cells = surface(8, 12, 1);
    const sim = makeHandsSim(over(flat, box('lava', 8, 19, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: cells, seconds: 300 }));
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(12);
    expect(sim.bot.poured.length).toBeGreaterThan(1);
    expect(sim.bot.poured.length).toBeLessThan(cells.length);
    expect(sim.bot.scooped).toHaveLength(sim.bot.poured.length);
    expect(sim.count('water_bucket')).toBe(1);
  }, 120_000);

  it('covers the hole before mining the set crust over deeper lava and collects each drop', async () => {
    const cells = surface(8, 2, 2);
    const sim = makeHandsSim(over(flat, lake(8, 9, 0, 1)), { items: stacks(WATER, PICK) });
    const covered: boolean[] = [];
    const dig = sim.bot.dig;
    sim.bot.dig = async (block: any) => {
      if (block.name === 'obsidian' && block.position.y === 63 && sim.nameAt(block.position.x, 62, block.position.z) === 'lava') {
        const { x, y, z } = block.position;
        covered.push([[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
          .some(([dx, dy, dz]) => sim.nameAt(x + dx!, y + dy!, z + dz!) === 'water'));
      }
      return dig(block);
    };
    const outcome = await drive(sim, run(sim, { at: cells, seconds: 300 }));
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(4);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every(Boolean)).toBe(true);
    expect(sim.count('water_bucket')).toBe(1);
    expect(sim.bot.health).toBe(20);
  }, 120_000);
});

describe('obsidian: a place to stand that is not one', () => {
  it('stands elsewhere and pours again when the floor of the planned place is not there (the walk says target_unstandable)', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const read = bodyReader(sim.bot);
    const first = planPours(read, at(8, 63, 0), { from: feetCell(sim.bot)!, excluded: new Set(), footingOk: false })[0];
    // The floor under the best place goes (a hole the map showed as ground) the moment the walk is begun.
    let broken = false;
    const movements = sim.bot.pathfinder.setMovements.bind(sim.bot.pathfinder);
    sim.bot.pathfinder.setMovements = (m: unknown) => {
      if (!broken) { broken = true; sim.world.set(first.stand.x, first.stand.y - 1, first.stand.z, 'air'); }
      return movements(m);
    };
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.ok).toBe(true);
    expect(counts(outcome)!.restands).toBeGreaterThanOrEqual(1);
    expect(counts(outcome)!.obsidian).toBe(1);
    expect(sim.count('water_bucket')).toBe(1);
    expect(sim.nameAt(first.stand.x, first.stand.y - 1, first.stand.z)).toBe('air');
  });

  it('says unreachable when the places that reach the lava cannot be got to (a gap across the way)', async () => {
    // The plateau ends at x=1, a gap of five without a floor, then the lip and the lake: the lip is the only place that reaches the lava.
    const gap: Layer = box('air', 2, 6, 50, FLOOR - 1, -20, 20);
    const sim = makeHandsSim(over(ground(14), gap, lake(8, 12, -3, 3)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unreachable');
    expect(outcome.text).toMatch(/^obsidian 止まった unreachable: /u);
    expect(outcome.text).toContain('に着けない');
    expect(sim.count('water_bucket')).toBe(1);
    expect(sim.bot.poured).toEqual([]);
  }, 120_000);

  it('says lava_danger when the only places that reach the lava have lava round their feet (it stands nowhere near it)', async () => {
    // A causeway of stone one cell wide runs out to the lake with lava at the level of the feet on both sides, and walls beyond it.
    const strait = over(ground(20),
      box('lava', 4, 7, 64, 64, -1, -1), box('lava', 4, 7, 64, 64, 1, 1),
      box('stone', 4, 12, 64, 66, -3, -2), box('stone', 4, 12, 64, 66, 2, 3),
      box('lava', 8, 12, 62, 63, -1, 1));
    const sim = makeHandsSim(strait, { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('lava_danger');
    expect(outcome.text).toMatch(/^obsidian 止まった lava_danger: /u);
    expect(outcome.text).toContain('溶岩の隣');
    expect(sim.bot.poured).toEqual([]);
    expect(sim.bot.entity.position.x).toBeLessThan(3);
    expect(sim.count('water_bucket')).toBe(1);
  });
});

describe('obsidian: what it refuses before it begins', () => {
  const world = over(flat, lake());
  it('says no_bucket without a full water bucket (and an empty bucket is told apart)', async () => {
    const none = makeHandsSim(world, { items: stacks(PICK) });
    const first = await drive(none, run(none, { at: [at(8, 63, 0)] }));
    expect(first.reason).toBe('no_bucket');
    expect(first.text).toMatch(/^obsidian 止まった no_bucket: /u);
    const empty = makeHandsSim(world, { items: stacks(PICK, { name: 'bucket', count: 1 }) });
    const second = await drive(empty, run(empty, { at: [at(8, 63, 0)] }));
    expect(second.reason).toBe('no_bucket');
    expect(second.text).toContain('空の bucket');
  });
  it('says no_tool without a diamond pickaxe (an iron one will not do), and moves nothing', async () => {
    const sim = makeHandsSim(world, { items: stacks(WATER, { name: 'iron_pickaxe', count: 1 }) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.reason).toBe('no_tool');
    expect(outcome.text).toMatch(/^obsidian 止まった no_tool: /u);
    expect(sim.bot.poured).toEqual([]);
    expect(Math.hypot(sim.bot.entity.position.x - 0.5, sim.bot.entity.position.z - 0.5)).toBeLessThan(0.1);
  });
  it('run 46 hold 6: says inventory_full before anything is poured or dug when no slot is free and no obsidian stack has room', async () => {
    const sim = makeHandsSim(world, { items: stacks(WATER, PICK) });
    for (let slot = 9; slot <= 44; slot++) sim.bot.inventory.slots[slot] = { name: slot === 20 ? 'obsidian' : 'dirt', count: slot === 20 ? 64 : 1 } as never;
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.reason).toBe('inventory_full');
    expect(outcome.text).toMatch(/^obsidian 止まった inventory_full: 持ち物が満杯（36\/36）で黒曜石を拾えない。黒曜石 \d+ 個・水の注ぎ \d+ 回・立ち直し \d+ 回。drop で空ける/u);
    expect(sim.bot.poured).toEqual([]);
    expect(sim.bot.dugBlocks ?? []).toEqual([]);
    expect(Math.hypot(sim.bot.entity.position.x - 0.5, sim.bot.entity.position.z - 0.5)).toBeLessThan(0.1);
    // a stack of obsidian with room takes more: the pack is not full for it
    const room = makeHandsSim(world, { items: stacks(WATER, PICK) });
    for (let slot = 9; slot <= 44; slot++) room.bot.inventory.slots[slot] = { name: slot === 20 ? 'obsidian' : 'dirt', count: slot === 20 ? 10 : 1 } as never;
    const second = await drive(room, run(room, { at: [at(8, 63, 0)] }));
    expect(second.reason).not.toBe('inventory_full');
  });
  it('says no_lava when the cell named is not a lava source (flowing lava, stone, a cell not loaded)', async () => {
    const flowing: Layer = (x, y, z) => (x === 8 && y === 63 && z === 0 ? 'lava~3' : undefined);
    const sim = makeHandsSim(over(flat, flowing, lake()), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0), at(3, 63, 0), at(100, 63, 0)] }));
    expect(outcome.reason).toBe('no_lava');
    expect(outcome.text).toMatch(/^obsidian 止まった no_lava: /u);
    expect(outcome.text).toContain('流れ 3');
    expect(outcome.text).toContain('stone');
    expect(outcome.text).toContain('未ロード');
  });
  it('does not try in the Nether, where the water steams away (stuck, said)', async () => {
    const sim = makeHandsSim(world, { items: stacks(WATER, PICK) });
    sim.bot.game.dimension = 'the_nether';
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.reason).toBe('stuck');
    expect(outcome.text).toMatch(/^obsidian 止まった stuck: ネザーでは水を注いでも蒸発して.*。黒曜石 \d+ 個・水の注ぎ \d+ 回・立ち直し \d+ 回/u);
    expect(sim.bot.poured).toEqual([]);
  });
  it('takes the sources that are lava and says which it skipped', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0), at(3, 63, 0)], count: 1 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('飛ばした (3,63,0) は stone');
  });
  it('fails with the count it got when the sources named run out before the count (no_lava, the number said)', async () => {
    // One lone source: nothing beside it for the pour to set.
    const sim = makeHandsSim(over(flat, box('lava', 8, 8, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)], count: 2 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no_lava');
    expect(outcome.text).toContain('使い切った');
    expect(outcome.text).toContain('2 個のうち 1 個');
    expect(sim.count('obsidian')).toBe(1);
    expect(sim.count('water_bucket')).toBe(1);
  });
});

describe('obsidian: its limits, and the act round it', () => {
  it('accepts 24 distinct cells at the primitive boundary and refuses 25', async () => {
    const cells = Array.from({ length: 25 }, (_, i) => at(i, 63, 0));
    const sim = makeHandsSim(flat, { items: stacks(WATER, PICK) });
    expect((await run(sim, { at: cells.slice(0, 24), seconds: 300 })).reason).toBe('no_lava');
    expect((await run(sim, { at: cells, seconds: 300 })).reason).toBe('invalid_input');
    expect(sim.bot.poured).toHaveLength(0);
  });

  it('collects 22 in one act with seconds=300, beyond both the old hand and act deadlines', async () => {
    const cells = Array.from({ length: 22 }, (_, i) => at(8 + i % 6, 63, Math.floor(i / 6)));
    const sim = makeHandsSim(over(flat, box('lava', 8, 13, 63, 63, 0, 3)), { items: stacks(WATER, PICK) });
    expect(new Act(sim.bot).maxDurationMs).toBeGreaterThanOrEqual(320_000);
    const began = Date.now();
    const acting = runAct(sim.bot, ACT_HANDS.parse([{ do: 'obsidian', at: cells, seconds: 300 }]), undefined, undefined, { tickMs: 50 });
    const result: any = JSON.parse((await drive(sim, acting)).result);
    expect(result.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(22);
    expect(Date.now() - began).toBeGreaterThan(180_000);
    expect(Date.now() - began).toBeLessThan(320_000);
    expect(sim.count('water_bucket')).toBe(1);
    // The water can also set the two cells the head did not name (1111: those are dug on as the flow's own, within the count): 22 in all, all obsidian, none outside the lake.
    expect(sim.bot.dugBlocks).toHaveLength(22);
    expect(sim.bot.dugBlocks.every((entry: string) => /^obsidian@(\d+),63,(\d)$/u.test(entry))).toBe(true);
    expect(sim.bot.poured.length).toBeLessThan(cells.length);
  }, 120_000);

  it('keeps an explicit parent time limit even for a 300 s obsidian hand', async () => {
    const cells = Array.from({ length: 9 }, (_, i) => at(8 + i % 3, 63, Math.floor(i / 3)));
    const sim = makeHandsSim(over(flat, box('lava', 8, 10, 63, 63, 0, 2)), { items: stacks(WATER, PICK) });
    const acting = runAct(sim.bot, ACT_HANDS.parse([{ do: 'obsidian', at: cells, seconds: 300 }]), undefined, undefined, { tickMs: 50, maxMs: 20_000 });
    const result: any = JSON.parse((await drive(sim, acting)).result);
    expect(result.ok).toBe(false);
    expect(sim.count('obsidian')).toBeLessThan(9);
  });

  it('stops at its own time (limit_time) with the water back in the bucket', async () => {
    // The shore is a long walk off and the limit is 5 s.
    const sim = makeHandsSim(over(flat, lake(30, 36, -4, 4)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(30, 63, 0)], seconds: 5 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('limit_time');
    expect(outcome.text).toMatch(/^obsidian 止まった limit_time: /u);
    expect(sim.count('water_bucket')).toBe(1);
  });

  it('takes the water back and the drop even when its own time runs out in the middle of the dig (a few seconds of grace, said by the line)', async () => {
    // 5 s is spent by the walk, the pour and the wait; the dig of the obsidian (9.4 s) is not cut: the bucket and the drop are still taken.
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)], seconds: 5 }));
    expect(sim.count('water_bucket')).toBe(1);
    expect(sim.count('obsidian')).toBe(1);
    expect(outcome.ok).toBe(true);
  });

  it('is cut when the act is cancelled (a StepStopped goes up, nothing more is poured or dug)', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const controller = new AbortController();
    const hand = run(sim, { at: [at(8, 63, 0)] }, controller);
    let poured = 0;
    const outcome = await drive(sim, hand.then(() => null, error => error), () => {
      if (!poured && sim.bot.poured.length) { poured = sim.bot.poured.length; controller.abort('cancelled'); }
    });
    expect(outcome).toBeInstanceOf(StepStopped);
    const dugAtCut = sim.bot.dugBlocks.length;
    await settle(sim, 3000);
    expect(sim.bot.dugBlocks.length).toBe(dugAtCut);
    expect(sim.bot.poured).toHaveLength(poured);
  });

  it('runs inside an act: the line is the hand\'s own, the act is ok, and a wrong field is refused with the head\'s words', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const acting = runAct(sim.bot, ACT_HANDS.parse([{ do: 'obsidian', at: [at(8, 63, 0)], count: 1, seconds: 60 }]), undefined, undefined, { tickMs: 50 });
    const result: any = JSON.parse((await drive(sim, acting)).result);
    expect(result.ok).toBe(true);
    expect(result.lines[0].line).toMatch(/^obsidian 済 黒曜石 1 個・水の注ぎ 1 回・立ち直し [01] 回・水回収済（\d+\.\d秒）$/u);

    // The cells may be counted from the feet (rel).
    const relative = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const rel: any = JSON.parse((await drive(relative, runAct(relative.bot, ACT_HANDS.parse([{ do: 'obsidian', at: [{ x: 8, y: -1, z: 0 }], rel: true }]), undefined, undefined, { tickMs: 50 }))).result);
    expect(rel.ok).toBe(true);
    expect(relative.count('obsidian')).toBe(1);

    const refused = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const bad: any = JSON.parse((await drive(refused, runAct(refused.bot, ACT_HANDS.parse([{ do: 'obsidian', at: [at(8, 63, 0)], item: 'water_bucket' }]), undefined, undefined, { tickMs: 50 }))).result);
    expect(bad.ok).toBe(false);
    expect(bad.lines[0].line).toMatch(/^obsidian 止まった invalid_input: item は使えない/u);

    const failed = makeHandsSim(over(flat, lake()), { items: stacks(PICK) });
    const stopped: any = JSON.parse((await drive(failed, runAct(failed.bot, ACT_HANDS.parse([{ do: 'obsidian', at: [at(8, 63, 0)] }, { do: 'wait', seconds: 1 }]), undefined, undefined, { tickMs: 50 }))).result);
    expect(stopped.ok).toBe(false);
    expect(stopped.stoppedBy).toBe('failure');
    expect(stopped.lines[0].status).toBe('stopped');
    expect(stopped.lines[0].line).toMatch(/^obsidian 止まった no_bucket: /u);
    expect(stopped.lines[1].status).toBe('skipped');
  });
});

describe('obsidian: the plan and the head\'s ranges', () => {
  it('goes through the skill catalog schema subset (no pattern, no refs) with the new fields in it', () => {
    const schema = normalizeSkillSchema((zodToJsonSchema as any)(z.object({ hands: ACT_HANDS }), { $refStrategy: 'none' }));
    const fields = schema.properties.hands.items.properties;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['axis', 'enter', 'canPlace', 'maxPlace']));
    expect(fields.axis.enum).toEqual(['x', 'z']);
    expect(fields.do.enum).toEqual(expect.arrayContaining(['obsidian', 'portal']));
    expect(JSON.stringify(schema).length).toBeLessThan(16_000);
  });
  it('finds the cells the water reaches the lava from: beside it on the floor (flow) and, with a wall, over it (direct)', () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const read = bodyReader(sim.bot);
    const spots = pourSpots(read, at(8, 63, 0));
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every(spot => spot.kind === 'flow')).toBe(true);
    expect(spots.some(spot => spot.pour.x === 7 && spot.pour.y === 64 && spot.pour.z === 0 && spot.side === 'down')).toBe(true);
    // A block beside the cell over the lava makes it a direct pour.
    sim.world.set(8, 64, -1, 'stone');
    const walled = pourSpots(read, at(8, 63, 0));
    expect(walled.some(spot => spot.kind === 'direct' && spot.pour.x === 8 && spot.pour.y === 64 && spot.pour.z === 0 && spot.side === 'north')).toBe(true);
  });

  it('plans a footing only when it may lay one: a cell with no floor beside a stand becomes one', () => {
    // The plateau ends at x=3; the lip x=7 and the lake beyond. With nothing laid no place reaches; with a footing the cell x=4 does.
    const gap: Layer = box('air', 4, 6, 50, FLOOR - 1, -20, 20);
    const sim = makeHandsSim(over(ground(14), gap, lake()), { items: stacks(WATER, PICK) });
    const read = bodyReader(sim.bot);
    const without = planPours(read, at(8, 63, 0), { from: { x: 3, y: 64, z: 0 }, excluded: new Set(), footingOk: false });
    const withFooting = planPours(read, at(8, 63, 0), { from: { x: 3, y: 64, z: 0 }, excluded: new Set(), footingOk: true });
    expect(without.some(plan => plan.stand.x <= 3)).toBe(false);
    const footed = withFooting.find(plan => plan.footing);
    expect(footed).toBeDefined();
    expect(footed!.footing!.from).toEqual({ x: 3, y: 64, z: 0 });
    expect(footed!.stand.x).toBe(4);
    expect(footed!.footing!.floor).toEqual({ x: 4, y: 63, z: 0 });
  });

  it('has the new ranges (at 1 to 24, seconds 5 to 300, count 1 to 64)', () => {
    const ok = () => true;
    const hand = (extra: Record<string, unknown> = {}) => ({ do: 'obsidian', at: [{}], ...extra });
    expect(obsidianProblem(hand({ count: 3, seconds: 60, canPlace: ['cobblestone'], maxPlace: 4, rel: true, note: 'x', onFail: 'stop' }), ok)).toBeNull();
    expect(obsidianProblem({ do: 'obsidian' }, ok)).toContain('at');
    expect(obsidianProblem(hand({ at: new Array(24).fill({}), seconds: 300 }), ok)).toBeNull();
    expect(obsidianProblem(hand({ at: new Array(25).fill({}) }), ok)).toContain('24 つまで');
    const cells = Array.from({ length: 24 }, (_, i) => at(i, 63, 0));
    expect(ACT_HANDS.safeParse([{ do: 'obsidian', at: cells, seconds: 300 }]).success).toBe(true);
    expect(ACT_HANDS.safeParse([{ do: 'obsidian', at: [...cells, at(24, 63, 0)] }]).success).toBe(false);
    expect(ACT_HANDS.safeParse([{ do: 'dig', at: cells.slice(0, 16) }]).success).toBe(true);
    expect(ACT_HANDS.safeParse([{ do: 'dig', at: cells.slice(0, 17) }]).success).toBe(false);
    expect(obsidianProblem(hand({ item: 'bucket' }), ok)).toContain('item は使えない');
    expect(obsidianProblem(hand({ seconds: 5 }), ok)).toBeNull();
    expect(obsidianProblem(hand({ seconds: 121 }), ok)).toBeNull();
    expect(obsidianProblem(hand({ seconds: 4 }), ok)).toContain('seconds は 5〜300');
    expect(obsidianProblem(hand({ seconds: 301 }), ok)).toContain('seconds は 5〜300');
    expect(obsidianProblem(hand({ count: 65 }), ok)).toContain('count は 1〜64');
    expect(obsidianProblem(hand({ canPlace: ['Cobble Stone'] }), ok)).toContain('canPlace');
    expect(obsidianProblem(hand(), () => false)).toContain('読めない');
  });
});

describe('obsidian: a lava source shut in rock (run 47, hold 7)', () => {
  // A source with rock on every face (and the ground to the surface over it): the plan had no cell to pour into and the hand ended at once, "unreachable", 0 pours. The way is dug in from the side
  // at the level over the source, and the cell over the source last; the water poured there makes the obsidian.
  const shut = (): Ground => over(flat, box('lava', 10, 10, 62, 62, 0, 0));
  it('digs a way in and a face to pour on, pours, mines the obsidian and takes the water back', async () => {
    const sim = makeHandsSim(shut(), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(10, 62, 0)], seconds: 120 }));
    expect(outcome.text).toMatch(/^obsidian 済 黒曜石 1 個/u);
    expect(outcome.text).toContain('岩に囲まれていたので');
    expect(outcome.ok).toBe(true);
  });
  it('takes maxDig from the hand (1 to 100) and refuses a value outside it', () => {
    const ok = (hand: Record<string, unknown>) => obsidianProblem({ do: 'obsidian', at: [at(1, 2, 3)], ...hand }, () => true);
    expect(ok({ maxDig: 30 })).toBeNull();
    expect(ok({ maxDig: 100 })).toBeNull();
    expect(ok({ maxDig: 0 })).toMatch(/maxDig は 1〜100/u);
    expect(ok({ maxDig: 101 })).toMatch(/maxDig は 1〜100/u);
    expect(ok({ maxDig: 2.5 })).toMatch(/maxDig は 1〜100/u);
  });
  it('says how many digs the way needs when maxDig is too small (maxDig=N would make it), and takes the larger limit', async () => {
    const deep = (): Ground => over(flat, box('lava', 10, 10, 58, 58, 0, 0));
    const small = makeHandsSim(deep(), { items: stacks(WATER, PICK) });
    const refused = await drive(small, run(small, { at: [at(10, 58, 0)], seconds: 60, maxDig: 2 }));
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/^obsidian 止まった unreachable: .* まで掘ると 掘る所が \d+ 要り、上限 2 を超える。黒曜石 \d+ 個・水の注ぎ \d+ 回・立ち直し \d+ 回。maxDig=\d+ なら作れる/u);
    expect(refused.text).not.toContain('面を作った');
    const wide = makeHandsSim(deep(), { items: stacks(WATER, PICK) });
    const made = await drive(wide, run(wide, { at: [at(10, 58, 0)], seconds: 120, maxDig: 60 }));
    expect(made.text).toMatch(/^obsidian 済 黒曜石 1 個/u);
  });
  it('says which cells shut it in when nothing may be dug (canDig names nothing that is there)', async () => {
    const sim = makeHandsSim(shut(), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(10, 62, 0)], seconds: 60, canDig: ['sand'] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^obsidian 止まった unreachable: \(10,62,0\) は岩に囲まれ.*。黒曜石 \d+ 個・水の注ぎ \d+ 回・立ち直し \d+ 回。.*stone.*掘って面と立ち位置を作る道も無い/u);
    expect(sim.bot.dugBlocks ?? []).toEqual([]);
  });
});

describe('obsidian: what one pour sets beside the named source, and the obsidian over a shut source (1111, run 7)', () => {
  it('digs the next source that the same pour set when only one was named and count asks for two (C)', async () => {
    const sim = makeHandsSim(over(flat, box('lava', 8, 9, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)], count: 2, seconds: 120 }));
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(2);
    expect(outcome.text).toContain('水が固めた隣の黒曜石 1 個');
    expect(sim.bot.poured).toHaveLength(1);
    expect(sim.count('water_bucket')).toBe(1);
  }, 120_000);

  it('does not dig the next source beyond the count asked for (C)', async () => {
    const sim = makeHandsSim(over(flat, box('lava', 8, 9, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)], count: 1, seconds: 120 }));
    expect(outcome.ok).toBe(true);
    expect(sim.count('obsidian')).toBe(1);
  }, 120_000);

  it('opens a source whose cell over it is already obsidian, taking that obsidian too (A)', async () => {
    const sim = makeHandsSim(over(flat, box('lava', 10, 10, 62, 62, 0, 0), box('obsidian', 10, 10, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(10, 62, 0)], seconds: 120 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('源の真上の黒曜石');
    expect(sim.count('obsidian')).toBeGreaterThanOrEqual(2);
    expect(sim.count('water_bucket')).toBe(1);
  }, 120_000);

  it('puts the reason before the numbers in a stop line, the long rest after them (E)', async () => {
    const sim = makeHandsSim(over(flat, box('lava', 10, 10, 62, 62, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(10, 62, 0)], seconds: 60, canDig: ['sand'] }));
    expect(outcome.ok).toBe(false);
    const text = outcome.text;
    expect(text).toMatch(/^obsidian 止まった unreachable: .+。黒曜石 \d+ 個・水の注ぎ \d+ 回・立ち直し \d+ 回/u);
    expect(text.indexOf('岩に囲まれ')).toBeLessThan(text.indexOf('黒曜石 0 個'));
  });

  it('keeps the real seconds of each wait in the black box, not in the act line', async () => {
    const notes: Array<[string, Record<string, unknown>]> = [];
    const sim = makeHandsSim(over(flat, lake(8, 9, 0, 0)), { items: stacks(WATER, PICK) });
    const { installBlackBox } = await import('../../src/services/minebot/utils/blackbox.js');
    const box1 = installBlackBox(sim.bot, '/tmp/bb-obsidian-test');
    const note = box1.note.bind(box1);
    box1.note = (kind: string, data: Record<string, unknown> = {}) => { notes.push([kind, data]); note(kind, data); };
    await drive(sim, run(sim, { at: [at(8, 63, 0), at(9, 63, 0)], seconds: 120 }));
    expect(notes.filter(([kind]) => kind === 'obsidian_wait').length).toBeGreaterThan(0);
    expect(notes.find(([kind]) => kind === 'obsidian_wait')![1]).toMatchObject({ label: expect.any(String), ms: expect.any(Number), cap: expect.any(Number) });
  }, 120_000);
});

describe('obsidian: the numbers come first in a stop line (run 48, hold 3)', () => {
  it('names the count, the pours and the stands before anything long, so that the 160 characters of a line keep them', async () => {
    const sim = makeHandsSim(over(flat, box('lava', 8, 8, 63, 63, 0, 0)), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0), at(40, 63, 0)], count: 3, seconds: 120 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^obsidian 止まった \w+: .+。黒曜石 1 個・水の注ぎ 1 回・立ち直し \d+ 回/u);
    expect(outcome.text).toContain('（3 個のうち 1 個）');
    expect(outcome.text.slice(0, 160)).toContain('黒曜石 1 個');
  });
});

describe('obsidian: the drop kept from lava, and no block on the water for nothing (run 8, 11/13)', () => {
  const DIRT: Stack = { name: 'dirt', count: 8 };
  it('puts out the lava beside set obsidian with a block it may lay (canPlace), counted in maxPlace, and pours no water for it', async () => {
    const sim = makeHandsSim(over(flat, box('obsidian', 8, 8, 63, 63, 0, 0), box('lava', 9, 9, 63, 63, 0, 0)), { items: stacks(PICK, DIRT) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)], canPlace: ['dirt'], maxPlace: 2 }));
    expect(outcome.ok).toBe(true);
    expect(sim.bot.placedBlocks).toEqual(['dirt@9,63,0']);
    expect(sim.bot.poured).toEqual([]);
    expect(sim.count('obsidian')).toBe(1);
    expect(outcome.text).toContain('足場 1 個');
  });
  it('does not lay a block it was not let lay: with no canPlace and no water, the obsidian beside lava is not dug and that is said', async () => {
    const sim = makeHandsSim(over(flat, box('obsidian', 8, 8, 63, 63, 0, 0), box('lava', 9, 9, 63, 63, 0, 0)), { items: stacks(PICK, DIRT) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('lava_danger');
    expect(outcome.text).toContain('落とし物が溶岩で焼けるので掘らなかった');
    expect(sim.bot.placedBlocks).toEqual([]);
    expect(sim.nameAt(8, 63, 0)).toBe('obsidian');
    expect(counts(outcome)!.restands).toBe(0);
    expect(outcome.text).toContain('固まって掘れていない黒曜石 1 マス・水入りバケツ なし');
  });
  it('with lava right under it and neither block nor water, never digs it silently; the safe one is dug first', async () => {
    const sim = makeHandsSim(over(flat, box('obsidian', 8, 9, 63, 63, 0, 0), box('lava', 9, 9, 62, 62, 0, 0)), { items: stacks(PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(9, 63, 0), at(8, 63, 0)], count: 2 }));
    expect(sim.bot.dugBlocks[0]).toContain('8,63,0');
    expect(sim.nameAt(9, 63, 0)).toBe('obsidian');
    expect(sim.count('obsidian')).toBe(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('lava_danger');
  });
  it('lays nothing on its own water over the hole (the cover is the hand\'s), with blocks in the pack', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK, DIRT) });
    const first = await drive(sim, run(sim, { at: [at(8, 63, 0)] }));
    expect(first.ok).toBe(true);
    expect(sim.bot.placedBlocks).toEqual([]);
    expect(first.text).not.toContain('裏の水');
    expect(sim.count('water_bucket')).toBe(1);
  });
});
