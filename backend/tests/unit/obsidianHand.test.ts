import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim, type Stack } from '../helpers/handsSim.js';
import { obsidian, obsidianProblem, planPours, pourSpots, type ObsidianArgs } from '../../src/services/minebot/utils/primitives/obsidian.js';
import { StepStopped, type StepContext, type StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { bodyReader, feetCell } from '../../src/services/minebot/utils/localMap.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
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
    expect(outcome.text).toMatch(/^obsidian 止まった inventory_full: 持ち物が満杯（36\/36）で黒曜石を拾えない。drop で空ける/u);
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
    expect(outcome.text).toMatch(/^obsidian 止まった stuck: ネザーでは水を注いでも蒸発して/u);
    expect(sim.bot.poured).toEqual([]);
  });
  it('takes the sources that are lava and says which it skipped', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(8, 63, 0), at(3, 63, 0)] }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('飛ばした (3,63,0) は stone');
  });
  it('fails with the count it got when the sources named run out before the count (no_lava, the number said)', async () => {
    const sim = makeHandsSim(over(flat, lake()), { items: stacks(WATER, PICK) });
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

  it('has the head\'s fields and ranges (needs at; may count, seconds, canPlace, maxPlace; at 1 to 8, seconds 5 to 120, count 1 to 64)', () => {
    const ok = () => true;
    const hand = (extra: Record<string, unknown> = {}) => ({ do: 'obsidian', at: [{}], ...extra });
    expect(obsidianProblem(hand({ count: 3, seconds: 60, canPlace: ['cobblestone'], maxPlace: 4, rel: true, note: 'x', onFail: 'stop' }), ok)).toBeNull();
    expect(obsidianProblem({ do: 'obsidian' }, ok)).toContain('at');
    expect(obsidianProblem(hand({ at: new Array(9).fill({}) }), ok)).toContain('8 つまで');
    expect(obsidianProblem(hand({ item: 'bucket' }), ok)).toContain('item は使えない');
    expect(obsidianProblem(hand({ seconds: 4 }), ok)).toContain('seconds は 5〜120');
    expect(obsidianProblem(hand({ seconds: 121 }), ok)).toContain('seconds は 5〜120');
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
  it('says how many digs the way needs when maxDig is too small (maxDig=N would make it), and takes the larger limit', async () => {
    const deep = (): Ground => over(flat, box('lava', 10, 10, 58, 58, 0, 0));
    const small = makeHandsSim(deep(), { items: stacks(WATER, PICK) });
    const refused = await drive(small, run(small, { at: [at(10, 58, 0)], seconds: 60, maxDig: 2 }));
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/^obsidian 止まった unreachable: .* まで掘ると 掘る所が \d+ 要り、上限 2 を超える。maxDig=\d+ なら作れる/u);
    expect(refused.text).not.toContain('面を作った');
    const wide = makeHandsSim(deep(), { items: stacks(WATER, PICK) });
    const made = await drive(wide, run(wide, { at: [at(10, 58, 0)], seconds: 120, maxDig: 60 }));
    expect(made.text).toMatch(/^obsidian 済 黒曜石 1 個/u);
  });
  it('says which cells shut it in when nothing may be dug (canDig names nothing that is there)', async () => {
    const sim = makeHandsSim(shut(), { items: stacks(WATER, PICK) });
    const outcome = await drive(sim, run(sim, { at: [at(10, 62, 0)], seconds: 60, canDig: ['sand'] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^obsidian 止まった unreachable: \(10,62,0\) は岩に囲まれ（.*stone.*）、掘って面と立ち位置を作る道も無い/u);
    expect(sim.bot.dugBlocks ?? []).toEqual([]);
  });
});
