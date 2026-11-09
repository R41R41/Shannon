import { describe, expect, it } from 'vitest';
import { inspectLogCandidates, LOG_GROUP_LIMIT, LOG_READ_LIMIT, LOG_SAMPLE_LIMIT } from '../../src/services/minebot/utils/logCandidates.js';
import type { BlockReader, MapBlock } from '../../src/services/minebot/utils/localMap.js';
import type { LoopSlicer, ScanCellHit, SlicedScanResult } from '../../src/services/minebot/utils/loadedBlockScan.js';
import { readScanSliced, summarizeScan } from '../../src/services/minebot/utils/worldScan.js';

// Read-only c1 pristine Anvil, S1b: the nearest four log cells are branches; the root is fifth.
// Only the actual log geometry and the two observed root floors are retained, not a claim about a route.
const C1_LOGS = [[146,87,77],[146,88,81],[147,87,78],[147,88,81],[148,86,78],[148,87,80],
  [149,85,77],[149,86,79],[149,87,80],[150,81,79],[150,82,79],[150,83,79],[150,84,79],
  [150,85,78],[150,85,79],[150,86,79],[150,87,79],[150,88,79],[150,89,79],[150,90,79],
  [151,85,78],[151,89,77],[151,89,78],[152,85,77],[153,86,76]];

function fixture(offset = [0, 0, 0], kind = 'oak') {
  const [dx, dy, dz] = offset, cells = new Map<string, MapBlock>();
  const at = (x: number, y: number, z: number) => ({ x: x + dx, y: y + dy, z: z + dz });
  const cellKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
  const origin = { x: 127.5 + dx, y: 75 + dy, z: 83.5 + dz };
  const hits = C1_LOGS.map(([x, y, z]) => {
    const p = at(x, y, z); cells.set(cellKey(p), { name: `${kind}_log`, solid: true });
    return { ...p, name: `${kind}_log`, distance: Math.hypot(p.x + .5 - origin.x, p.y - origin.y, p.z + .5 - origin.z) };
  }).sort((a, b) => a.distance - b.distance);
  cells.set(cellKey(at(150, 80, 79)), { name: 'dirt', solid: true });
  cells.set(cellKey(at(149, 80, 79)), { name: 'grass_block', solid: true });
  let reads = 0;
  const read: BlockReader = (x, y, z) => { reads++; return cells.get(`${x},${y},${z}`) ?? { name: 'air', solid: false }; };
  return { at, hits, read, cells, reads: () => reads, origin };
}

function drain(read: BlockReader, hits: ScanCellHit[], total = hits.length) {
  const work = inspectLogCandidates(read, hits, total);
  for (;;) { const step = work.next(); if (step.done) return step.value; }
}

describe('bounded observed log groups and real adjacent floors', () => {
  it('distinguishes the c1 branch from the lower supported trunk and does not claim a path', () => {
    const f = fixture();
    expect(f.hits.slice(0, 4).every(p => p.y >= 87)).toBe(true);
    expect(f.hits[4]).toMatchObject(f.at(150, 81, 79));
    const out = drain(f.read, f.hits, 2590);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ nearest: f.at(146, 88, 81), lowest: f.at(150, 81, 79),
      support: { at: f.at(150, 80, 79), name: 'dirt' },
      stand: { at: f.at(149, 81, 79), floor: 'grass_block', visible: true, reach: true } });
    expect(out.limited).toBe(true); // 25 retained cells do not stand for all 2590 logs in the scan.
    expect(out.reads).toBe(f.reads());
  });

  it.each([[320, 17, -240], [-40, -90, 80]])('translates the observed geometry by %j', (dx, dy, dz) => {
    const f = fixture([dx, dy, dz], 'birch'), out = drain(f.read, f.hits);
    expect(out.candidates[0].lowest).toMatchObject(f.at(150, 81, 79));
    expect(out.candidates[0].stand).toMatchObject({ at: f.at(149, 81, 79), visible: true, reach: true });
  });

  it('does not turn unloaded support or feet/head into a floor certificate', () => {
    const f = fixture(), out = drain(() => null, f.hits);
    expect(out.unread).toBe(true);
    expect(out.candidates[0].support).toBeNull();
    expect(out.candidates[0].stand).toBeNull();
  });

  it('uses the sample for distinct observed groups instead of repeating four cells of the first tree', () => {
    const first = fixture(), second = fixture([30, 0, 0]);
    const cells = new Map([...first.cells, ...second.cells]);
    const hits = [...first.hits, ...second.hits].map(p => ({ ...p,
      distance: Math.hypot(p.x + .5 - first.origin.x, p.y - first.origin.y, p.z + .5 - first.origin.z) }));
    const out = drain((x, y, z) => cells.get(`${x},${y},${z}`) ?? { name: 'air', solid: false }, hits);
    expect(out.candidates.map(p => [p.lowest.x, p.lowest.y, p.lowest.z])).toEqual([[150, 81, 79], [180, 81, 79]]);
  });

  it('does not label water above a real floor as a dry adjacent stand', () => {
    const f = fixture();
    f.cells.set('149,81,79', { name: 'water', solid: false });
    f.cells.set('149,82,79', { name: 'water', solid: false });
    expect(drain(f.read, f.hits).candidates[0].stand).toBeNull();
  });

  it.each(['oak_log', 'oak_leaves'])('does not use adjacent/diagonally connected tree material (%s) as the harvest floor', floor => {
    const cells = new Map<string, MapBlock>([['0,0,0', { name: 'dirt', solid: true }],
      ['0,1,0', { name: 'oak_log', solid: true }], ['1,1,0', { name: floor, solid: true }],
      ['1,1,1', { name: 'oak_log', solid: true }]]);
    const hits = [{ x: 0, y: 1, z: 0, name: 'oak_log', distance: 1 },
      ...(floor === 'oak_log' ? [{ x: 1, y: 1, z: 0, name: 'oak_log', distance: 2 }] : []),
      { x: 1, y: 1, z: 1, name: 'oak_log', distance: 3 }];
    const out = drain((x, y, z) => cells.get(`${x},${y},${z}`) ?? { name: 'air', solid: false }, hits);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].support?.name).toBe('dirt');
    expect(out.candidates[0].stand).toBeNull();
  });

  it('does not call a floating branch with leaves beneath it a supported trunk', () => {
    const hit = { x: 1, y: 8, z: 1, name: 'oak_log', distance: 1 };
    const out = drain((x, y, z) => x === 1 && z === 1 && y === 8 ? { name: 'oak_log', solid: true }
      : y === 7 ? { name: 'oak_leaves', solid: true } : { name: 'air', solid: false }, [hit]);
    expect(out.candidates[0].support).toBeNull();
  });

  it('retains bounded samples/groups/reads and gives the slice clock a turn between small reads', () => {
    const hits = Array.from({ length: 1000 }, (_, i) => ({ x: i * 4, y: 1, z: 0, name: 'oak_log', distance: i }));
    let reads = 0, before = 0, maxBetween = 0, yields = 0;
    const work = inspectLogCandidates((_x, y) => { reads++; return { name: y === 0 ? 'dirt' : y === 1 ? 'oak_log' : 'air', solid: y <= 1 }; }, hits, 1000);
    let out: ReturnType<typeof drain>;
    for (;;) {
      const step = work.next(); maxBetween = Math.max(maxBetween, reads - before); before = reads;
      if (step.done) { out = step.value; break; }
      yields++;
    }
    expect(out.retained).toBe(LOG_SAMPLE_LIMIT);
    expect(out.candidates.length).toBeLessThanOrEqual(LOG_GROUP_LIMIT);
    expect(reads).toBeLessThanOrEqual(LOG_READ_LIMIT);
    expect(out.reads).toBe(reads);
    expect(out.limited).toBe(true);
    expect(maxBetween).toBeLessThanOrEqual(64);
    expect(yields).toBeGreaterThan(2);
  });

  it('adds facts to the existing scan rows without changing counts, area, or starting path searches', async () => {
    const f = fixture(), scan = { found: new Map([['log:oak', { count: 2590, hits: f.hits }],
      ['water', { count: 12, hits: [{ x: 120, y: 62, z: 78, name: 'water', distance: 10 }] }]]),
      chunks: 442, reachMetres: 212, ms: 1, longestSliceMs: 1, partial: false } as SlicedScanResult;
    let pauses = 0;
    const slicer = { due: () => true, pause: async () => { pauses++; } } as unknown as LoopSlicer;
    const reads = await readScanSliced({}, scan, f.read, slicer);
    const out = summarizeScan({}, scan, f.origin, f.read, reads);
    expect(pauses).toBeGreaterThanOrEqual(C1_LOGS.length);
    expect(out.rows.length).toBeLessThanOrEqual(20);
    expect(out.rows[0]).toContain('原木 oak ×2590');
    expect(out.rows[0]).toContain('下端候補 (150,81,79)');
    expect(out.rows[0]).toContain('隣床 (149,81,79)');
    expect(out.rows[0]).toContain('経路未確認');
    expect(out.rows[0].length).toBeLessThanOrEqual(120);
    expect(out.rows[0].slice(0, 120)).toMatch(/隣床 .*面可・届く/u);
    expect(out.rows.find(row => row.startsWith('水源'))).toContain('×12');
    expect(out.chunks).toBe(442); expect(out.reach).toBe(212);
  });

  it('keeps the qualifications and whole coordinates before the head clips a row at 120 characters', () => {
    const f = fixture([29_999_800, 200, -29_999_800], 'pale_oak');
    const scan = { found: new Map([['log:pale_oak', { count: 2590, hits: f.hits }]]),
      chunks: 442, reachMetres: 212, ms: 1, longestSliceMs: 1 } as SlicedScanResult;
    const line = summarizeScan({}, scan, f.origin, f.read).rows[0];
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.slice(0, 120)).toContain('経路未確認');
    expect(line.slice(0, 120)).toContain('打切');
    expect(line.slice(0, 120)).toContain('(29999950,281,-29999721)');
    expect(line.slice(0, 120)).toContain('(29999949,281,-29999721)');
    expect(line.slice(0, 120)).toContain('面可・届く');
  });

  it('keeps a stopped world scan explicitly partial even when all of its retained logs fit', () => {
    const f = fixture();
    const scan = { found: new Map([['log:oak', { count: f.hits.length, hits: f.hits }]]),
      chunks: 1, reachMetres: 16, ms: 1, longestSliceMs: 1, partial: true } as SlicedScanResult;
    const out = summarizeScan({}, scan, f.origin, f.read);
    expect(out.partial).toBe(true);
    expect(out.rows[0]).toContain('打切');
  });
});
