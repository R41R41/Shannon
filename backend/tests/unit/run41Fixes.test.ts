import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go, keepReads, worldWatchOf, type GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';
import { pillarUp, shortFloor } from '../../src/services/minebot/utils/primitives/pillarUp.js';
import { oreTwins } from '../../src/services/minebot/utils/primitives/mine.js';
import { fallsOntoBody } from '../../src/services/minebot/utils/fallingAbove.js';
import { chokes, inWall, wallCells } from '../../src/services/minebot/utils/wallReflex.js';
import { closedWord } from '../../src/services/minebot/utils/actReport.js';
import { feetCell } from '../../src/services/minebot/utils/localMap.js';
import type { StepContext, StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';

// Run 41 (2026-10-27), each stop replayed on its own ground in the lab (backend/scripts/lab/run-replay.sh, cases/run41.json): the go that said
// "no way" when its search ran out of time, the climb from a floor lower than the feet cell (an amethyst bud), the dig under gravel that buried
// the body, the suffocation nothing answered, and the ore named without its deep twin. Small worlds, the real physics and route search.
const FLOOR = 64;
const R = 40;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: Sim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'north', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

describe('run 41: the route search keeps what it read', () => {
  it('reads a cell once until the world changes there, and everything again when chunks come or go', () => {
    const host = new EventEmitter();
    const watch = worldWatchOf(host);
    let reads = 0;
    const movements = { getBlock: (pos: any, dx: number, dy: number, dz: number) => { reads++; return { name: 'stone', position: new Vec3(pos.x + dx, pos.y + dy, pos.z + dz) }; } };
    const name = keepReads(movements, watch);
    expect(name(1, 2, 3)).toBe('stone');
    expect(movements.getBlock({ x: 1, y: 1, z: 3 }, 0, 1, 0).name).toBe('stone');
    expect(name(1, 2, 3)).toBe('stone');
    expect(reads).toBe(1);
    host.emit('blockUpdate', { position: new Vec3(1, 2, 3) }, { position: new Vec3(1, 2, 3) });
    name(1, 2, 3);
    expect(reads).toBe(2);
    host.emit('blockUpdate', { position: new Vec3(9, 9, 9) }, { position: new Vec3(9, 9, 9) });
    name(1, 2, 3);
    expect(reads).toBe(2);
    host.emit('chunkColumnLoad', new Vec3(0, 0, 0));
    name(1, 2, 3);
    expect(reads).toBe(3);
  });

  it('does not keep a cell that is not loaded', () => {
    const watch = worldWatchOf(new EventEmitter());
    let reads = 0;
    const movements = { getBlock: () => { reads++; return { safe: false }; } };
    const name = keepReads(movements, watch);
    expect(name(0, 0, 0)).toBeNull();
    name(0, 0, 0);
    expect(reads).toBe(2);
  });
});

describe('run 41: a search that runs out of its time is not a dead end', () => {
  // The search is timed by the real clock here (performance is not faked): a few milliseconds a drawing through solid stone runs out.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('walks what it found when it comes nearer, and says search_timeout (never dead_end) when it cannot', async () => {
    // Solid stone from x=2 to x=30; the place is inside it, 24 cells off. The pickaxe may dig stone.
    const ground: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : x >= 2 && x <= 30 ? 'stone' : 'air');
    const sim = makeSim(ground, { items: [{ name: 'stone_pickaxe', count: 1 }], digMs: 50 });
    const args: GoArgs = { goals: [{ x: 26, y: FLOOR, z: 0 }], canDig: ['stone'], maxDig: 200, seconds: 120, searchMs: 15 };
    const outcome = await drive(sim, go(ctxOf(sim), args));
    expect(outcome.text).not.toMatch(/dead_end|行き止まり/u);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('search_timeout');
      expect(outcome.text).toMatch(/^go 止まった search_timeout: 道探しが [\d.]+ 秒で終わらない（道の有無は不明。[\d,]+ マス調べた/u);
      expect(closedWord('search_timeout')).toBe('時間切れ');
    }
    // Whatever the machine's speed, the body went into the rock (the part found was walked) or arrived.
    expect(sim.bot.dugBlocks.length).toBeGreaterThan(0);
  });
});

describe('run 41: a floor lower than the feet cell', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });
  // A bottom slab under the feet (its top 0.5 up its cell): the feet stand half a block under the feet cell's floor.
  const slab = (base: Ground): Ground => (x, y, z) => (x === 0 && z === 0 && y === FLOOR ? 'smooth_stone_slab' : base(x, y, z));

  it('pillarUp says low_floor before the jump, with the whole floor beside it', async () => {
    const sim = makeSim(slab(flat), { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 8 }] });
    for (let i = 0; i < 20; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(sim.bot.entity.position.y).toBeCloseTo(FLOOR + 0.5, 2);
    const feet = feetCell(sim.bot)!;
    expect(shortFloor(sim.bot, feet)).toMatchObject({ name: 'smooth_stone_slab', top: 0.5 });
    const outcome = await drive(sim, pillarUp(ctxOf(sim), { n: 1, block: 'cobblestone' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('low_floor');
    expect(outcome.text).toMatch(/足元 \(0,64,0\) の smooth_stone_slab は高さ 0\.50 で、足が 0\.50 低い。.*隣の丸ごとの床 \(-?\d,65,-?\d\) へずれてから登る/u);
    expect(closedWord('low_floor')).toBe('足場が無い');
    expect(sim.bot.placedBlocks).toEqual([]);
  });

  it('go climbs from beside it: it steps onto a whole floor first, then pillars up', async () => {
    // A cliff 3 high at x>=2; the place is on top. The body starts on the slab.
    const cliff: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone' : x >= 2 && y < FLOOR + 3 ? 'stone' : 'air');
    const sim = makeSim(slab(cliff), { start: [0.5, FLOOR, 0.5], items: [{ name: 'cobblestone', count: 16 }] });
    for (let i = 0; i < 20; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    const outcome: StepOutcome = await drive(sim, go(ctxOf(sim), { goals: [{ x: 3, y: FLOOR + 4, z: 0 }], canPlace: ['cobblestone'], range: 1, seconds: 60 }));
    expect(outcome.text).not.toMatch(/跳びの最高|low_floor/u);
    expect(outcome.ok).toBe(true);
  });
});

describe('run 41: nothing is dug out from under a block that falls onto the body', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });
  // A shaft: the body at (0,64,0), air to y=65, stone at 66, gravel at 67-69.
  const shaft: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < FLOOR ? 'stone'
    : x === 0 && z === 0 ? (y <= FLOOR + 1 ? 'air' : y === FLOOR + 2 ? 'stone' : y <= FLOOR + 5 ? 'gravel' : 'stone') : 'stone');

  it('dig refuses the cell over the head with gravel on it (falling_above), and digs one beside the column', async () => {
    const sim = makeSim(shaft, { items: [{ name: 'stone_pickaxe', count: 1 }] });
    const over = await drive(sim, dig(ctxOf(sim), { at: [{ x: 0, y: FLOOR + 2, z: 0 }], collect: false }));
    expect(over.ok).toBe(false);
    expect(over.reason).toBe('falling_above');
    expect(over.text).toMatch(/\(0,66,0\).*の上 \(0,67,0\) が gravel。掘ると落ちてきて足と頭を埋める（窒息する）/u);
    expect(closedWord('falling_above')).toBe('上から落ちる');
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(fallsOntoBody(sim.bot, { x: 1, y: FLOOR + 1, z: 0 }, cell => sim.bot.blockAt(new Vec3(cell.x, cell.y, cell.z)))).toBeNull();
  });

  it('a cell below the feet, or in another column, is not the body\'s', () => {
    const sim = makeSim(shaft);
    const read = (cell: { x: number; y: number; z: number }) => sim.bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    expect(fallsOntoBody(sim.bot, { x: 0, y: FLOOR - 1, z: 0 }, read)).toBeNull();
    expect(fallsOntoBody(sim.bot, { x: 0, y: FLOOR + 2, z: 0 }, read)).toEqual({ name: 'gravel', at: { x: 0, y: FLOOR + 3, z: 0 } });
  });
});

describe('run 41: the wall reflex', () => {
  it('knows the blocks a body chokes in, and finds the eye and the feet in them', () => {
    const at = (name: string) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
    expect(chokes(at('gravel'))).toBe(true);
    expect(chokes(at('deepslate'))).toBe(true);
    expect(chokes(at('glass'))).toBe(false);
    expect(chokes(at('oak_leaves'))).toBe(false);
    expect(chokes({ name: 'smooth_stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] })).toBe(false);
    expect(chokes({ name: 'air', boundingBox: 'empty', shapes: [] })).toBe(false);
    const world: Record<string, any> = { '0,65,0': at('gravel'), '0,64,0': at('gravel') };
    const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p: Vec3) => world[`${p.x},${p.y},${p.z}`] ?? { name: 'air', boundingBox: 'empty', shapes: [] }, on: () => undefined };
    expect(inWall(bot)).toBe(true);
    expect(wallCells(bot).map(cell => `${cell.at.x},${cell.at.y},${cell.at.z}`)).toEqual(['0,65,0', '0,64,0']);
    delete world['0,65,0'];
    expect(inWall(bot)).toBe(false);
  });
});

describe('run 41: an ore and its deep twin', () => {
  it('mine takes iron_ore and deepslate_iron_ore as one vein, whichever was named', () => {
    const sim = makeSim(flat);
    expect([...oreTwins(sim.bot, 'diamond_ore')].sort()).toEqual(['deepslate_diamond_ore', 'diamond_ore']);
    expect([...oreTwins(sim.bot, 'deepslate_iron_ore')].sort()).toEqual(['deepslate_iron_ore', 'iron_ore']);
    expect([...oreTwins(sim.bot, 'stone')]).toEqual(['stone']);
    expect([...oreTwins(sim.bot, 'nether_quartz_ore')]).toEqual(['nether_quartz_ore']);
  });
});
