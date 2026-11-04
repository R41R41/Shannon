import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as danger from '../../src/services/minebot/utils/dragonDanger.js';
import type { Hazard } from '../../src/services/minebot/utils/dragonDanger.js';
import { bodyBoxAt, boxesOverlap } from '../../src/services/minebot/utils/dragonParts.js';
import { dragonCloudEscapePlan, fleeHeadingPlan, installFloorReflexes, runDragonRetreat } from '../../src/services/minebot/utils/floorReflexes.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { pillarUp } from '../../src/services/minebot/utils/primitives/pillarUp.js';

vi.mock('../../src/services/minebot/utils/primitives/pillarUp.js', () => ({ pillarUp: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); });

const realHazards = danger.dragonHazards;
const block = (name: string, position: Vec3) => ({ name, position, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] });
function fixture(corner = true) {
  let yaw = 0;
  const walked: Vec3[] = [], keys: Array<[string, boolean]> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    game: { dimension: 'minecraft:the_end' }, health: 20, food: 20,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) }, entities: {},
    registry: { entitiesByName: { area_effect_cloud: { metadataKeys: ['radius', 'particle'] } } },
    inventory: { items: () => [{ name: 'obsidian', type: 1, count: 3 }], slots: [] },
    // Three walls close to the body, with level ground to the west. This is not a lab coordinate fixture.
    blockAt: (p: Vec3) => block(p.y < 64 || (corner && p.y < 66 && ((p.x === 1 && Math.abs(p.z) <= 1) || (Math.abs(p.z) === 1 && p.x >= 0 && p.x <= 1))) ? 'end_stone' : 'air', p),
    look: vi.fn((y: number) => { yaw = y; }),
    setControlState: vi.fn((key: string, value: boolean) => {
      keys.push([key, value]);
      if (key === 'forward' && value) { bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * 0.6, 0, -Math.cos(yaw) * 0.6); walked.push(bot.entity.position.clone()); }
    }),
    clearControlStates: vi.fn(), equip: vi.fn(async () => undefined), consume: vi.fn(async () => undefined),
  });
  cloud(bot, 20, new Vec3(0.5, 64, 0.5));
  return { bot, walked, keys };
}
function cloud(bot: any, id: number, position: Vec3) {
  bot.entities[id] = { id, name: 'area_effect_cloud', position, metadata: [7, { type: 'dragon_breath' }] };
}
/** Synthetic overlapping wing boxes: every turn approaches one wing centre, but the boxes only push. */
function wingsAround(bot: any, extra: Hazard[] = []) {
  const box = { minX: -20, maxX: 20, minY: 63, maxY: 67, minZ: -20, maxZ: 20 };
  const wings: Hazard[] = [[4, 0], [-4, 0], [0, 4], [0, -4]].map(([x, z]) => ({ kind: 'wing', centre: { x: 0.5 + x, y: 65, z: 0.5 + z }, radius: 0, box, why: 'test wing push' }));
  const spy = vi.spyOn(danger, 'dragonHazards').mockImplementation((b, options = {}) => [
    ...realHazards(b, options), ...[...wings, ...extra].filter(h => (options.along ?? [b.entity.position]).some(at => boxesOverlap(h.box!, bodyBoxAt(at)))),
  ]);
  expect(fleeHeadingPlan(bot, danger.hazardCentres(danger.dragonHazards(bot)), undefined, { noJump: true, wide: true })).toBeNull();
  return spy;
}
const forward = (keys: Array<[string, boolean]>) => keys.filter(([k, v]) => k === 'forward' && v);

describe('the cloud escape after the ordinary dragon retreat has no heading', () => {
  it('(a) walks out through wing push when all ordinary turns are vetoed, with no jump, sprint or pillar', async () => {
    const f = fixture(); wingsAround(f.bot);
    const done = await runDragonRetreat(f.bot, f.bot, 1);
    expect(forward(f.keys).length).toBeGreaterThan(0);
    expect(done.moved).toBeGreaterThan(8.5);
    expect(realHazards(f.bot).some(h => h.kind === 'breath')).toBe(false);
    expect(f.keys.filter(([k, v]) => (k === 'jump' || k === 'sprint') && v)).toEqual([]);
    expect(f.keys.slice(-5).every(([, value]) => !value)).toBe(true);
  });

  it('also starts the fallback through dragonTick, rather than refusing it or choosing the pillar', async () => {
    vi.mocked(pillarUp).mockClear();
    const f = fixture(); wingsAround(f.bot);
    installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    f.bot.emit('physicsTick');
    const end = Date.now() + 2000;
    while (f.bot.floorReflexes.busy && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    expect(forward(f.keys).length).toBeGreaterThan(0);
    expect(realHazards(f.bot).some(h => h.kind === 'breath')).toBe(false);
    expect(pillarUp).not.toHaveBeenCalled();
    expect(f.bot.reflexLedger.entriesSince(0).some((entry: any) => entry.kind === 'retreat')).toBe(true);
  });

  it('continues walking when an ordinary retreat loses its heading after it has already started', async () => {
    const f = fixture(false), write = f.bot.setControlState, read = f.bot.blockAt;
    let changed = false;
    f.bot.setControlState = vi.fn((key: string, value: boolean) => {
      if (changed || key !== 'forward' || !value) { write(key, value); return; }
      f.keys.push([key, value]); // first control tick: the body has not gained speed yet
      changed = true;
      // On the next look, three newly read walls leave the west open; wings veto that turn by centre repulsion.
      f.bot.blockAt = (p: Vec3) => p.y >= 64 && p.y < 66 && ((p.x === 1 && Math.abs(p.z) <= 1) || (Math.abs(p.z) === 1 && p.x >= 0 && p.x <= 1)) ? block('end_stone', p) : read(p);
      wingsAround(f.bot);
    });
    const done = await runDragonRetreat(f.bot, f.bot, 1);
    expect(changed).toBe(true); expect(done.ended).not.toBe('blocked');
    expect(done.moved).toBeGreaterThan(8.5);
    expect(realHazards(f.bot).some(h => h.kind === 'breath')).toBe(false);
  });

  it.each(['head', 'neck'] as const)('(b) refuses every route in %s contact even though wing push alone could be crossed', async kind => {
    const f = fixture();
    wingsAround(f.bot, [{ kind, centre: { x: 0.5, y: 65, z: 0.5 }, radius: 0, box: { minX: -20, maxX: 20, minY: 63, maxY: 67, minZ: -20, maxZ: 20 }, why: `test ${kind}` }]);
    expect(dragonCloudEscapePlan(f.bot, danger.dragonHazards(f.bot))).toBeNull();
    const done = await runDragonRetreat(f.bot, f.bot, 1);
    expect(done.ended).toBe('blocked'); expect(forward(f.keys)).toEqual([]);
  });

  it('(c) exits sideways while a fireball is still in the air: never approaches its line and never pillars', async () => {
    vi.mocked(pillarUp).mockClear();
    const f = fixture();
    f.bot.entities[41] = { id: 41, name: 'dragon_fireball', position: new Vec3(0.5, 70, 0.5), velocity: new Vec3(0, -0.5, 0) };
    wingsAround(f.bot);
    expect(realHazards(f.bot).some(h => h.kind === 'fireball')).toBe(true);
    installFloorReflexes(f.bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    f.bot.emit('physicsTick');
    const end = Date.now() + 2000;
    while (f.bot.floorReflexes.busy && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5))).toBeGreaterThan(8.5);
    expect(realHazards(f.bot).some(h => h.kind === 'breath' || h.kind === 'fireball')).toBe(false);
    const distances = f.walked.map(p => Math.hypot(p.x - 0.5, p.z - 0.5));
    expect(distances.every((d, i) => i === 0 || d >= distances[i - 1] - 1e-6)).toBe(true);
    expect(f.bot.entities[41]).toBeDefined(); expect(pillarUp).not.toHaveBeenCalled();
  });

  it('(d) keeps the ordinary successful retreat and does not search fallback routes', async () => {
    const f = fixture(false);
    const expected = fleeHeadingPlan(f.bot, danger.hazardCentres(realHazards(f.bot)), undefined, { noJump: true, wide: true })!;
    const spy = vi.spyOn(danger, 'dragonHazards');
    const done = await runDragonRetreat(f.bot, f.bot, 1);
    expect(done.ended).toBe('clear'); expect(done.moved).toBeGreaterThan(8.5);
    expect(f.bot.look.mock.calls[0][0]).toBe(expected.yaw);
    expect(spy.mock.calls.every(([, options]) => !options?.along)).toBe(true);
  });

  it('ranks a nearer horizontal edge first, and never treats a newly approached cloud as an allowed current cloud', () => {
    const f = fixture(false); f.bot.entity.position = new Vec3(-2.5, 64, 0.5);
    const current = realHazards(f.bot);
    const plan = dragonCloudEscapePlan(f.bot, current)!;
    expect(-Math.sin(plan.yaw)).toBeCloseTo(-1); expect(-Math.cos(plan.yaw)).toBeCloseTo(0);
    cloud(f.bot, 21, new Vec3(-10, 64, 0.5)); // outside this cloud now, but the shortest west route would enter it
    const choices: Vec3[][] = [];
    const spy = vi.spyOn(danger, 'dragonHazards').mockImplementation((b, opts = {}) => {
      if (opts.along) choices.push([...opts.along] as Vec3[]);
      return realHazards(b, opts);
    });
    const other = dragonCloudEscapePlan(f.bot, realHazards(f.bot, { clearance: 1.5 }), undefined, plan.cloudEscape);
    expect(other).not.toBeNull(); expect(-Math.sin(other!.yaw)).toBeGreaterThan(-0.99);
    const chosen = choices.at(-1)!;
    expect(realHazards(f.bot, { along: chosen }).some(h => h.centre.x === -10)).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it.each(['void', 'wall', 'jump', 'lava', 'unknown'] as const)('does not trade the cloud for %s along the whole exit route beyond the ordinary 5 m look-ahead', kind => {
    const f = fixture(false), base = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => {
      if (Math.hypot(p.x, p.z) < 6) return base(p);
      if (kind === 'unknown') return null;
      if (kind === 'void') return block('air', p);
      if (kind === 'lava' && p.y === 63) return { ...block('air', p), name: 'lava' };
      return (kind === 'wall' && p.y < 67) || (kind === 'jump' && p.y < 65) ? block('end_stone', p) : base(p);
    };
    expect(dragonCloudEscapePlan(f.bot, realHazards(f.bot))).toBeNull();
  });
});

describe('danger along the cloud exit, including hazards not at the current body position', () => {
  it('finds head and neck contact along a route even when neither reaches the current body', () => {
    const f = fixture(false);
    f.bot.registry.entitiesByName.ender_dragon = { metadataKeys: ['phase'] };
    f.bot.entities[100] = { id: 100, name: 'ender_dragon', position: new Vec3(-15, 66, 0.5), yaw: Math.PI / 2, metadata: [6] };
    expect(realHazards(f.bot).some(h => h.kind === 'head' || h.kind === 'neck')).toBe(false);
    const crossed = realHazards(f.bot, { along: [new Vec3(-8.5, 64, 0.5)] });
    expect(crossed.map(h => h.kind)).toEqual(expect.arrayContaining(['head', 'neck']));
  });
  it('finds the predicted flame along a route before the body walks into it', () => {
    const f = fixture(false);
    f.bot.registry.entitiesByName.ender_dragon = { metadataKeys: ['phase'] };
    f.bot.entities[100] = { id: 100, name: 'ender_dragon', position: new Vec3(-20, 66, 0.5), yaw: Math.PI / 2, metadata: [5] };
    expect(realHazards(f.bot).some(h => h.kind === 'flame')).toBe(false);
    expect(realHazards(f.bot, { along: [new Vec3(-6, 64, 0.5)] }).some(h => h.kind === 'flame')).toBe(true);
  });
  it('uses the actual ground height for the cloud slab', () => {
    const f = fixture(false); cloud(f.bot, 21, new Vec3(-10, 64, 0.5));
    expect(realHazards(f.bot).some(h => h.centre.x === -10)).toBe(false);
    expect(realHazards(f.bot, { along: [new Vec3(-5, 64, 0.5)] }).some(h => h.centre.x === -10)).toBe(true);
    expect(realHazards(f.bot, { along: [new Vec3(-5, 65, 0.5)] }).some(h => h.centre.x === -10)).toBe(false);
  });
  it('finds a fireball line away from the body, refuses entry and any approach while already inside, and allows only an exit', () => {
    const f = fixture(false);
    f.bot.entities[41] = { id: 41, name: 'dragon_fireball', position: new Vec3(-10, 70, 0.5), velocity: new Vec3(0, -0.5, 0) };
    expect(realHazards(f.bot).some(h => h.kind === 'fireball')).toBe(false);
    const line = realHazards(f.bot, { along: [new Vec3(-5, 64, 0.5)] }).find(h => h.kind === 'fireball')!;
    expect(line).toBeDefined();
    const at = (x: number) => new Vec3(x, 64, 0.5);
    expect(danger.exitsFireballLine(line, [at(0.5), at(-5)])).toBe(false);
    expect(danger.exitsFireballLine(line, [at(-5), at(-6), at(0.5)])).toBe(false);
    expect(danger.exitsFireballLine(line, [at(-5), at(0.5), at(-5)])).toBe(false);
    expect(danger.exitsFireballLine(line, [at(-5), at(-4), at(0.5)])).toBe(true);
  });
});
