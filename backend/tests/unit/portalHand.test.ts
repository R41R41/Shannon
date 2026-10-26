import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim, type Stack } from '../helpers/handsSim.js';
import { portal, portalCells, portalProblem, type PortalArgs } from '../../src/services/minebot/utils/primitives/portal.js';
import { StepStopped, type StepContext } from '../../src/services/minebot/utils/primitives/common.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';

// The hand `portal` against the real client physics (prismarine-physics) and the real route search and executor (mineflayer-pathfinder), in small
// worlds (tests/helpers/handsSim): the body is moved 50 ms of physics for every 50 ms of fake time; laying a block puts none where the body stands,
// digging takes the block's time and is told by the server's packet, flint and steel lights the cell beside the face it is used on, a fire in an empty
// 2 by 3 frame of obsidian becomes the nether portal, and a body that stands in the portal for 4 s is in the Nether. The feet stand at y=64 on stone
// below it. No server and no API.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
type Layer = (x: number, y: number, z: number) => string | null | undefined;
const flat: Ground = (x, y, z) => (Math.abs(x) > 40 || Math.abs(z) > 40 ? null : y < FLOOR ? 'stone' : 'air');
const over = (base: Ground, ...layers: Layer[]): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  return base(x, y, z);
};
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Layer => (x, y, z) =>
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? name : undefined);
const ctxOf = (sim: HandsSim, controller = new AbortController()): StepContext => ({
  bot: sim.bot, stop: controller.signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 },
});
async function drive<T>(sim: HandsSim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 400_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const stacks = (...list: Stack[]) => list;
const OBSIDIAN = (count = 10): Stack => ({ name: 'obsidian', count });
const FLINT: Stack = { name: 'flint_and_steel', count: 1 };
const COBBLE = (count = 8): Stack => ({ name: 'cobblestone', count });
const at = (x: number, y: number, z: number) => ({ x, y, z });
const run = (sim: HandsSim, args: Partial<PortalArgs>, controller?: AbortController) =>
  portal(ctxOf(sim, controller), { at: at(10, 65, 10), axis: 'x', canPlace: ['cobblestone'], maxPlace: 8, ...args });
/** The names in the cells of a frame. */
const frameNames = (sim: HandsSim, origin = at(10, 65, 10), axis: 'x' | 'z' = 'x') =>
  portalCells(origin, axis).frame.map(cell => sim.nameAt(cell.x, cell.y, cell.z));
const interiorNames = (sim: HandsSim, origin = at(10, 65, 10), axis: 'x' | 'z' = 'x') =>
  portalCells(origin, axis).interior.map(cell => sim.nameAt(cell.x, cell.y, cell.z));

describe('portal: the frame on flat ground', () => {
  it('builds the ten, lights them and goes in: the scaffolds laid for the first block of each column are dug out again', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, {}));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^portal 済 枠 10 個（置いた 10）・足場 3 個（外した 3）・点火・入った（次元 the_nether）/u);
    expect(outcome.data?.crossedDimension).toBe(true);
    expect(frameNames(sim).every(name => name === 'obsidian')).toBe(true);
    expect(interiorNames(sim).every(name => name === 'nether_portal')).toBe(true);
    // The scaffolds (the corners) are gone, and nothing but the frame stands round it.
    for (const corner of portalCells(at(10, 65, 10), 'x').corners) expect(sim.nameAt(corner.x, corner.y, corner.z)).toBe('air');
    expect(sim.count('obsidian')).toBe(0);
    expect(sim.count('flint_and_steel')).toBe(1);
    expect(sim.bot.lit).toHaveLength(1);
    expect(sim.bot.game.dimension).toBe('the_nether');
    // The cobblestone put down was only the three scaffolds (dug by hand: nothing dropped, as no pickaxe was held).
    expect(sim.bot.placedBlocks.filter((line: string) => line.startsWith('cobblestone@'))).toHaveLength(3);
    expect(sim.bot.placedBlocks.filter((line: string) => line.startsWith('obsidian@'))).toHaveLength(10);
  });

  it('builds the frame in the z plane too, and stays out of the portal when enter is false', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const origin = at(12, 65, 8);
    const outcome = await drive(sim, run(sim, { at: origin, axis: 'z', enter: false }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^portal 済 枠 10 個（置いた 10）・足場 3 個（外した 3）・点火・入らなかった/u);
    expect(frameNames(sim, origin, 'z').every(name => name === 'obsidian')).toBe(true);
    expect(interiorNames(sim, origin, 'z').every(name => name === 'nether_portal')).toBe(true);
    expect(sim.bot.game.dimension).toBe('overworld');
    expect(outcome.data?.crossedDimension).toBeUndefined();
  });

  it('builds only what is missing when the frame is half there (and the same blocks are not laid twice)', async () => {
    const half: Layer = (x, y, z) => (z === 10 && ((y === 64 && (x === 10 || x === 11)) || (x === 9 && y >= 65 && y <= 67)) ? 'obsidian' : undefined);
    const sim = makeHandsSim(over(flat, half), { items: stacks(OBSIDIAN(5), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, { enter: false }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^portal 済 枠 10 個（置いた 5）/u);
    expect(sim.bot.placedBlocks.filter((line: string) => line.startsWith('obsidian@'))).toHaveLength(5);
    expect(sim.count('obsidian')).toBe(0);
    expect(interiorNames(sim).every(name => name === 'nether_portal')).toBe(true);
  });

  it('goes into a portal that is already lit, laying and lighting nothing', async () => {
    const lit = makeHandsSim(flat, { items: stacks(FLINT) });
    const cells = portalCells(at(10, 65, 10), 'x');
    for (const cell of cells.frame) lit.world.set(cell.x, cell.y, cell.z, 'obsidian');
    for (const cell of cells.interior) lit.world.set(cell.x, cell.y, cell.z, 'nether_portal~0');
    const outcome = await drive(lit, run(lit, {}));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^portal 済 枠 10 個・もう点いていた・入った（次元 the_nether）/u);
    expect(lit.bot.placedBlocks).toEqual([]);
    expect(lit.bot.lit).toEqual([]);
  });
});

describe('portal: ground that is not level', () => {
  it('lays the bottom row across a drop (each block against the one before it) and a scaffold column for the far side', async () => {
    // From x=11 the ground is two lower: the right half of the bottom row and the right column hang over a pit.
    const pit: Layer = (x, y) => (x >= 11 && y >= 62 && y < FLOOR ? 'air' : undefined);
    const sim = makeHandsSim(over(flat, pit), { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, { enter: false }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^portal 済 枠 10 個（置いた 10）・足場 \d 個（外した \d）・点火/u);
    expect(frameNames(sim).every(name => name === 'obsidian')).toBe(true);
    expect(interiorNames(sim).every(name => name === 'nether_portal')).toBe(true);
    // The pit is as it was: no scaffold left in it.
    for (const x of [11, 12]) for (const y of [62, 63]) expect(sim.nameAt(x, y, 10)).toBe('air');
  });

  it('reaches a frame set high over the ground: a chain of scaffold blocks up to the bottom row, a pillar under the feet for the top, all but the pillar taken out', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE(24), { name: 'stone_pickaxe', count: 1 }) });
    const origin = at(10, 69, 10);
    const outcome = await drive(sim, run(sim, { at: origin, enter: false, maxPlace: 24 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/^portal 済 枠 10 個（置いた 10）・足場 (\d+) 個（外した \1）・柱 \d+ 段（残した）・点火/u);
    expect(frameNames(sim, origin).every(name => name === 'obsidian')).toBe(true);
    expect(interiorNames(sim, origin).every(name => name === 'nether_portal')).toBe(true);
    // Every scaffold is gone: the cobblestone left in the world is the pillar, as many as the levels the line says were left standing.
    const left = [...sim.world.changed].filter(([, name]) => name === 'cobblestone');
    expect(left.length).toBe(Number(/柱 (\d+) 段/u.exec(outcome.text)![1]));
  });
});

describe('portal: what it refuses', () => {
  it('says no_obsidian with the number it holds (and lays nothing)', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(9), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, {}));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no_obsidian');
    expect(outcome.text).toMatch(/^portal 止まった no_obsidian: obsidian を 9 個しか持っていない（枠に足りないのは 10 個/u);
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('counts what the frame already has against what it holds', async () => {
    const two: Layer = (x, y, z) => (z === 10 && y === 64 && (x === 10 || x === 11) ? 'obsidian' : undefined);
    const sim = makeHandsSim(over(flat, two), { items: stacks(OBSIDIAN(7), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, {}));
    expect(outcome.reason).toBe('no_obsidian');
    expect(outcome.text).toContain('7 個しか持っていない（枠に足りないのは 8 個');
  });
  it('says no_flint before it lays a block', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), COBBLE()) });
    const outcome = await drive(sim, run(sim, {}));
    expect(outcome.reason).toBe('no_flint');
    expect(outcome.text).toMatch(/^portal 止まった no_flint: /u);
    expect(sim.bot.placedBlocks).toEqual([]);
  });
  it('says blocked with the cell when the frame or the inside is rock or water or lava, and does not break it', async () => {
    const rock = makeHandsSim(over(flat, box('stone', 11, 11, 66, 66, 10, 10)), { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const inFrame = await drive(rock, run(rock, {}));
    expect(inFrame.reason).toBe('blocked');
    expect(inFrame.text).toMatch(/^portal 止まった blocked: 内側の \(11,66,10\) が stone/u);
    const water = makeHandsSim(over(flat, box('water', 9, 9, 66, 66, 10, 10)), { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const wet = await drive(water, run(water, {}));
    expect(wet.reason).toBe('blocked');
    expect(wet.text).toContain('枠の (9,66,10) が water');
    expect(water.bot.placedBlocks).toEqual([]);
    expect(rock.bot.dugBlocks).toEqual([]);
  });
  it('says blocked, not a guess, when the first block of a column has nothing to be set against and no scaffold may be laid', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, { canPlace: undefined }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('blocked');
    expect(outcome.text).toMatch(/^portal 止まった blocked: 枠の \(9,65,10\) に当てる面が無い/u);
    expect(outcome.text).toContain('canPlace');
    // The bottom row (which has the ground to be set against) is laid; nothing else, and nothing dug.
    expect(sim.bot.placedBlocks).toHaveLength(2);
    expect(sim.bot.dugBlocks).toEqual([]);
  });
  it('says ignite_failed with what it saw when the fire is lit and no portal comes (the server makes none)', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    // A server that burns the fire and makes no portal (a plane where portals do not form).
    sim.bot.activateBlock = async (block: any, direction: any) => {
      const cell = block.position.plus(direction);
      sim.world.set(cell.x, cell.y, cell.z, 'fire');
      sim.bot.lit.push(`${cell.x},${cell.y},${cell.z}`);
    };
    const outcome = await drive(sim, run(sim, {}));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('ignite_failed');
    expect(outcome.text).toMatch(/^portal 止まった ignite_failed: 火を点けたがポータルにならない（枠 10\/10、内側は /u);
    expect(outcome.text).toContain('fire');
    // The scaffolds were taken out first, the frame is whole.
    expect(frameNames(sim).every(name => name === 'obsidian')).toBe(true);
  });
});

describe('portal: its limits and the act round it', () => {
  it('stops at its own time (limit_time) with what it laid said', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const outcome = await drive(sim, run(sim, { seconds: 5, at: at(30, 65, 30) }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('limit_time');
    expect(outcome.text).toMatch(/^portal 止まった limit_time: /u);
    expect(outcome.text).toMatch(/枠 \d+\/10/u);
  });

  it('is cut when the act is cancelled', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const controller = new AbortController();
    const hand = run(sim, {}, controller);
    const result = await drive(sim, hand.then(() => null, error => error), () => { if (sim.bot.placedBlocks.length >= 2 && !controller.signal.aborted) controller.abort('cancelled'); });
    expect(result).toBeInstanceOf(StepStopped);
    // A block already on its way to the server lands (the sim, like the game, does not take it back); nothing is begun after.
    for (let t = 0; t < 500; t += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    const laid = sim.bot.placedBlocks.length;
    for (let t = 0; t < 2000; t += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(sim.bot.placedBlocks.length).toBe(laid);
  });

  it('runs inside an act: its line is the hand\'s own, the act ends ok in the other dimension, and a hand after it is not sent', async () => {
    const sim = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT, COBBLE()) });
    const acting = runAct(sim.bot, ACT_HANDS.parse([{ do: 'portal', at: [at(10, 65, 10)], axis: 'x', canPlace: ['cobblestone'], maxPlace: 6 }, { do: 'wait', seconds: 1 }]), undefined, undefined, { tickMs: 50 });
    const result: any = JSON.parse((await drive(sim, acting)).result);
    expect(result.ok).toBe(true);
    expect(result.lines[0].status).toBe('done');
    expect(result.lines[0].line).toMatch(/^portal 済 枠 10 個（置いた 10）・足場 3 個（外した 3）・点火・入った（次元 the_nether）/u);
    expect(result.lines[1].status).toBe('skipped');

    const refused = makeHandsSim(flat, { items: stacks(OBSIDIAN(), FLINT) });
    const bad: any = JSON.parse((await drive(refused, runAct(refused.bot, ACT_HANDS.parse([{ do: 'portal', at: [at(10, 65, 10)], axis: 'x', count: 3 }]), undefined, undefined, { tickMs: 50 }))).result);
    expect(bad.ok).toBe(false);
    expect(bad.lines[0].line).toMatch(/^portal 止まった invalid_input: count は使えない/u);

    const few = makeHandsSim(flat, { items: stacks(OBSIDIAN(4), FLINT) });
    const stopped: any = JSON.parse((await drive(few, runAct(few.bot, ACT_HANDS.parse([{ do: 'portal', at: [at(10, 65, 10)], axis: 'x' }]), undefined, undefined, { tickMs: 50 }))).result);
    expect(stopped.ok).toBe(false);
    expect(stopped.stoppedBy).toBe('failure');
    expect(stopped.lines[0].line).toMatch(/^portal 止まった no_obsidian: /u);
  });
});

describe('portal: the cells and the head\'s ranges', () => {
  it('has the frame as ten cells round a two by three inside, corners left out, in either plane', () => {
    const x = portalCells(at(10, 65, 10), 'x');
    expect(x.interior).toHaveLength(6);
    expect(x.frame).toHaveLength(10);
    expect(x.frame).toContainEqual(at(10, 64, 10));
    expect(x.frame).toContainEqual(at(11, 68, 10));
    expect(x.frame).toContainEqual(at(9, 65, 10));
    expect(x.frame).toContainEqual(at(12, 67, 10));
    expect(x.frame).not.toContainEqual(at(9, 64, 10));
    expect(x.corners).toContainEqual(at(12, 68, 10));
    const z = portalCells(at(10, 65, 10), 'z');
    expect(z.frame).toContainEqual(at(10, 65, 9));
    expect(z.frame).toContainEqual(at(10, 67, 12));
    expect(z.interior).toContainEqual(at(10, 67, 11));
  });
  it('has the head\'s fields and ranges (needs at and axis; may block, enter, canPlace, maxPlace, seconds; at exactly one, seconds 5 to 120)', () => {
    const ok = () => true;
    const hand = (extra: Record<string, unknown> = {}) => ({ do: 'portal', at: [{}], axis: 'x', ...extra });
    expect(portalProblem(hand({ block: 'obsidian', enter: false, canPlace: ['cobblestone'], maxPlace: 5, seconds: 60, rel: true }), ok)).toBeNull();
    expect(portalProblem({ do: 'portal', axis: 'x' }, ok)).toContain('at は枠の内側の左下のマス 1 つ');
    expect(portalProblem(hand({ at: [{}, {}] }), ok)).toContain('1 つ');
    expect(portalProblem({ do: 'portal', at: [{}] }, ok)).toContain('axis');
    expect(portalProblem(hand({ axis: 'y' }), ok)).toContain('axis');
    expect(portalProblem(hand({ count: 2 }), ok)).toContain('count は使えない');
    expect(portalProblem(hand({ seconds: 130 }), ok)).toContain('seconds は 5〜120');
    expect(portalProblem(hand(), () => false)).toContain('読めない');
  });
});
