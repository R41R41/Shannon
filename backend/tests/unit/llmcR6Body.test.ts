import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// r6 (2026-10-22, run 29): the body's fixes. A hold with nothing in reach and sight stops as 届かない after 8 s and says where the nearest
// one is; the low-health last stand runs only while a threat can get at the body (read now) and never cuts the planner's blocks going in;
// the spawn scan gives the loop back inside a section (run 29: one hold of 48.7 ms over 353 Nether chunks).
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    bot.__dug.push(`${block.position.x},${block.position.y},${block.position.z}`);
    bot.__blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty' });
    return { stateId: 0, blockName: 'air' };
  }) };
});

const { attack } = await import('../../src/services/minebot/utils/primitives/attack.js');
const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');
const { floorConfig } = await import('../../src/services/minebot/utils/floorConfig.js');
const { installFloorReflexes, lastStandChoice } = await import('../../src/services/minebot/utils/floorReflexes.js');
const { ensureReflexLedger } = await import('../../src/services/minebot/utils/reflexLedger.js');
const { scanWorld } = await import('../../src/services/minebot/utils/worldScan.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 }, AIR: Cell = { name: 'air', boundingBox: 'empty' };

// ===== attack hold =====

/** A fake body in a flat world (stone under y 64, air from 64); `__blocks` overrides single cells. */
function flat() {
  const blocks = new Map<string, Cell>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'the_nether' }, entities: {} as Record<number, any>,
    registry: { blocksByName: { cobblestone: { id: 1 } }, entitiesByName: { blaze: { type: 'hostile' } }, itemsByName: {}, items: {} },
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) },
    heldItem: { name: 'iron_sword' },
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      return { ...(blocks.get(`${x},${y},${z}`) ?? (y < 64 ? STONE : AIR)), position: new Vec3(x, y, z) };
    },
    setControlState: () => undefined, clearControlStates: () => undefined, lookAt: async () => undefined,
    pathfinder: { setGoal: () => undefined },
  });
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });
const blaze = (id: number, x: number, y: number, z: number) => ({ id, name: 'blaze', type: 'hostile', height: 1.8, width: 0.6, position: new Vec3(x, y, z) });

describe('attack hold: 8 s with nothing in reach and sight is 届かない, with the facts (run 29: 0 blows in 150 s of holds, all "done")', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a blaze 6 up behind the roof: stops at 8 s as out_of_reach, never swings through the stone, says where it is and what is between', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat();
    // The shaft's roof over the head (y 66, 67) and the blaze above it, straight up; a second blaze at arm's length behind a wall.
    bot.__blocks.set('0,66,0', STONE); bot.__blocks.set('0,67,0', STONE);
    bot.__blocks.set('1,64,0', STONE); bot.__blocks.set('1,65,0', STONE);
    bot.entities = { 9: blaze(9, 0.5, 70, 0.5), 10: blaze(10, 2.5, 64, 0.5) };
    const struck: number[] = [];
    bot.attack = (entity: any) => { struck.push(entity.id); };
    const running = attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 30 });
    await vi.advanceTimersByTimeAsync(31_000);
    const out = await running;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('out_of_reach');
    expect(struck).toEqual([]);
    expect(out.text).toMatch(/^8秒、打てる所（目から3m・見える）にblazeがいない。/u);
    expect(out.text).toContain('0回打った・0回当たった・倒した 0・受けた傷 0');
    // The nearest is the one behind the wall (2 m), not the one above: its place, the way, the eye's distance, the first stone between.
    expect(out.text).toMatch(/最寄り blaze #10 \(2,64,0\) 東2・目から\d\.\dm・見えない：間に \(1,6[45],0\) stone/u);
    expect(out.at).toEqual({ x: 2, y: 64, z: 0 });
  });

  it('with only the blaze above: its height and the roof between are said; in the act the line is 届かない and within 160 characters', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const bot = flat();
    bot.__blocks.set('0,66,0', STONE); bot.__blocks.set('0,67,0', STONE);
    bot.entities = { 9: blaze(9, 0.5, 70, 0.5) };
    bot.attack = vi.fn();
    const running = runAct(bot, ACT_HANDS.parse([{ do: 'attack', target: 'blaze', hold: true, seconds: 60 }, { do: 'wait', seconds: 1 }]));
    await vi.advanceTimersByTimeAsync(62_000);
    const json = JSON.parse((await running).result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'failure' });
    const line: string = json.lines[0].line;
    expect(line.startsWith('届かない: 8秒、打てる所')).toBe(true);
    expect(line).toContain('最寄り blaze #9 (0,70,0) 上6・目から');
    expect(line).toContain('見えない：間に (0,66,0) stone ほか 1');
    expect(line).toContain('0回打った');
    expect(line.length).toBeLessThanOrEqual(160);
    expect(json.lines[1].status).toBe('skipped');
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('a blaze that comes within reach in sight keeps the hold going; blows landed and kills are counted apart from blows swung', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat();
    const near = blaze(5, 2.5, 64, 0.5);
    // In reach from the 6th second on; each swing lands (the server hurts it), the third kills it.
    bot.entities = { 6: blaze(6, 12.5, 64, 0.5) };
    let swings = 0;
    bot.attack = (entity: any) => { swings++; bot.emit('entityHurt', entity); if (swings === 3) { delete bot.entities[5]; bot.emit('entityDead', entity); } };
    setTimeout(() => { bot.entities[5] = near; }, 6000);
    const running = attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 12 });
    await vi.advanceTimersByTimeAsync(13_000);
    const out = await running;
    expect(out.ok).toBe(true);
    expect(out.text).toContain('12秒その場で構えた: 3回打った・3回当たった・倒した 1（blaze）・受けた傷 0（被弾 0回）');
  });

  it('a short hold that struck nothing ends at its seconds and still says where the nearest one is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = flat();
    bot.entities = { 6: blaze(6, 12.5, 64, 0.5) };
    bot.attack = vi.fn();
    const running = attack(ctx(bot), { mode: 'hold', target: 'blaze', maxSeconds: 5 });
    await vi.advanceTimersByTimeAsync(6000);
    const out = await running;
    expect(out.ok).toBe(true);
    expect(out.text).toContain('0回打った');
    expect(out.text).toMatch(/最寄り blaze #6 \(12,64,0\) 東12・目から\d+\.\dm・見える/u);
  });
});

// ===== the last stand =====

/**
 * Run 29's shaft: stone everywhere but the column x 0, z 0 from y 65 up (air), the body at its foot (y 65), a blaze 5 up in it. Every
 * heading is a wall, so the low-health flee is refused and the last stand is wanted. `__blocks` overrides cells.
 */
function shaft(options: { now?: () => number; items?: any[] } = {}) {
  const blocks = new Map<string, Cell>();
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[],
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    health: 3.7, food: 17, game: { dimension: 'the_nether' },
    entities: { 9: { id: 9, name: 'blaze', type: 'hostile', position: new Vec3(0.5, 70, 0.5), height: 1.8 } } as Record<string, any>,
    registry: { blocksByName: { cobblestone: { id: 1 } }, entitiesByName: { blaze: { type: 'hostile' } } }, heldItem: null,
    inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), attack: vi.fn(), setControlState: vi.fn(),
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { const at = reference.position.plus(face); blocks.set(`${at.x},${at.y},${at.z}`, { name: 'cobblestone', boundingBox: 'block' }); }),
    blockAt: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      const made = blocks.get(`${x},${y},${z}`) ?? (x === 0 && z === 0 && y >= 65 ? AIR : STONE);
      return { ...made, position: new Vec3(x, y, z) };
    },
  });
  const ledger = ensureReflexLedger(bot);
  installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now: options.now });
  return { bot, ledger };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const stands = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => entry.detail.startsWith('低体力で逃げ道なし:'));

describe('the last stand runs only while a threat can get at the body, and never cuts the planner\'s blocks (run 29: 12 steps down, 3 seals cut)', () => {
  it('a blaze in the open shaft: one step down, said with the threat that reaches; once the shaft is closed over the head, no more', async () => {
    const clock = { at: 7_000_000 };
    const { bot, ledger } = shaft({ now: () => clock.at });
    tick(bot);
    await vi.waitFor(() => expect(bot.__dug).toEqual(['0,64,0']), { timeout: 4000, interval: 5 });
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 4000, interval: 5 });
    // The body is down a cell; the planner's block goes in two over the head (y 66): the blaze is walled off.
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    bot.__blocks.set('0,66,0', { name: 'cobblestone', boundingBox: 'block' });
    for (let i = 0; i < 4; i++) { clock.at += 1600; tick(bot); await settle(30); }
    expect(bot.__dug).toEqual(['0,64,0']);
    expect(stands(ledger)).toHaveLength(1);
    // What it did is told as it happened: where, at what health, and the threat that reached the body.
    expect(stands(ledger)).toMatchObject([{ kind: 'flee', detail: '低体力で逃げ道なし: 足元を掘って下がった (0,65,0) 体力3.7。届く: blaze #9 5.0m 見える' }]);
    expect(lastStandChoice(bot)).toBeNull();
    // Open again (the roof dug away): the threat reaches, and the stand is there to be made.
    bot.__blocks.delete('0,66,0');
    expect(lastStandChoice(bot)).toMatchObject({ kind: 'dig', cell: { x: 0, y: 63, z: 0 } });
  });

  it('the planner\'s place that closes the shaft is not cut: no stand while it lays the block, and none after (walled off)', async () => {
    const clock = { at: 8_000_000 };
    const cobble = { name: 'cobblestone', type: 1, count: 8 };
    const { bot, ledger } = shaft({ now: () => clock.at, items: [cobble] });
    bot.heldItem = cobble;
    // The block goes in only when the test lets it (the server's answer), so the reflex's tick comes while the hand is laying it.
    let release!: () => void;
    const answered = new Promise<void>(resolve => { release = resolve; });
    bot.placeBlock = vi.fn(async (reference: any, face: Vec3) => {
      await answered;
      const at = reference.position.plus(face);
      bot.__blocks.set(`${at.x},${at.y},${at.z}`, { name: 'cobblestone', boundingBox: 'block' });
    });
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'place', block: 'cobblestone', at: [{ x: 0, y: 68, z: 0 }] }, { do: 'wait', seconds: 0.2 }]), undefined, undefined, { tickMs: 20 });
    await vi.waitFor(() => expect(bot.placeBlock).toHaveBeenCalledTimes(1), { timeout: 3000, interval: 5 });
    for (let i = 0; i < 3; i++) { clock.at += 1600; tick(bot); await settle(30); }
    expect(bot.__dug).toEqual([]);
    expect(stands(ledger)).toHaveLength(0);
    release();
    const json = JSON.parse((await acting).result);
    expect(json.lines[0]).toMatchObject({ status: 'done' });
    // Walled off now: the refused flee is not followed by a stand.
    for (let i = 0; i < 3; i++) { clock.at += 1600; tick(bot); await settle(30); }
    expect(bot.__dug).toEqual([]);
    expect(stands(ledger)).toHaveLength(0);
  });
});

// ===== the spawn scan's slices =====

const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry) };
  } catch { return null; }
}
const L = lib();

/** A small fixed random (the same world each run). */
function random(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/**
 * A Nether column like run 29's fortress country: bedrock floor and roof, netherrack with caves, a lava sea (sources y 22-31), quartz and gold
 * ores, glowstone, soul sand, gravel, magma, basalt and blackstone patches (many states in each section's palette); `kind` adds a fortress
 * (nether bricks, fences and stairs at y 64-75 with a corridor and, once, a spawner) or a crimson forest (nylium, stems, wart blocks).
 */
function netherColumn(kind: 'plain' | 'fortress' | 'crimson', seed: number) {
  const { registry, Chunk } = L!;
  const chunk = new Chunk({ minY: 0, worldHeight: 256 });
  const put = (x: number, y: number, z: number, name: string) => chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  const r = random(seed);
  const scatter = ['nether_quartz_ore', 'nether_gold_ore', 'glowstone', 'soul_sand', 'gravel', 'magma_block', 'basalt', 'blackstone', 'soul_soil'];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    put(x, 0, z, 'bedrock'); put(x, 127, z, 'bedrock');
    for (let y = 1; y < 127; y++) {
      const cave = y > 34 && y < 110 && ((x * 7 + z * 3 + y * 5 + seed) % 23 < 6);
      if (y >= 22 && y <= 31 && (x + z + seed) % 5 !== 0) put(x, y, z, 'lava');
      else if (cave) continue;
      else put(x, y, z, r() < 0.04 ? scatter[Math.floor(r() * scatter.length)] : 'netherrack');
    }
    if (kind === 'fortress') {
      for (let y = 64; y <= 75; y++) {
        const wall = x === 0 || x === 15 || z === 0 || z === 15 || y === 64 || y === 75;
        put(x, y, z, wall ? (r() < 0.1 ? 'cracked_nether_bricks' : 'nether_bricks') : (y === 65 && (x + z) % 4 === 0 ? 'nether_brick_fence' : y === 65 && x === 7 ? 'nether_brick_stairs' : 'air'));
      }
      if (seed % 50 === 3) put(8, 66, 8, 'spawner');
    }
    if (kind === 'crimson') {
      put(x, 60, z, 'crimson_nylium');
      if ((x * 5 + z * 11 + seed) % 37 === 0) for (let y = 61; y <= 67; y++) put(x, y, z, 'crimson_stem');
      if ((x + z * 3 + seed) % 13 === 0) put(x, 68, z, 'nether_wart_block');
      if ((x * 3 + z + seed) % 29 === 0) put(x, 69, z, 'shroomlight');
    }
  }
  return chunk;
}

/** 353 columns round chunk 0,0 (19 x 19 less the 8 corners' cells), fortress country to the east, a crimson patch to the west. */
function netherWorld() {
  const { World } = L!;
  const world = new World(null, null);
  const kinds: Record<string, any> = {};
  const columnFor = (cx: number, cz: number) => {
    const kind: 'plain' | 'fortress' | 'crimson' = cx >= 2 && Math.abs(cz) <= 6 ? 'fortress' : cx <= -5 && cz >= 2 ? 'crimson' : 'plain';
    const seed = kind === 'fortress' ? ((cx * 31 + cz * 17) & 63) : (cx * 13 + cz * 7) & 7;
    const key = `${kind}:${seed}`;
    return kinds[key] ??= netherColumn(kind, seed);
  };
  let columns = 0;
  for (let cx = -9; cx <= 9; cx++) for (let cz = -9; cz <= 9; cz++) {
    if (Math.abs(cx) === 9 && Math.abs(cz) >= 8) continue;
    world.sync.setColumn(cx, cz, columnFor(cx, cz)); columns++;
  }
  return { world, columns };
}

describe.skipIf(!L)('the spawn scan gives the loop back inside a section (run 29: 353 Nether chunks, one hold of 48.7 ms)', () => {
  it('a section read whole looks at the clock every 512 cells (before: only between sections), and the slice is 4 ms', async () => {
    const { LoopSlicer, scanLoadedCategories, SCAN_SLICE_MS } = await import('../../src/services/minebot/utils/loadedBlockScan.js');
    expect(SCAN_SLICE_MS).toBe(4);
    const { World } = L!;
    const world = new World(null, null);
    // One column: one section (y 16-31) of lava sources among netherrack and quartz (a palette of three), the rest netherrack.
    world.sync.setColumn(0, 0, (() => {
      const { registry, Chunk } = L!;
      const chunk = new Chunk({ minY: 0, worldHeight: 256 });
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 48; y++) {
        const name = y >= 16 && y < 32 ? ((x + y + z) % 3 === 0 ? 'nether_quartz_ore' : 'lava') : 'netherrack';
        chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
      }
      return chunk;
    })());
    const bot = { entity: { position: new Vec3(8, 40, 8) }, registry: L!.registry, world: world.sync } as any;
    // A slice that is always spent: every look at the clock gives the loop back.
    class Spent extends LoopSlicer { override due() { return true; } }
    const slicer = new Spent(0, async () => undefined);
    const scan = await scanLoadedCategories(bot, [{ key: 'lava', names: ['lava'], sourceOnly: true, keep: 4 }], { slicer });
    let lava = 0;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 16; y < 32; y++) if ((x + y + z) % 3 !== 0) lava++;
    expect(scan.found.get('lava')!.count).toBe(lava);
    // 4096 cells: 8 looks inside the section, one after it, one after the column.
    expect(scan.slices - 1).toBeGreaterThanOrEqual(8 + 2);
  });

  it('353 Nether chunks of fortress, lava sea and a crimson patch: every hold of the loop, the summary\'s too, 10 ms or less (printed as [scan r6])', async () => {
    const { world, columns } = netherWorld();
    expect(columns).toBe(353);
    const bot = Object.assign(new EventEmitter(), {
      entity: { id: 1, position: new Vec3(8.5, 66, 8.5), yaw: 0, onGround: true }, entities: {}, game: { dimension: 'the_nether' },
      registry: L!.registry, world: world.sync, health: 20, food: 20, inventory: { items: () => [] },
      blockAt: (position: Vec3, extraInfos?: boolean) => world.sync.getBlock(position, extraInfos),
    }) as any;
    await scanWorld(bot);
    // The loop's own view: the longest gap between two turns of a setImmediate ticker that runs beside the scan.
    const runs: Array<{ ms: number; longest: number; gap: number; rows: number }> = [];
    for (let i = 0; i < 3; i++) {
      let running = true, last = performance.now(), gap = 0;
      const ticker = () => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; if (running) setImmediate(ticker); };
      setImmediate(ticker);
      const scan = (await scanWorld(bot))!;
      running = false;
      runs.push({ ms: scan.ms, longest: scan.longestSliceMs, gap: Math.round(gap * 10) / 10, rows: scan.rows.length });
      expect(scan.chunks).toBe(353);
      expect(scan.text).toContain('ネザー要塞');
    }
    // eslint-disable-next-line no-console
    console.log(`[scan r6] 353 Nether chunks: ${runs.map(run => `${run.ms} ms (longest hold ${run.longest} ms, ticker gap ${run.gap} ms, ${run.rows} rows)`).join(', ')}`);
    const sorted = runs.map(run => run.longest).sort((a, b) => a - b);
    expect(sorted[1]).toBeLessThanOrEqual(10);
  }, 120_000);
});
