import { createRequire } from 'node:module';
import { PerformanceObserver } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { LoopSlicer, scanLoadedCategories } from '../../src/services/minebot/utils/loadedBlockScan.js';
import { installSpawnScan, MAX_ROWS, scanWorld } from '../../src/services/minebot/utils/worldScan.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { runProbe } from '../../src/services/minebot/instantSkills/probe.js';
import { noteHand } from '../../src/services/minebot/utils/handHistory.js';

// r4 contract 1 (2026-10-22): the scan of the loaded chunks, sliced so the loop is never held long (441 chunks in about a second), and
// kept at a spawn as the observation's world.scan. A real prismarine world (mineflayer's own world.sync). Chunk columns are shared where
// they are alike (a column has no coordinates of its own), so a 21 x 21 world is built in a moment.
const require = createRequire(import.meta.url);
function lib() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    return { registry, Chunk: require('prismarine-chunk')(registry), World: require('prismarine-world')(registry) };
  } catch { return null; }
}
const L = lib();

type Put = (x: number, y: number, z: number, name: string, add?: number) => void;
function column(fill: (put: Put) => void) {
  const { registry, Chunk } = L!;
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  fill((x, y, z, name, add = 0) => chunk.setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[name].defaultState + add));
  return chunk;
}
/** Rock with an aquifer cell in three sections (each such section is read whole), dirt, grass at 63. */
function plain(put: Put) {
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    for (let y = -60; y <= 60; y++) put(x, y, z, y < 0 ? 'deepslate' : 'stone');
    put(x, 61, z, 'dirt'); put(x, 62, z, 'dirt'); put(x, 63, z, 'grass_block');
  }
  put(3, -30, 3, 'water'); put(5, 10, 9, 'water'); put(8, 50, 2, 'water');
}

/**
 * The world: `radius` chunks round chunk 0,0, every column plain but these (block coordinates):
 *   chunk (1,0):  an oak tree at (20, 64..68, 4) and a birch at (26, 64..66, 10);
 *   chunk (0,2):  a village: a bell (5,64,37), beds, chests, hay, farmland and wheat;
 *   chunk (-2,0): a lake: water sources y 58..63 over x -32..-17, z 0..15, and its flowing edge at y 63 (level 1) on x -17;
 *   chunk (2,-2): an open lava pool (36..39, 63, -28..-25) of 16 sources, and a covered one (44..45, 50, -28..-27) under stone;
 *   chunk (0,-3): a spawner (6,30,-40), rails (y 30) x 0..11, cobwebs;
 *   chunk (3,3):  a nether portal (52,64,52)..(52,66,53) in obsidian.
 */
function build(radius: number, options: { trees?: boolean } = {}) {
  const { World } = L!;
  const world = new World(null, null);
  const base = column(plain);
  const special: Record<string, any> = {
    ...(options.trees !== false ? { '1,0': column(put => { plain(put); for (let y = 64; y <= 68; y++) put(4, y, 4, 'oak_log'); for (let y = 64; y <= 66; y++) put(10, y, 10, 'birch_log'); }) } : {}),
    '0,2': column(put => {
      plain(put);
      put(5, 64, 5, 'bell'); put(2, 64, 2, 'red_bed'); put(2, 64, 9, 'white_bed'); put(9, 64, 2, 'chest'); put(9, 64, 9, 'barrel'); put(12, 64, 12, 'hay_block');
      for (let x = 0; x < 6; x++) { put(x, 63, 14, 'farmland'); put(x, 64, 14, 'wheat'); }
    }),
    '-2,0': column(put => {
      plain(put);
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 58; y <= 63; y++) put(x, y, z, 'water', x === 15 && y === 63 ? 1 : 0);
    }),
    '2,-2': column(put => {
      plain(put);
      for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) { put(x, 63, z, 'lava'); put(x, 64, z, 'air'); }
      for (let x = 12; x < 14; x++) for (let z = 4; z < 6; z++) put(x, 50, z, 'lava');
    }),
    '0,-3': column(put => {
      plain(put);
      for (let x = 0; x < 12; x++) for (let y = 30; y <= 32; y++) put(x, y, 0, 'air');
      for (let x = 0; x < 12; x++) put(x, 30, 0, 'rail');
      put(6, 30, 8, 'spawner'); put(6, 31, 8, 'air'); put(2, 31, 0, 'cobweb'); put(9, 31, 0, 'cobweb');
    }),
    '3,3': column(put => {
      plain(put);
      for (let y = 63; y <= 67; y++) for (let z = 3; z <= 6; z++) put(4, y, z, y === 63 || y === 67 || z === 3 || z === 6 ? 'obsidian' : 'nether_portal');
    }),
  };
  for (let cx = -radius; cx <= radius; cx++) for (let cz = -radius; cz <= radius; cz++) world.sync.setColumn(cx, cz, special[`${cx},${cz}`] ?? base);
  return world;
}

function body(world: any, extra: Record<string, unknown> = {}) {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(8.5, 64, 8.5), yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld' },
    registry: L!.registry, world: world.sync, health: 20, food: 20, inventory: { items: () => [] },
    blockAt: (position: Vec3, extraInfos?: boolean) => world.sync.getBlock(position, extraInfos),
    ...extra,
  }) as any;
}

describe.skipIf(!L)('the scan of the loaded chunks', () => {
  it('counts each kind exactly (water and lava by their sources only, a band of height kept), the nearest first', async () => {
    const bot = body(build(3));
    const scan = await scanLoadedCategories(bot, [
      { key: 'water', names: ['water'], sourceOnly: true, keep: 3 },
      { key: 'lava', names: ['lava'], sourceOnly: true, keep: 64 },
      { key: 'bell', names: ['bell'] },
      { key: 'rail', names: ['rail'], yMax: 29 },
      { key: 'log', names: ['oak_log', 'birch_log'], keep: 2 },
    ]);
    // 49 columns, three aquifer cells each, and the lake's 16 x 16 x 6 less its flowing edge (16 cells at y 63, level 1).
    expect(scan.chunks).toBe(49);
    expect(scan.found.get('water')!.count).toBe(49 * 3 + 16 * 16 * 6 - 16);
    expect(scan.found.get('water')!.hits).toHaveLength(3);
    expect(scan.found.get('lava')!.count).toBe(16 + 4);
    expect(scan.found.get('bell')!.hits[0]).toMatchObject({ name: 'bell', x: 5, y: 64, z: 37 });
    expect(scan.found.get('rail')!.count).toBe(0);
    expect(scan.found.get('log')!.count).toBe(8);
    expect(scan.found.get('log')!.hits.map(hit => hit.name)).toEqual(['oak_log', 'oak_log']);
    expect(scan.partial).toBe(false);
  });

  it('gives the loop back: many slices, none long; stops at its time and says partial; keeps to the radius asked', async () => {
    const bot = body(build(4));
    const categories = [{ key: 'water', names: ['water'], sourceOnly: true }, { key: 'stone', names: ['stone'] }];
    const sliced = await scanLoadedCategories(bot, categories, { sliceMs: 1 });
    expect(sliced.slices).toBeGreaterThan(5);
    expect(sliced.longestSliceMs).toBeLessThan(50);
    let yields = 0;
    const counted = new LoopSlicer(1, async () => { yields++; await new Promise(resolve => setImmediate(resolve)); });
    await scanLoadedCategories(bot, categories, { slicer: counted });
    expect(yields).toBe(counted.slices - 1);
    expect(yields).toBeGreaterThan(5);
    const capped = await scanLoadedCategories(bot, categories, { maxMs: 0 });
    expect(capped.partial).toBe(true);
    expect(capped.chunks).toBeLessThan(81);
    const near = await scanLoadedCategories(bot, categories, { radiusChunks: 1 });
    expect(near.chunks).toBe(9);
  });

  it('sums up in at most 20 rows with the way and distance: wood by kind, the village, water, lava pools and their cover, a mineshaft, a spawner, a portal', async () => {
    const bot = body(build(4));
    bot.entities = { 9: { id: 9, name: 'zombie', position: new Vec3(6.5, 31, -39.5) } };
    const scan = (await scanWorld(bot))!;
    expect(scan.rows.length).toBeLessThanOrEqual(MAX_ROWS);
    const all = scan.rows.join('\n');
    // eslint-disable-next-line no-console
    console.log(`[scan rows]\n${all}\n[scan text] ${scan.text}`);
    expect(all).toContain('原木 oak ×5 最寄り (20,64,4) 東 13m・同じ高さ');
    expect(all).toContain('原木 birch ×3');
    expect(all).toContain('村の鐘 ×1 最寄り (5,64,37) 南 29m');
    expect(all).toMatch(/ベッド ×2 最寄り \(\d+,64,\d+\)/u);
    expect(all).toContain('畑・作物 ×12');
    expect(all).toMatch(/水源 ×\d+ 最寄り/u);
    expect(all).toMatch(/溶岩の溜まり 源 16 最寄り \(36,63,-25\) 北東 \d+m・下 1 上は空気（覆い無し）/u);
    expect(all).toMatch(/溶岩の溜まり 源 4 最寄り \(44,50,-27\) 北東 \d+m・下 14 上は.*覆い/u);
    expect(all).toContain('廃坑のレール（y≤60） ×12');
    expect(all).toMatch(/スポナー 最寄り \(6,30,-40\) 北 \d+m・下 34 近くに zombie/u);
    expect(all).toContain('ネザーポータル ×6');
    expect(scan.text).toMatch(/^読み込み済みの 81 チャンク（約 \d+m 先まで）を調べた。原木は oak が 東 13m・同じ高さ。/u);
    expect(scan.text).toContain('構造物：廃坑');
  });

  it('says what is not there: no log in the area read', async () => {
    const bot = body(build(2, { trees: false }));
    const scan = (await scanWorld(bot))!;
    expect(scan.text).toContain('原木はこの範囲に無い');
    expect(scan.rows.some(row => row.startsWith('原木'))).toBe(false);
  });

  it('441 chunks (view distance 10): the time, the longest hold of the loop, the collections (printed as [scan])', async () => {
    const bot = body(build(10));
    await scanWorld(bot);
    const collections: number[] = [];
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) collections.push(entry.duration); });
    observer.observe({ entryTypes: ['gc'] });
    const runs: Array<{ ms: number; longest: number }> = [];
    for (let i = 0; i < 3; i++) { const scan = (await scanWorld(bot))!; runs.push({ ms: scan.ms, longest: scan.longestSliceMs }); expect(scan.chunks).toBe(441); }
    await new Promise(resolve => setTimeout(resolve, 50));
    observer.disconnect();
    // eslint-disable-next-line no-console
    console.log(`[scan] 441 chunks: ${runs.map(run => `${run.ms} ms (longest hold ${run.longest} ms)`).join(', ')}; GCs in three scans ${collections.length} (${collections.reduce((a, b) => a + b, 0).toFixed(1)} ms)`);
    for (const run of runs) expect(run.longest).toBeLessThan(50);
  }, 60_000);
});

describe.skipIf(!L)('the scan at a spawn, kept as world.scan', () => {
  const quick = { minWaitMs: 20, settleMs: 20, pollMs: 5 };

  it('after a spawn, once the chunks have come, one scan kept with how she came; mode off, none', async () => {
    const world = build(2);
    const bot = body(world, { llmCentric: true, arrival: { kind: 'portal', at: Date.now() } });
    installSpawnScan(bot, quick);
    bot.emit('spawn');
    await vi.waitFor(() => expect(bot.worldScan).toBeDefined(), { timeout: 5000, interval: 10 });
    expect(bot.worldScan).toMatchObject({ trigger: 'portal', dimension: 'overworld', center: { x: 8, y: 64, z: 8 }, chunks: 25 });
    expect(bot.worldScan.rows.length).toBeGreaterThan(0);
    expect(typeof bot.worldScan.at).toBe('string');
    const off = body(world, { llmCentric: false, arrival: { kind: 'login', at: Date.now() } });
    installSpawnScan(off, quick);
    off.emit('spawn');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(off.worldScan).toBeUndefined();
  });

  it('a newer spawn replaces the one before: only its scan is kept', async () => {
    const bot = body(build(2), { llmCentric: true, arrival: { kind: 'login', at: Date.now() } });
    const stop = installSpawnScan(bot, quick);
    bot.emit('spawn');
    bot.arrival = { kind: 'respawn', at: Date.now() };
    bot.emit('spawn');
    await vi.waitFor(() => expect(bot.worldScan).toBeDefined(), { timeout: 5000, interval: 10 });
    expect(bot.worldScan.trigger).toBe('respawn');
    stop();
  });

  it('the observation carries it only in the mode, and only in the dimension it was made in; the probe scans on asking', async () => {
    const bot = body(build(1), { llmCentric: true });
    bot.worldScan = { trigger: 'login', at: '2026-10-22T04:00:00.000Z', dimension: 'overworld', center: { x: 8, y: 64, z: 8 }, text: '読み込み済みの…', rows: ['水源 ×1'], chunks: 9, reach: 23, ms: 5 };
    expect(captureWorldObservation(bot).scan).toEqual(bot.worldScan);
    bot.game.dimension = 'the_nether';
    expect(captureWorldObservation(bot).scan).toBeUndefined();
    bot.game.dimension = 'overworld';
    bot.llmCentric = false;
    expect(captureWorldObservation(bot).scan).toBeUndefined();
    const json = JSON.parse((await runProbe(bot, { kind: 'scan', radius: 1 })).result);
    expect(json).toMatchObject({ v: 1, kind: 'scan', chunks: 9 });
    expect(Object.keys(json).slice(0, 3)).toEqual(['v', 'kind', 'text']);
  });

  it('the whole observation for a minute with a scan kept and a hand noted every 5 s: GCs and ms (printed as [gc] r4)', () => {
    const bot = body(build(7), { llmCentric: true });
    bot.worldScan = { trigger: 'login', at: '2026-10-22T04:00:00.000Z', dimension: 'overworld', center: { x: 8, y: 64, z: 8 }, text: 'x'.repeat(400),
      rows: new Array(20).fill('原木 oak ×425 最寄り (150,70,195) 北東 6m・上 2'), chunks: 225, reach: 112, ms: 400 };
    const realNow = Date.now;
    let clock = 9_000_000;
    Date.now = () => clock;
    try {
      const run = (frames: number) => {
        let chars = 0;
        for (let i = 0; i < frames; i++) {
          clock += 250;
          const metres = (i * 250 / 1000) * 4.3;
          bot.entity.position = new Vec3((metres % 60) - 30 + 0.5, 64, 0.5);
          if (i % 20 === 0) noteHand(bot, { t: clock, do: 'walk', status: 'done', line: '(1,64,0) に着いた', at: { x: Math.floor(metres % 60), y: 64, z: 0 } });
          chars += JSON.stringify(JSON.parse(JSON.stringify(captureWorldObservation(bot)))).length;
        }
        return chars;
      };
      run(120);
      const collections: number[] = [];
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) collections.push(entry.duration); });
      observer.observe({ entryTypes: ['gc'] });
      const started = performance.now();
      const chars = run(240 * 3);
      const ms = performance.now() - started;
      observer.disconnect();
      // eslint-disable-next-line no-console
      console.log(`[gc] r4 whole frame with world.scan, per simulated minute (mean of 3): GCs ${(collections.length / 3).toFixed(1)} (${(collections.reduce((a, b) => a + b, 0) / 3).toFixed(1)} ms); work ${(ms / 3).toFixed(0)} ms; ${Math.round(chars / 720)} chars a frame`);
      expect(chars).toBeGreaterThan(0);
    } finally { Date.now = realNow; }
  }, 120_000);
});
