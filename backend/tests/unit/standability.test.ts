import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import * as standing from '../../src/services/minebot/utils/standability.js';
import type { StandBlock, StandCell, StandReader } from '../../src/services/minebot/utils/standability.js';
import { laneReport } from '../../src/services/minebot/utils/huntLane.js';
import { fill } from '../../src/services/minebot/utils/primitives/fill.js';
import { go, hazardAtFeetWith } from '../../src/services/minebot/utils/primitives/go.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';

vi.mock('../../src/services/minebot/utils/primitives/go.js', async original => ({
  ...await original<typeof import('../../src/services/minebot/utils/primitives/go.js')>(), go: vi.fn(),
}));
vi.mock('../../src/services/minebot/utils/primitives/place.js', () => ({ place: vi.fn() }));
vi.mock('../../src/services/minebot/utils/primitives/dig.js', () => ({ dig: vi.fn() }));

const p = { x: 5, y: 20, z: 0 }, key = (p: StandCell) => `${p.x},${p.y},${p.z}`;
const air: StandBlock = { name: 'air', boundingBox: 'empty' }, stone: StandBlock = { name: 'stone', boundingBox: 'block' };
const world = (changes: Record<string, StandBlock | null> = {}): StandReader => (x, y, z) =>
  `${x},${y},${z}` in changes ? changes[`${x},${y},${z}`] : y < 20 ? stone : air;
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('standableAt: the shared loaded-cell model', () => {
  it.each(['stone_stairs', 'stone_slab', 'oak_fence'])('accepts a shaped %s floor', name => {
    const read = world({ '5,19,0': { name, boundingBox: 'empty', shapes: [[0, 0, 0, 1, 0.5, 1]] } });
    expect(standing.standableAt(read, p)).toEqual({ ok: true, why: 'ok', floor: name });
    expect(standing.standableAt(world({ '5,19,0': { name, boundingBox: 'block' } }), p).ok).toBe(true);
  });

  it.each(['fire', 'soul_fire'])('rejects %s in the body, at all four sides of floor/feet/head, and above', name => {
    const cells = [p, { ...p, y: 21 }, { ...p, y: 22 }];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [19, 20, 21]) cells.push({ x: p.x + dx, y, z: p.z + dz });
    for (const fire of cells) {
      const read = world({ [key(fire)]: { name, boundingBox: 'empty' } });
      expect(standing.standableAt(read, p)).toMatchObject({ ok: false, why: 'fire_near' });
      expect(standing.standabilityFires(read, p)).toContainEqual(fire);
    }
    expect(standing.standableAt(world({ '6,20,1': { name, boundingBox: 'empty' } }), p).ok).toBe(true);
  });

  it.each(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose'])('rejects a %s floor even with collision shapes', name => {
    expect(standing.standableAt(world({ '5,19,0': { ...stone, name } }), p)).toEqual({ ok: false, why: 'floor_hazard', floor: name });
  });

  it.each([20, 21])('requires an open body cell at y=%i', y => {
    expect(standing.standableAt(world({ [`5,${y},0`]: stone }), p).why).toBe('no_head_room');
    for (const name of ['lava', 'water', 'powder_snow', 'sweet_berry_bush', 'wither_rose']) {
      expect(standing.standableAt(world({ [`5,${y},0`]: { name, boundingBox: 'empty' } }), p).why).toBe('hazard_near');
    }
  });

  it.each(['lava', 'magma_block', 'cactus'])('matches go for %s beside the feet and head', name => {
    for (const y of [20, 21]) {
      const read = world({ [`6,${y},0`]: { name, boundingBox: 'empty' } });
      expect(hazardAtFeetWith((x, y, z) => read(x, y, z)?.name ?? null, p.x, p.y, p.z)).not.toBeNull();
      expect(standing.standableAt(read, p).why).toBe('hazard_near');
    }
    expect(standing.standableAt(world({ '5,22,0': { name: 'lava', boundingBox: 'empty' } }), p).why).toBe('hazard_near');
  });

  it.each(['5,19,0', '5,20,0', '5,21,0', '5,22,0', '6,19,0', '4,20,0', '5,21,1'])('rejects an unloaded required cell %s', at => {
    expect(standing.standableAt(world({ [at]: null }), p)).toMatchObject({ ok: false, why: 'unloaded' });
  });

  it('does not invent a floor and accepts legacy CampReader solid flags', () => {
    expect(standing.standableAt(world({ '5,19,0': air }), p)).toEqual({ ok: false, why: 'no_floor', floor: 'air' });
    expect(standing.standableAt((_x, y) => ({ name: y < 20 ? 'stone' : 'air', solid: y < 20 }), p).ok).toBe(true);
  });

  it('excludes planned body/floor cells regardless of their current contents, without mutating the reader', () => {
    const read = vi.fn(world());
    for (const at of ['5,20,0', '5,21,0']) expect(standing.standableAt(read, p, { ignore: new Set([at]) }).why).toBe('no_head_room');
    expect(standing.standableAt(read, p, { ignore: new Set(['5,19,0']) }).why).toBe('no_floor');
    expect(standing.standableAt(read, p).ok).toBe(true);
    expect(read(5, 19, 0)).toBe(stone);
    expect(read(5, 20, 0)).toBe(air);
  });
});

describe('probe and fill use the same standableAt decision', () => {
  it.each(['stone', 'stone_stairs', 'stone_slab', 'fire', 'water', 'unloaded', 'head_wall', 'near_fire'])('agrees on the same world with %s', async kind => {
    const changes: Record<string, StandBlock | null> = {};
    if (kind === 'unloaded') changes['5,19,0'] = null;
    else if (kind === 'head_wall') changes['5,21,0'] = stone;
    else if (kind === 'near_fire') changes['6,20,0'] = { name: 'fire', boundingBox: 'empty' };
    else changes['5,19,0'] = { name: kind, boundingBox: ['fire', 'water'].includes(kind) ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] };
    const read = world(changes), expected = standing.standableAt(read, p), spy = vi.spyOn(standing, 'standableAt');
    const report = laneReport(read, { x: 0, y: 20, z: 0 }, p);
    const first = report.candidates.find(c => c.direction === 'east')!.build[0];
    expect(first.standAt).toEqual(expected.ok ? p : null);
    expect(spy.mock.calls.some(([, cell]) => key(cell) === key(p))).toBe(true);
    spy.mockClear();
    const bot: any = Object.assign(new EventEmitter(), {
      health: 20, entities: {}, entity: { position: new Vec3(5.5, 20, 0.5), metadata: [0], onGround: true },
      registry: { blocksByName: { cobblestone: { id: 1 } } },
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
      blockAt: (at: Vec3) => read(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)),
    });
    vi.mocked(go).mockResolvedValue({ ok: true, text: '着いた' });
    vi.mocked(place).mockResolvedValue({ ok: true, text: '置いた' });
    // An unextinguished fire must stay a rejection in fill too.
    vi.mocked(dig).mockResolvedValue({ ok: false, text: '届かない' });
    const out = await fill({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, base: p, facing: 'north' }, {
      block: 'cobblestone', groups: [{ stand: p, at: [{ x: 5, y: 20, z: -1 }] }], retreatTo: p, retreatHp: 10, seconds: 30,
    });
    expect(out.fill.code).toBe(expected.ok ? null : 'NO_STAND');
    expect(out.fill.safe).toBe(expected.ok);
    expect(spy.mock.results[0].value).toEqual(expected);
    if (!expected.ok) expect(out.text).toContain(expected.why);
  });
});
