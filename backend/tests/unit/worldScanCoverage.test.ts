import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { coverageOf, installSpawnScan, netherRegionWords, summarizeScan } from '../../src/services/minebot/utils/worldScan.js';

// S8 (2026-11-05): the scan at an arrival was cut at 15 s with 25-39% of the view read (run 59's login), and said "no fortress in this area" of what it had not read.
// It now says how much of the view it read and never that a thing is not there beyond it; it waits for 90% (30 s at most) and scans again as the chunks come.
// In the Nether it names the region (432 m square, one fortress or one bastion each) and what was seen in it.

const reads = { pools: [], eyes: 0, wreck: null, spawnerKinds: [] };
const scanOf = (found: Record<string, { count: number; hits: Array<{ x: number; y: number; z: number; name: string; distance: number }> }>, extra: Record<string, unknown> = {}) =>
  ({ found: new Map(Object.entries(found)), chunks: 172, reachMetres: 121, ms: 40, longestSliceMs: 3, slices: 4, partial: false, ...extra }) as any;
const nether = { game: { dimension: 'the_nether' } } as any;

describe('the scan says how much of the view it read', () => {
  it('says "not within what was read" under 90% of the view, "not in this area" at 90% or more', () => {
    const thin = summarizeScan(nether, scanOf({}, { coverage: 0.39 }), { x: 15, y: 110, z: 12 }, () => null, reads);
    expect(thin.text).toMatch(/描画の距離の 39%/u);
    expect(thin.text).toMatch(/ネザー要塞のブロック.*は読み込めた約 121m までに無い（この先はまだ読めていない）/u);
    expect(thin.text).not.toMatch(/この範囲に無い/u);
    expect(thin.coverage).toBe(0.39);
    const full = summarizeScan(nether, scanOf({}, { coverage: 0.95 }), { x: 15, y: 110, z: 12 }, () => null, reads);
    expect(full.text).toMatch(/この範囲に無い/u);
    expect(full.coverage).toBeUndefined();
  });

  it('measures the share of the view loaded round the body', () => {
    const columns = [] as Array<{ chunkX: number; chunkZ: number }>;
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) columns.push({ chunkX: x, chunkZ: z });
    const bot = { world: { getColumns: () => columns }, game: { serverViewDistance: 10 }, settings: { viewDistance: 10 }, entity: { position: { x: 8, z: 8 } } };
    expect(coverageOf(bot)!.coverage).toBeCloseTo(25 / 441, 3);
    expect(coverageOf(bot, 2)!.coverage).toBe(1);
    expect(coverageOf({ ...bot, game: {} })).toEqual({});
  });
});

describe('the Nether regions', () => {
  it('names the region round the body and what was seen in each', () => {
    expect(netherRegionWords(15, 12)).toBe('x 0〜431・z 0〜431');
    expect(netherRegionWords(-5, 500)).toBe('x -432〜-1・z 432〜863');
    const hit = (x: number, z: number, name: string) => ({ x, y: 70, z, name, distance: Math.hypot(x, z) });
    const seen = summarizeScan(nether, scanOf({
      fortress: { count: 30, hits: [hit(140, 75, 'nether_bricks')] },
      bastion: { count: 40, hits: [hit(-100, 20, 'polished_blackstone_bricks')] },
    }, { coverage: 1 }), { x: 15, y: 110, z: 12 }, () => null, reads);
    const row = seen.rows.find(line => line.startsWith('ネザーの区画'))!;
    expect(row).toMatch(/今の区画 x 0〜431・z 0〜431 は要塞/u);
    expect(row).toMatch(/x -432〜-1・z 0〜431 は砦（この区画に要塞は無い）/u);
    const none = summarizeScan(nether, scanOf({}, { coverage: 1 }), { x: 15, y: 110, z: 12 }, () => null, reads);
    expect(none.rows.find(line => line.startsWith('ネザーの区画'))).toMatch(/は未確認$/u);
    const overworld = summarizeScan({ game: { dimension: 'overworld' } } as any, scanOf({}, { coverage: 1 }), { x: 0, y: 64, z: 0 }, () => null, reads);
    expect(overworld.rows.some(line => line.startsWith('ネザーの区画'))).toBe(false);
  });
});

describe('the scan at a spawn waits for 90% and scans again as the chunks come', () => {
  it('scans at the wait\'s end with 40%, again at +20%, and once more at 90%', async () => {
    vi.useFakeTimers();
    try {
      const columns: Array<{ chunkX: number; chunkZ: number }> = [];
      const fill = (count: number) => { columns.length = 0; for (let i = 0; i < count; i++) columns.push({ chunkX: (i % 21) - 10, chunkZ: Math.floor(i / 21) - 10 }); };
      const bot: any = Object.assign(new EventEmitter(), {
        entity: { position: { x: 8, y: 70, z: 8 } }, registry: { blocksByName: {} }, game: { dimension: 'the_nether', serverViewDistance: 10 }, settings: { viewDistance: 10 },
        world: { getColumns: () => columns }, blockAt: () => null,
      });
      const lines: string[] = [];
      installSpawnScan(bot, { log: line => lines.push(line), maxWaitMs: 30_000 });
      fill(176);
      bot.emit('spawn');
      await vi.advanceTimersByTimeAsync(31_000);
      const first = lines.filter(line => line.startsWith('world scan')).length;
      expect(first).toBe(2); // one early actual partial view, then S8's normal scan at 30 s
      fill(176 + 89);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lines.filter(line => line.startsWith('world scan')).length).toBe(3);
      fill(400);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lines.filter(line => line.startsWith('world scan')).length).toBe(4);
      fill(441);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lines.filter(line => line.startsWith('world scan')).length).toBe(4);
    } finally { vi.useRealTimers(); }
  });
});
