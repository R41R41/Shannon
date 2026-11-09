import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as loaded from '../../src/services/minebot/utils/loadedBlockScan.js';
import { installSpawnScan } from '../../src/services/minebot/utils/worldScan.js';
import { worldScanView } from '../../src/services/minebot/utils/worldScanState.js';

/** Real scanLoadedCategories, one observed oak cell, and an explicitly incomplete 21 x 21 view. */
function fixture(count = 176, view: number | null = 10) {
  const columns: Array<{ chunkX: number; chunkZ: number; column: { minY: number; sections: any[] } }> = [];
  const fill = (n: number) => {
    columns.length = 0;
    for (let i = 0; i < n; i++) columns.push({ chunkX: i % 21 - 10, chunkZ: Math.floor(i / 21) - 10,
      column: { minY: 64, sections: [{ data: { palette: [0, 1], get: (cell: number) => i === 0 && cell === 0 ? 1 : 0 } }] } });
  };
  fill(count);
  const bot: any = Object.assign(new EventEmitter(), {
    health: 20, entity: { position: new Vec3(8, 64, 8) },
    registry: { blocksByName: { oak_log: { minStateId: 1, maxStateId: 1 } } },
    game: { dimension: 'overworld', ...(view === null ? {} : { serverViewDistance: view }) }, settings: { viewDistance: 10 },
    world: { getColumns: () => columns }, blockAt: () => null,
  });
  const published: any[] = [], logs: string[] = [];
  let kept: any;
  Object.defineProperty(bot, 'worldScan', { configurable: true, get: () => kept, set: value => { kept = value; if (value) published.push(value); } });
  const stop = installSpawnScan(bot, { log: line => logs.push(line) });
  bot.emit('spawn');
  return { bot, fill, published, logs, stop };
}

const releases: Array<() => void> = [];
function clock() { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z')); }
afterEach(() => { for (const stop of releases.splice(0)) stop(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('the first actual partial scan reaches observation before the head\'s 20 s first-plan wait', () => {
  it('publishes real oak/count/range by 10 s, then still performs the normal 30 s scan', async () => {
    clock();
    const f = fixture(); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(10_000);
    const early = worldScanView(f.bot)!;
    expect(early).not.toBeNull();
    expect(early.preliminary).toBe(true);
    expect(early.chunks).toBe(176);
    expect(early.coverage).toBe(0.4);
    expect(early.rows.some(row => /原木 oak ×1/u.test(row))).toBe(true);
    expect(early.text).toMatch(/先行走査.*観測.*未読範囲.*40%/u);
    expect(early.text.slice(0, 300)).toMatch(/未読範囲.*40%/u); // scanLines' real short-text bound
    expect(early.text).not.toContain('はこの範囲に無い');
    expect(Date.parse(early.at) - Date.parse('2026-11-05T00:00:00Z')).toBeLessThan(20_000);
    expect(Date.parse(early.startedAt!)).toBeLessThanOrEqual(Date.parse(early.at));
    expect(f.published).toHaveLength(1); // no repeated preliminary work during the loading wait
    await vi.advanceTimersByTimeAsync(21_000);
    expect(f.published).toHaveLength(2);
    expect(f.published[1].preliminary).toBeUndefined();
    expect(f.published[1].waitedMs).toBeGreaterThanOrEqual(30_000);
    expect(f.published[1].coverage).toBe(0.4);
    expect(f.published[1].text).toContain('この先はまだ読めていない');
  });

  it('continues to the same 90% condition without waiting for 30 s or adding another preliminary scan', async () => {
    clock();
    const f = fixture(); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.published).toHaveLength(1);
    f.fill(400);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.published).toHaveLength(2);
    expect(f.published[1].preliminary).toBeUndefined();
    expect(f.published[1].waitedMs).toBeLessThan(30_000);
    expect(f.published[1].chunks).toBe(400);
    f.fill(441);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.published).toHaveLength(2);
  });

  it('with an unknown expected count says unread range, never a full-area absence, then retains the normal settle scan', async () => {
    clock();
    const f = fixture(25, null); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(f.published).toHaveLength(1);
    const early = f.published[0];
    expect(early.preliminary).toBe(true);
    expect(early.coverage).toBeUndefined();
    expect(early.text).toMatch(/未読範囲あり.*描画の距離は不明/u);
    expect(early.text.slice(0, 300)).toMatch(/未読範囲あり.*描画の距離は不明/u);
    expect(early.text).toContain('調べた所に無い');
    expect(early.text).not.toContain('はこの範囲に無い');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.published).toHaveLength(2);
    expect(f.published[1].preliminary).toBeUndefined();
  });

  it('uses the normal full scan directly when 90% is already loaded at the existing minimum wait', async () => {
    clock();
    const f = fixture(400); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.published).toHaveLength(1);
    expect(f.published[0].preliminary).toBeUndefined();
    expect(f.published[0].waitedMs).toBe(2000);
  });
});

/** Hold only the category scan's promise to replay an actual await boundary; summaries and publication remain real. */
function holdFirstScan() {
  let resolve!: (value: loaded.SlicedScanResult) => void;
  const pending = new Promise<loaded.SlicedScanResult>(r => { resolve = r; });
  const spy = vi.spyOn(loaded, 'scanLoadedCategories').mockImplementationOnce(() => pending);
  return { spy, finish: () => resolve({ found: new Map(), chunks: 1, reachMetres: 16, ms: 5, longestSliceMs: 1, slices: 1, partial: false }) };
}

describe('a pending early scan cannot publish an expired body or location', () => {
  it.each(['dispose', 'end', 'death', 'respawn', 'dimension', 'entity', 'position'] as const)('rejects %s while the real scanner is awaiting', async boundary => {
    clock();
    const held = holdFirstScan(), f = fixture(); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(held.spy).toHaveBeenCalledTimes(1);
    if (boundary === 'dispose') f.stop();
    else if (boundary === 'dimension') { f.bot.game.dimension = 'the_nether'; f.bot.emit('game'); }
    else if (boundary === 'entity') f.bot.entity = { position: f.bot.entity.position.clone() };
    else if (boundary === 'position') f.bot.entity.position.x += 1;
    else { f.bot.emit(boundary); if (boundary === 'death') f.bot.health = 20; }
    held.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.published).toHaveLength(0);
    expect(worldScanView(f.bot)).toBeNull();
  });

  it('a newer spawn replaces an awaiting scan, and only its actual position is published', async () => {
    clock();
    const held = holdFirstScan(), f = fixture(); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(2_100);
    f.bot.entity.position.x += 16;
    f.bot.arrival = { kind: 'respawn', at: Date.now() };
    f.bot.emit('spawn');
    held.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.published).toHaveLength(1);
    expect(f.published[0].trigger).toBe('respawn');
    expect(f.published[0].center).toEqual({ x: 24, y: 64, z: 8 });
    expect(Date.parse(f.published[0].startedAt)).toBeGreaterThanOrEqual(Date.parse('2026-11-05T00:00:04Z'));
  });

  it('clears the old same-dimension scan at a new spawn instead of letting the first plan accept it', async () => {
    clock();
    const f = fixture(); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worldScanView(f.bot)).not.toBeNull();
    f.bot.emit('spawn');
    expect(worldScanView(f.bot)).toBeNull();
    f.stop(); f.stop();
    for (const event of ['spawn', 'end', 'death', 'respawn', 'game']) expect(f.bot.listenerCount(event)).toBe(0);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.published).toHaveLength(1);
  });

  it('retains a moving normal survey, with its actual starting point/time in both structured and clipped text output', async () => {
    clock();
    const f = fixture(); releases.push(f.stop);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.published).toHaveLength(1);
    const held = holdFirstScan();
    f.fill(400);
    await vi.advanceTimersByTimeAsync(500);
    expect(held.spy).toHaveBeenCalledTimes(1);
    f.bot.entity.position.x += 1;
    held.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.published).toHaveLength(2);
    const main = f.published[1];
    expect(main.preliminary).toBeUndefined();
    expect(main.center).toEqual({ x: 8, y: 64, z: 8 });
    expect(f.bot.entity.position.x).toBe(9);
    expect(main.text.slice(0, 300)).toContain('計測基点 (8,64,8)');
    expect(main.text.slice(0, 300)).toContain(`開始 ${main.startedAt}`);
    expect(main.rows[0].slice(0, 120)).toContain('計測基点 (8,64,8)');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.published).toHaveLength(2); // no repeated five-second scans were added
  });
});
