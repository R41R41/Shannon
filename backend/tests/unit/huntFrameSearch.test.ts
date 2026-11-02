import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_SEARCH_MAX, nextSurveyPoints, ringPoints, surveyOf, uncovered } from '../../src/services/minebot/utils/huntFrameSearch.js';

// The end portal's frames (S2, 2026-11-02): only `end_portal_frame` is the portal room, over the whole height, within a radius of a centre; with none, the rings of points 16 apart.

let hits: Array<{ name: string; position: Vec3; distance: number }> = [];
let reach = 96;
const queries: Array<{ names: string[]; maxDistance?: number }> = [];
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', () => ({
  scanLoadedBlocks: vi.fn((_bot: unknown, names: Iterable<string>, options: { maxDistance?: number } = {}) => {
    const wanted = [...names];
    queries.push({ names: wanted, maxDistance: options.maxDistance });
    return { hits: hits.filter(hit => wanted.includes(hit.name)), reachMetres: reach, columns: 49, sectionsScanned: 3 };
  }),
}));
const { default: FindStructure } = await import('../../src/services/minebot/instantSkills/findStructure.js');

const frameAt = (x: number, y: number, z: number, from: Vec3) => ({ name: 'end_portal_frame', position: new Vec3(x, y, z), distance: from.distanceTo(new Vec3(x, y, z)) });

describe('the rings of the survey', () => {
  it('rings at 16, 32 ... with points 16 apart along each side: 8 on the first, 16 on the second, 8k on the k-th', () => {
    const points = ringPoints({ x: 0, z: 0 }, 128);
    expect(points.filter(point => point.ring === 16)).toHaveLength(8);
    expect(points.filter(point => point.ring === 32)).toHaveLength(16);
    expect(points.filter(point => point.ring === 128)).toHaveLength(64);
    expect(points).toHaveLength(8 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8));
    for (const point of points) expect(Math.max(Math.abs(point.x), Math.abs(point.z))).toBe(point.ring);
    expect(new Set(points.map(point => `${point.x},${point.z}`)).size).toBe(points.length);
  });

  it('a radius beyond 128 is cut at 128, and the rings are the inside out', () => {
    const points = ringPoints({ x: 0, z: 0 }, 500);
    expect(Math.max(...points.map(point => point.ring))).toBe(FRAME_SEARCH_MAX);
    const order = points.map(point => point.ring);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('each ring starts at the point nearest the body, and goes round', () => {
    const points = ringPoints({ x: 0, z: 0 }, 32, { x: 30, z: 0 }).filter(point => point.ring === 32);
    expect(points[0]).toMatchObject({ x: 32, z: 0 });
    expect(points).toHaveLength(16);
  });

  it('a point inside the area a scan has already read is not walked to; the next ones are the innermost ring left, nearest the body first', () => {
    const all = ringPoints({ x: 0, z: 0 }, 128);
    const scans = [{ x: 0, z: 0, reach: 64 }];                       // trusted to 48
    const left = uncovered(all, scans);
    expect(left.every(point => Math.hypot(point.x, point.z) > 48)).toBe(true);
    expect(left.some(point => point.ring === 32)).toBe(false);
    const next = nextSurveyPoints(all, scans, { x: 100, z: 0 });
    expect(next.length).toBeGreaterThan(0);
    expect(new Set(next.map(point => point.ring)).size).toBe(1);
    expect(next[0].ring).toBe(48);
    // (48, 0) is within the 48 trusted from the scan at the centre; the nearest to the body of what is left is the next point.
    expect(next.some(point => point.x === 48 && point.z === 0)).toBe(false);
    expect(next[0]).toMatchObject({ x: 48, z: -16 });
    const distances = next.map(point => Math.hypot(point.x - 100, point.z));
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    expect(nextSurveyPoints(all, [{ x: 0, z: 0, reach: 400 }], { x: 0, z: 0 })).toEqual([]);
  });

  it('the survey is kept for a centre (within 24 blocks of the last), and a new centre begins a new one', () => {
    const holder: { frameSurvey?: any } = {};
    const first = surveyOf(holder, { x: 100, z: 100 }, 64);
    first.scans.push({ x: 100, z: 100, reach: 80 });
    expect(surveyOf(holder, { x: 110, z: 95 }, 64)).toBe(first);
    expect(surveyOf(holder, { x: 300, z: 100 }, 64)).not.toBe(first);
  });
});

describe('find-structure stronghold: the portal room\'s frames', () => {
  const body = new Vec3(100, 70, 100);
  const makeBot = () => ({ version: '1.21.11', entity: { position: body.clone() }, registry: {}, world: {}, blockAt: () => ({ getProperties: () => ({ eye: false }) }) }) as any;

  it('finds the frames far below the surface, by the level distance to the centre, and lists them nearest first', async () => {
    hits = [frameAt(110, 24, 96, body), frameAt(112, 24, 100, body), frameAt(300, 24, 100, body)];
    queries.length = 0;
    const result = await new FindStructure(makeBot()).runImpl('stronghold', 64);
    expect(result.success).toBe(true);
    expect(result.result).toContain('エンドポータルの枠を発見: 2個');
    expect(result.result).toContain('(110, 24, 96)');
    expect(result.result).not.toContain('(300, 24, 100)');
    expect(result.result).toContain('高さ -46');
    // The scan was asked with the 3D reach wide enough for a room 46 blocks below (the level distance is cut by the radius).
    expect(queries[0].names).toEqual(['end_portal_frame']);
    expect(queries[0].maxDistance!).toBeGreaterThan(64 + 46);
  });

  it('a centre of its own: the frames are measured from it, not from the body', async () => {
    hits = [frameAt(110, 24, 96, body)];
    const near = await new FindStructure(makeBot()).runImpl('stronghold', 16, 400, 400);
    expect(near.result).toContain('エンドポータルの枠はありません');
    expect(near.result).toContain('中心 (400, 400)');
    const far = await new FindStructure(makeBot()).runImpl('stronghold', 30, 105, 98);
    expect(far.result).toContain('エンドポータルの枠を発見');
  });

  it('none in the loaded chunks: where the infested bricks are, and the next ring points to walk (those no scan covers)', async () => {
    hits = [{ name: 'infested_stone_bricks', position: new Vec3(140, 30, 100), distance: 60 }];
    reach = 64;
    const bot = makeBot();
    const result = await new FindStructure(bot).runImpl('stronghold', 128);
    expect(result.success).toBe(true);
    expect(result.result).toContain('エンドポータルの枠はありません');
    expect(result.result).toContain('infested_stone_bricks');
    expect(result.result).toMatch(/輪（16ブロック刻み）の次の点/u);
    expect(result.result).toContain('輪48');
    expect(result.result).toContain('use item=ender_eye');
    // The body has been here: a second call from where it is covers the same ring, a call from the next point asks for the points beyond.
    bot.entity.position = new Vec3(148, 70, 100);
    const again = await new FindStructure(bot).runImpl('stronghold', 128);
    expect(again.result).toContain('輪');
  });

  it('the whole radius read: it says the ring is done and the centre may be wrong, instead of more points', async () => {
    hits = [];
    reach = 400;
    const result = await new FindStructure(makeBot()).runImpl('stronghold', 64);
    expect(result.result).toContain('見終わった');
    expect(result.result).toContain('交点を引き直す');
  });

  it('the radius is held between 16 and 128', async () => {
    hits = [];
    reach = 40;
    const huge = await new FindStructure(makeBot()).runImpl('stronghold', 5000);
    expect(huge.result).toContain('半径128m');
    const tiny = await new FindStructure(makeBot()).runImpl('stronghold', 1);
    expect(tiny.result).toContain('半径16m');
  });
});
