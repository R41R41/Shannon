import { Vec3 } from 'vec3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWNER } from './fixtures/blazeSpawnerRoom.js';

// `probe kind=frames` and `probe kind=camp` (S2, 2026-11-02): the LLM-centric mode calls the body's tools `act` and `probe` and no catalog skill, so the stronghold's frame search and the
// blaze spawner's camp cells (find-structure stronghold / blaze_spawner) are said by the probe too, from the same functions, as the contract's JSON: { v: 1, kind, text, ... }.

let hits: Array<{ name: string; position: Vec3; distance: number }> = [];
let reach = 96;
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', () => ({
  scanLoadedBlocks: vi.fn((_bot: unknown, names: Iterable<string>) => {
    const wanted = [...names];
    return { hits: hits.filter(hit => wanted.includes(hit.name)), reachMetres: reach, columns: 49, sectionsScanned: 3 };
  }),
}));
vi.mock('../../src/services/minebot/utils/localMap.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/localMap.js')>();
  const { ground } = await import('./fixtures/blazeSpawnerRoom.js');
  const floor = (value: number) => Math.floor(value);
  return { ...actual, bodyReader: () => ground(), feetCell: (bot: any) => ({ x: floor(bot.entity.position.x), y: floor(bot.entity.position.y), z: floor(bot.entity.position.z) }) };
});
const { runProbe, PROBE_KINDS } = await import('../../src/services/minebot/instantSkills/probe.js');
const { default: FindStructure } = await import('../../src/services/minebot/instantSkills/findStructure.js');

const frameAt = (x: number, y: number, z: number, from: Vec3) => ({ name: 'end_portal_frame', position: new Vec3(x, y, z), distance: from.distanceTo(new Vec3(x, y, z)) });
const makeBot = (position: Vec3, dimension = 'the_nether') => ({ version: '1.21.11', entity: { position: position.clone() }, game: { dimension }, registry: {}, world: {}, entities: {}, blockAt: () => ({ getProperties: () => ({ eye: false }) }) }) as any;
const parse = (answer: { success: boolean; result: string }) => ({ success: answer.success, ...JSON.parse(answer.result) });

beforeEach(() => { hits = []; reach = 96; });

describe('the kinds', () => {
  it('frames and camp are probe kinds', () => {
    expect(PROBE_KINDS).toContain('frames');
    expect(PROBE_KINDS).toContain('camp');
  });
});

describe('probe kind=camp', () => {
  const body = new Vec3(-102.5, 56, -113.5);
  it('names the spawner and the cells within three blocks with no edge and no fire, nearest the room\'s walls first, as the contract\'s JSON', async () => {
    hits = [{ name: 'spawner', position: new Vec3(SPAWNER.x, SPAWNER.y, SPAWNER.z), distance: body.distanceTo(new Vec3(SPAWNER.x, SPAWNER.y, SPAWNER.z)) }];
    const raw = await runProbe(makeBot(body), { kind: 'camp' });
    const answer = parse(raw);
    expect(answer).toMatchObject({ success: true, v: 1, kind: 'camp', found: true, spawner: { x: -101, y: 56, z: -115 } });
    expect(answer.text).toContain('ブレイズの湧き場を発見');
    expect(answer.text).toContain('野営向きの足場');
    expect(answer.cells.length).toBeGreaterThan(0);
    expect(answer.cells.length).toBeLessThanOrEqual(4);
    expect(answer.cells[0]).toMatchObject({ y: 56, pits: 0 });
    expect(answer.fire).toBe(0);
    expect(Object.keys(JSON.parse(raw.result)).slice(0, 3)).toEqual(['v', 'kind', 'text']);   // the sentence first, as the contract has it
  });

  it('says the same as find-structure blaze_spawner', async () => {
    hits = [{ name: 'spawner', position: new Vec3(SPAWNER.x, SPAWNER.y, SPAWNER.z), distance: 3 }];
    const probe = parse(await runProbe(makeBot(body), { kind: 'camp' }));
    const skill = await new FindStructure(makeBot(body)).runImpl('blaze_spawner');
    expect(skill.success).toBe(true);
    expect(skill.result).toBe(probe.text);
  });

  it('outside the Nether it says where the spawners are; with none loaded it says to walk the fortress', async () => {
    const overworld = parse(await runProbe(makeBot(body, 'overworld'), { kind: 'camp' }));
    expect(overworld).toMatchObject({ found: false, cells: [] });
    expect(overworld.text).toContain('ネザー要塞の中にある');
    const none = parse(await runProbe(makeBot(body), { kind: 'camp' }));
    expect(none).toMatchObject({ found: false, cells: [] });
    expect(none.text).toContain('湧き場はありません');
    expect(none.text).toContain('find-structure fortress');
  });
});

describe('probe kind=frames', () => {
  const body = new Vec3(100, 70, 100);
  it('lists the frames within the radius of the centre nearest first with their eyes, as JSON; the radius is held between 16 and 128', async () => {
    hits = [frameAt(110, 24, 96, body), frameAt(112, 24, 100, body), frameAt(300, 24, 100, body)];
    const answer = parse(await runProbe(makeBot(body), { kind: 'frames', radius: 64 }));
    expect(answer).toMatchObject({ success: true, v: 1, kind: 'frames', radius: 64, center: { x: 100, z: 100 } });
    expect(answer.found).toHaveLength(2);
    expect(answer.found[0]).toMatchObject({ x: 110, y: 24, z: 96 });
    expect(answer.next).toEqual([]);
    expect(answer.text).toContain('エンドポータルの枠を発見: 2個');
    const huge = parse(await runProbe(makeBot(body), { kind: 'frames', radius: 5000 }));
    expect(huge.radius).toBe(128);
    const tiny = parse(await runProbe(makeBot(body), { kind: 'frames', radius: 1 }));
    expect(tiny.radius).toBe(16);
    const unset = parse(await runProbe(makeBot(body), { kind: 'frames' }));
    expect(unset.radius).toBe(64);
  });

  it('a centre of its own (x, z); with no frame in the loaded chunks the next ring points to walk are in `next`, and the sentence says so', async () => {
    hits = [];
    reach = 64;
    const answer = parse(await runProbe(makeBot(body), { kind: 'frames', radius: 128, x: 400, z: 400 }));
    expect(answer.center).toEqual({ x: 400, z: 400 });
    expect(answer.found).toEqual([]);
    expect(answer.next.length).toBeGreaterThan(0);
    expect(answer.next[0]).toHaveProperty('ring');
    expect(answer.text).toContain('輪（16ブロック刻み）の次の点');
  });

  it('says the same as find-structure stronghold', async () => {
    hits = [frameAt(110, 24, 96, body)];
    const probe = parse(await runProbe(makeBot(body), { kind: 'frames', radius: 64, x: 100, z: 100 }));
    const skill = await new FindStructure(makeBot(body)).runImpl('stronghold', 64, 100, 100);
    expect(skill.result).toBe(probe.text);
  });
});
