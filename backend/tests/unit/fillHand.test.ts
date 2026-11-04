import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { fill, fillProblem, type FillArgs } from '../../src/services/minebot/utils/primitives/fill.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';
import { StepStopped, type StepContext } from '../../src/services/minebot/utils/primitives/common.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import * as actions from '../../src/services/minebot/execution/ActionExecution.js';
import { takeActReport } from '../../src/services/minebot/utils/actReport.js';

vi.mock('../../src/services/minebot/utils/primitives/go.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/minebot/utils/primitives/go.js')>(), go: vi.fn(),
}));
vi.mock('../../src/services/minebot/utils/primitives/place.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/minebot/utils/primitives/place.js')>(), place: vi.fn(),
}));
vi.mock('../../src/services/minebot/utils/primitives/dig.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/minebot/utils/primitives/dig.js')>(), dig: vi.fn(),
}));

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
function field() {
  const blocks = new Map<string, string | null>(), slots: any[] = Array(46).fill(null);
  slots[9] = { name: 'cobblestone', count: 96, type: 1, slot: 9 };
  const bot: any = Object.assign(new EventEmitter(), {
    health: 20, food: 20, oxygenLevel: 20, entities: {}, game: { dimension: 'the_nether' },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, metadata: [0], onGround: true },
    registry: { blocksByName: { cobblestone: { id: 1 } }, entitiesByName: { blaze: {} } },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) },
    shieldBlock: { enabled: true, up: true },
    blockAt: (p: Vec3) => {
      const at = p.floored(), name = blocks.has(key(at)) ? blocks.get(key(at)) : at.y < 64 ? 'stone' : 'air';
      if (name === null) return null;
      const partial = /_(stairs|slab|fence)$/u.test(name!);
      const solid = name === 'stone' || name === 'cobblestone' || partial;
      return { name, position: at, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, partial ? 0.5 : 1, 1]] : [], type: solid ? 1 : 0 };
    },
    setControlState: vi.fn(), clearControlStates: vi.fn(), deactivateItem: vi.fn(), activateItem: vi.fn(), stopDigging: vi.fn(),
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
  });
  const stop = new AbortController();
  const ctx: StepContext = { bot, stop: stop.signal, deadline: Date.now() + 60_000, base: { x: 0, y: 64, z: 0 }, facing: 'north' };
  const args: FillArgs = { block: 'cobblestone', groups: [{ stand: { x: 1, y: 64, z: 0 }, at: [{ x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }] }],
    seconds: 30, retreatHp: 10, retreatTo: { x: 0, y: 64, z: 0 } };
  const walk = async (_ctx: StepContext, a: Parameters<typeof go>[1]) => {
    bot.entity.position = new Vec3(a.goals[0].x + 0.5, a.goals[0].y, a.goals[0].z + 0.5);
    return { ok: true, text: '着いた' };
  };
  const lay = async (_ctx: StepContext, a: Parameters<typeof place>[1]) => {
    blocks.set(key(a.at[0]), a.block); slots[9].count--;
    return { ok: true, text: '置いた', progress: { unit: 'block' as const, done: 1, left: 0 } };
  };
  vi.mocked(go).mockImplementation(walk); vi.mocked(place).mockImplementation(lay);
  vi.mocked(dig).mockImplementation(async (_ctx, a) => {
    for (const at of a.at) blocks.set(key(at), 'air');
    return { ok: true, text: '火を消した' };
  });
  return { bot, blocks, slots, stop, ctx, args, walk, lay };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); vi.mocked(go).mockReset(); vi.mocked(place).mockReset(); vi.mocked(dig).mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fill preflight and plan boundary', () => {
  it.each(['unloaded', 'blocked', 'no_floor', 'no_blocks', 'hp'])('fails before any move or placement: %s', async why => {
    const f = field(), start = f.bot.entity.position.clone();
    if (why === 'unloaded') f.blocks.set(key(f.args.retreatTo), null);
    if (why === 'blocked') f.blocks.set(key(f.args.retreatTo), 'stone');
    if (why === 'no_floor') f.blocks.set('0,63,0', 'air');
    if (why === 'no_blocks') f.slots[9].count = 1;
    if (why === 'hp') f.bot.health = 10;
    const r = await fill(f.ctx, f.args);
    expect(r.ok).toBe(false);
    expect(r.fill).toMatchObject({ status: 'failed', placed: 0, code: why === 'hp' ? 'HP_FLOOR' : why === 'no_blocks' ? 'NO_BLOCKS' : 'NO_STAND' });
    expect(r.fill.remaining).toEqual(f.args.groups[0].at);
    expect(go).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled(); expect(f.bot.entity.position).toEqual(start);
  });
  it('accepts the maximum 12 groups of 8, and the act schema exposes fill and groups', () => {
    const { args } = field(); args.groups = Array.from({ length: 12 }, () => ({ stand: { x: 0, y: 64, z: 0 }, at: Array.from({ length: 8 }, (_, x) => ({ x, y: 65, z: 0 })) }));
    expect(fillProblem({ do: 'fill', ...args })).toBeNull();
    expect(ACT_HANDS.parse([{ do: 'fill', ...args }])[0].groups).toHaveLength(12);
  });
  it.each(['groups_empty', 'groups_13', 'at_empty', 'at_9', 'nan', 'infinite', 'missing_axis', 'relative', 'extra_group', 'extra_cell', 'missing_home', 'hp_zero', 'hp_20', 'seconds_4', 'seconds_61', 'extra_hand'])('rejects malformed input without motors: %s', async why => {
    const { args, ctx } = field(); const a: any = structuredClone(args);
    if (why === 'groups_empty') a.groups = [];
    if (why === 'groups_13') a.groups = Array(13).fill(a.groups[0]);
    if (why === 'at_empty') a.groups[0].at = [];
    if (why === 'at_9') a.groups[0].at = Array(9).fill(a.groups[0].at[0]);
    if (why === 'nan') a.groups[0].stand.x = NaN;
    if (why === 'infinite') a.groups[0].at[0].z = Infinity;
    if (why === 'missing_axis') delete a.groups[0].stand.y;
    if (why === 'relative') a.rel = true;
    if (why === 'extra_group') a.groups[0].other = 1;
    if (why === 'extra_cell') a.groups[0].at[0].front = 1;
    if (why === 'missing_home') delete a.retreatTo;
    if (why === 'hp_zero') a.retreatHp = 0;
    if (why === 'hp_20') a.retreatHp = 20;
    if (why === 'seconds_4') a.seconds = 4;
    if (why === 'seconds_61') a.seconds = 61;
    if (why === 'extra_hand') a.target = '#1';
    expect(fillProblem(a)).not.toBeNull(); await expect(fill(ctx, a)).rejects.toThrow('invalid_input');
    expect(go).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
    if (['groups_empty', 'groups_13', 'at_empty', 'at_9', 'nan', 'infinite', 'missing_axis', 'extra_group', 'extra_cell'].includes(why)) expect(ACT_HANDS.safeParse([{ do: 'fill', ...a }]).success).toBe(false);
  });
});

describe('fill shared standability and bounded extinguishing', () => {
  it.each(['stone_stairs', 'stone_slab', 'oak_fence'])('accepts %s under home and stand, including the actual fractional return height', async name => {
    const f = field();
    f.blocks.set('0,63,0', name); f.blocks.set('1,63,0', name);
    vi.mocked(go).mockImplementation(async (c, a) => {
      const out = await f.walk(c, a);
      if (key(a.goals[0]) === key(f.args.retreatTo)) f.bot.entity.position.y = 63.5;
      return out;
    });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 2, safe: true });
  });

  it.each(['0,64,0', '0,65,0', '-1,64,0', '0,66,0'])('extinguishes home fire at %s before moving, through dig with collect:false', async at => {
    const f = field(); f.blocks.set(at, 'fire');
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 2, safe: true });
    expect(dig).toHaveBeenCalledTimes(1);
    const [part, args] = vi.mocked(dig).mock.calls[0];
    expect(args).toEqual({ at: [Object.fromEntries(at.split(',').map((value, i) => [['x', 'y', 'z'][i], Number(value)]))], collect: false });
    expect(part.stop).not.toBe(f.ctx.stop);
    expect(vi.mocked(dig).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(go).mock.invocationCallOrder[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks and extinguishes a group stand before its outward go', async () => {
    const f = field(); f.blocks.set('2,64,0', 'soul_fire');
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 2, safe: true });
    expect(vi.mocked(dig).mock.calls[0][1]).toEqual({ at: [{ x: 2, y: 64, z: 0 }], collect: false });
    expect(vi.mocked(dig).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(go).mock.invocationCallOrder[0]);
  });

  it('extinguishes a new fire at home before the return go', async () => {
    const f = field();
    vi.mocked(place).mockImplementation(async (c, a) => { const out = await f.lay(c, a); f.blocks.set('-1,64,0', 'fire'); return out; });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 2, safe: true });
    expect(dig).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dig).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(place).mock.invocationCallOrder.at(-1)!);
    expect(vi.mocked(dig).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(go).mock.invocationCallOrder.at(-1)!);
  });

  it.each(['home', 'stand', 'return'])('stops after two unsuccessful digs at %s and reports why', async where => {
    const f = field(), fire = where === 'stand' ? '2,64,0' : '-1,64,0';
    if (where === 'return') vi.mocked(place).mockImplementation(async (c, a) => { const out = await f.lay(c, a); f.blocks.set(fire, 'fire'); return out; });
    else f.blocks.set(fire, 'fire');
    vi.mocked(dig).mockResolvedValue({ ok: false, text: '届かない', reason: 'out_of_reach' });
    const out = await fill(f.ctx, f.args);
    expect(out.fill).toMatchObject({ code: where === 'stand' ? null : 'NO_STAND', placed: where === 'return' ? 2 : 0, safe: where === 'stand' });
    if (where === 'stand') expect(out.fill.reasons).toEqual({ no_stand_fire_near: 2 });
    else { expect(out.text).toContain('fire_near'); expect(out.text).toContain('帰還先 0,64,0'); }
    expect(dig).toHaveBeenCalledTimes(2);
    expect(go).toHaveBeenCalledTimes(where === 'home' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rereads the fires after each dig and extinguishes a second fire', async () => {
    const f = field(); f.blocks.set('-1,64,0', 'fire');
    vi.mocked(dig).mockImplementation(async (_c, a) => {
      f.blocks.set(key(a.at[0]), 'air');
      if (vi.mocked(dig).mock.calls.length === 1) f.blocks.set('0,65,0', 'soul_fire');
      return { ok: true, text: '消した' };
    });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', safe: true });
    expect(vi.mocked(dig).mock.calls.map(([, a]) => a.at[0])).toEqual([{ x: -1, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }]);
  });

  it.each(['stand', 'home'])('rechecks and extinguishes a fire that appears during the go to %s', async where => {
    const f = field();
    vi.mocked(go).mockImplementation(async (c, a) => {
      const out = await f.walk(c, a);
      if (key(a.goals[0]) === key(where === 'home' ? f.args.retreatTo : f.args.groups[0].stand)) f.blocks.set(where === 'home' ? '-1,64,0' : '2,64,0', 'fire');
      return out;
    });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 2, safe: true });
    expect(dig).toHaveBeenCalledTimes(1);
  });

  it('shares the two-dig limit across all rechecks of the same footing', async () => {
    const f = field(); f.blocks.set('-1,64,0', 'fire');
    vi.mocked(place).mockImplementation(async (c, a) => { const out = await f.lay(c, a); f.blocks.set('-1,64,0', 'fire'); return out; });
    vi.mocked(go).mockImplementation(async (c, a) => {
      const out = await f.walk(c, a);
      if (key(a.goals[0]) === key(f.args.retreatTo)) f.blocks.set('-1,64,0', 'fire');
      return out;
    });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ code: 'NO_STAND', placed: 2, safe: false });
    expect(dig).toHaveBeenCalledTimes(2);
  });

  it.each(['no_floor', 'head_wall', 'lava', 'unloaded'])('does not dig when a fire coexists with %s', async why => {
    const f = field(); f.blocks.set('-1,64,0', 'fire');
    if (why === 'no_floor') f.blocks.set('0,63,0', 'air');
    if (why === 'head_wall') f.blocks.set('0,65,0', 'stone');
    if (why === 'lava') f.blocks.set('0,64,1', 'lava');
    if (why === 'unloaded') f.blocks.set('0,65,1', null);
    const out = await fill(f.ctx, f.args);
    expect(out.fill).toMatchObject({ status: 'failed', code: 'NO_STAND', placed: 0 });
    expect(out.text).toContain(why === 'head_wall' ? 'no_head_room' : why === 'lava' ? 'hazard_near' : why);
    expect(dig).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
  });

  it('defers a blocked group before go and counts its shared standability reason', async () => {
    const f = field(); f.blocks.set('1,65,0', 'stone');
    const out = await fill(f.ctx, f.args);
    expect(out.fill).toMatchObject({ status: 'partial', code: null, placed: 0, safe: true, reasons: { no_stand_no_head_room: 2 } });
    expect(vi.mocked(go).mock.calls.map(([, a]) => a.goals[0])).toEqual([f.args.retreatTo]);
    expect(place).not.toHaveBeenCalled(); expect(dig).not.toHaveBeenCalled();
  });

  it('defers the group if the dig throws while the fire is still present', async () => {
    const f = field(); f.blocks.set('2,64,0', 'fire');
    vi.mocked(dig).mockRejectedValue(new Error('dig failed'));
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ code: null, placed: 0, safe: true, reasons: { no_stand_fire_near: 2 } });
    expect(place).not.toHaveBeenCalled(); expect(dig).toHaveBeenCalledTimes(1);
  });

  it.each(['hp', 'reflex', 'death', 'cancel'])('preserves the %s stop during extinguishing', async why => {
    const f = field(); f.blocks.set('-1,64,0', 'fire');
    vi.mocked(dig).mockImplementation(async () => {
      if (why === 'hp') f.bot.health = 10;
      if (why === 'reflex') f.bot.lavaReflex = { engaged: true };
      if (why === 'death') f.bot.health = 0;
      if (why === 'cancel') f.stop.abort('external');
      return { ok: false, text: '中断' };
    });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ code: why === 'hp' ? 'HP_FLOOR' : why === 'reflex' ? 'REFLEX' : why === 'death' ? 'DEAD' : 'TIME_LIMIT', placed: 0, safe: false });
    expect(dig).toHaveBeenCalledTimes(1); expect(go).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an in-flight extinguishing dig at the reserved return deadline', async () => {
    const f = field(); f.args.seconds = 5; f.blocks.set('-1,64,0', 'fire');
    vi.mocked(dig).mockImplementation(part => new Promise((_resolve, reject) =>
      part.stop.addEventListener('abort', () => reject(new StepStopped(String(part.stop.reason))), { once: true })));
    const pending = fill(f.ctx, f.args);
    await vi.advanceTimersByTimeAsync(3500);
    expect((await pending).fill).toMatchObject({ code: 'TIME_LIMIT', placed: 0, safe: false });
    expect(dig).toHaveBeenCalledTimes(1); expect(go).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
    expect(f.bot.listenerCount('health')).toBe(0); expect(f.bot.listenerCount('physicsTick')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fill ordered work and retreat', () => {
  it('places 60 cells in one hand, returns, and leaves the resident shield alone', async () => {
    const f = field();
    f.args.seconds = 60;
    f.args.retreatTo = { x: 1, y: 64, z: -3 };
    f.args.groups = Array.from({ length: 10 }, (_, i) => ({ stand: { x: 1, y: 64, z: i * 3 },
      at: [0, 2].flatMap(x => [-1, 0, 1].map(dz => ({ x, y: 64, z: i * 3 + dz }))) }));
    const delegate = vi.spyOn(actions, 'delegateShield');
    const r = await fill(f.ctx, f.args);
    expect(r.ok).toBe(true); expect(r.fill).toMatchObject({ status: 'done', placed: 60, remaining: [], safe: true, code: null, hpMin: 20 });
    expect(place).toHaveBeenCalledTimes(60);
    for (const [, a] of vi.mocked(place).mock.calls) expect(a.at).toHaveLength(1);
    for (const [, a] of vi.mocked(go).mock.calls) expect(a).toMatchObject({ range: 0.8, maxDig: 0, maxPlace: 0, maxDrop: 0 });
    expect(vi.mocked(go).mock.calls.at(-1)![1].goals).toEqual([f.args.retreatTo]);
    expect(delegate).not.toHaveBeenCalled(); expect(f.bot.shieldBlock).toEqual({ enabled: true, up: true }); expect(f.bot.activateItem).not.toHaveBeenCalled();
    expect(f.bot.listenerCount('health')).toBe(0); expect(f.bot.listenerCount('physicsTick')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('continues progress passes through a three-stage support chain', async () => {
    const f = field();
    const bottom = { x: 2, y: 65, z: 0 }, middle = { x: 2, y: 66, z: 0 }, top = { x: 2, y: 67, z: 0 };
    f.args.groups[0].at = [bottom, middle, top]; f.blocks.set('2,68,0', 'stone');
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'done', placed: 3, remaining: [], safe: true, reasons: { no_support: 3 } });
    expect(vi.mocked(place).mock.calls.map(([, a]) => a.at[0])).toEqual([top, middle, bottom]);
    expect(vi.mocked(go).mock.calls.map(([, a]) => a.goals[0])).toEqual([f.args.groups[0].stand, f.args.groups[0].stand, f.args.groups[0].stand, f.args.retreatTo]);
  });
  it('defers an overlapping blaze box without calling place, then places after it leaves on a later pass', async () => {
    const f = field(), blocked = f.args.groups[0].at[0], clear = { x: 0, y: 64, z: 2 };
    f.args.groups[0].at = [blocked, clear];
    f.bot.entities[2] = { name: 'blaze', position: new Vec3(2.95, 63.8, 0.5), width: 0.6, height: 1.8 };
    vi.mocked(place).mockImplementation(async (c, a) => {
      expect(f.bot.entities[2]).toBeUndefined();
      return f.lay(c, a);
    });
    // The first cell is blocked, but the clear cell supplies this pass's progress.
    vi.mocked(place).mockImplementationOnce(async (c, a) => {
      expect(a.at).toEqual([clear]); delete f.bot.entities[2]; return f.lay(c, a);
    });
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'done', placed: 2, reasons: { creature_in_cell: 1 } });
    expect(vi.mocked(place).mock.calls.map(([, a]) => a.at[0])).toEqual([clear, blocked]);
    expect(go).toHaveBeenCalledTimes(3);
  });
  it('continues later groups when one stand has no floor', async () => {
    const f = field(), later = { x: 0, y: 64, z: 3 };
    f.blocks.set('1,63,0', 'air');
    f.args.groups.push({ stand: { x: 0, y: 64, z: 1 }, at: [later] });
    const r = await fill(f.ctx, f.args);
    expect(r.fill.code).toBeNull(); expect(r.fill.safe).toBe(true);
    expect(r.fill.reasons?.no_stand_no_floor).toBeGreaterThan(0);
    expect(vi.mocked(go).mock.calls.some(([, a]) => key(a.goals[0]) === '0,64,1')).toBe(true);
    expect(vi.mocked(place).mock.calls.some(([, a]) => key(a.at[0]) === key(later))).toBe(true);
    expect(vi.mocked(go).mock.calls.every(([, a]) => key(a.goals[0]) !== '1,64,0')).toBe(true);
  });
  it.each(['no_support', 'creature_in_cell', 'hazard', 'out_of_reach', 'out_of_sight', 'body_in_cell', 'occupied', 'unloaded'])('never calls place on a cell deferred for %s', async reason => {
    const f = field(); let target = { x: 2, y: 64, z: 0 };
    if (reason === 'no_support') target.y = 67;
    if (reason === 'creature_in_cell') f.bot.entities[2] = { name: 'blaze', position: new Vec3(2.95, 63.8, 0.5) };
    if (reason === 'hazard') f.blocks.set('3,64,0', 'lava');
    if (reason === 'out_of_reach') target.x = 8;
    if (reason === 'out_of_sight') {
      target.x = 4;
      for (const y of [64, 65, 66]) for (const z of [-1, 0, 1]) f.blocks.set(`3,${y},${z}`, 'stone');
    }
    if (reason === 'body_in_cell') target.x = 1;
    if (reason === 'occupied') f.blocks.set(key(target), 'stone');
    if (reason === 'unloaded') { target.x = 3; f.blocks.set(key(target), null); }
    f.args.groups[0].at = [target];
    const r = await fill(f.ctx, f.args);
    // reached, not safe: the blaze in the cell sees the body at the end point (safe is reached and unseen, 031070e).
    expect(r.fill).toMatchObject({ status: 'partial', placed: 0, remaining: [target], reached: true, reasons: { [reason]: 1 } });
    expect(place).not.toHaveBeenCalled(); expect(go).toHaveBeenCalledTimes(2);
  });
  it('ignores drops, experience and projectiles when checking creature boxes', async () => {
    const f = field();
    f.bot.entities = Object.fromEntries(['item', 'experience_orb', 'small_fireball'].map((name, id) => [id + 2,
      { name, position: new Vec3(2.5, 64, 0.5), ...(name === 'small_fireball' ? { type: 'projectile' } : {}) }]));
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 2 });
  });
  it.each([4.499999, 4.500001])('checks eye-to-centre reach at %sm from the actual fractional stop', async distance => {
    const f = field(), target = { x: 5, y: 65, z: 0 };
    f.args.groups[0].at = [target]; f.blocks.set('5,66,0', 'stone');
    vi.mocked(go).mockImplementation(async (c, a) => {
      const out = await f.walk(c, a);
      if (key(a.goals[0]) !== key(f.args.retreatTo)) f.bot.entity.position.x = 5.5 - Math.sqrt(distance ** 2 - 0.12 ** 2);
      return out;
    });
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: distance < 4.5 ? 'done' : 'partial', placed: distance < 4.5 ? 1 : 0, safe: true });
    expect(place).toHaveBeenCalledTimes(distance < 4.5 ? 1 : 0);
  });
  it('stops after six passes even if every pass still places one cell and no time elapses', async () => {
    const f = field();
    f.args.retreatTo = { x: 1, y: 64, z: -3 };
    f.args.groups[0].at = [0, 1, 2].flatMap(x => [-1, 0, 1].filter(z => x !== 1 || z !== 0).map(z => ({ x, y: 65, z })));
    for (const p of f.args.groups[0].at) f.blocks.set(key({ ...p, y: 66 }), 'stone');
    let laidThisVisit = false;
    vi.mocked(go).mockImplementation(async (c, a) => { laidThisVisit = false; return f.walk(c, a); });
    vi.mocked(place).mockImplementation(async (c, a) => {
      if (laidThisVisit) return { ok: false, reason: 'not_placed', text: '拒否' };
      laidThisVisit = true; return f.lay(c, a);
    });
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'partial', placed: 6, safe: true, elapsedMs: 0 });
    expect(r.fill.remaining).toHaveLength(2); expect(go).toHaveBeenCalledTimes(7);
  });
  it('skips fire-adjacent cells before place and retries after the rest', async () => {
    const f = field(); f.args.groups[0].at[1] = { x: -2, y: 64, z: 0 }; f.blocks.set('3,64,0', 'fire');
    vi.mocked(place).mockImplementation(async (c, a) => { f.blocks.delete('3,64,0'); return f.lay(c, a); });
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'done', placed: 2, skippedBy: { hazard: 1 } });
    expect(vi.mocked(place).mock.calls.map(([, a]) => a.at[0])).toEqual([...f.args.groups[0].at].reverse());
  });
  it('does not count cells already holding the block as newly placed', async () => {
    const f = field();
    vi.mocked(place).mockResolvedValue({ ok: true, text: '既設', goal: 'already', progress: { unit: 'block', done: 0, left: 0 } });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', placed: 0, remaining: [], safe: true });
  });
  it('places reachable pending cells from the actual stop after a failed go, across groups and nearest first', async () => {
    const f = field();
    const near = { x: 0, y: 64, z: 2 }, far = { x: 0, y: 64, z: 3 }, unreachable = { x: 20, y: 64, z: 0 };
    f.args.groups = [{ stand: { x: 3, y: 64, z: 0 }, at: [unreachable, far] }, { stand: { x: 3, y: 64, z: 1 }, at: [near] }];
    vi.mocked(go).mockImplementation(async (c, a) => {
      if (key(a.goals[0]) === key(f.args.retreatTo)) return f.walk(c, a);
      f.bot.entity.position = new Vec3(1.5, 64, 0.5);
      return { ok: false, reason: 'dead_end', text: '途中で止まった' };
    });
    vi.mocked(place).mockImplementation(async (c, a) => {
      expect(f.bot.entity.position).toEqual(new Vec3(1.5, 64, 0.5));
      return f.lay(c, a);
    });
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'partial', placed: 2, remaining: [unreachable], safe: true });
    expect(vi.mocked(place).mock.calls.map(([, a]) => a.at[0])).toEqual([near, far]);
    expect(vi.mocked(go).mock.calls.map(([, a]) => a.goals[0])).toEqual([f.args.groups[0].stand, f.args.groups[0].stand, f.args.retreatTo]);
  });
  it('interrupts the outward go at the HP floor and uses a fresh child signal for return', async () => {
    const f = field();
    vi.mocked(go).mockImplementationOnce(async part => {
      f.bot.entity.position = new Vec3(1.5, 64, 0.5);
      await new Promise<void>((_resolve, reject) => part.stop.addEventListener('abort', () => reject(new StepStopped(String(part.stop.reason))), { once: true }));
      return { ok: true, text: '着いた' };
    });
    const pending = fill(f.ctx, f.args);
    f.bot.health = 10; f.bot.emit('health');
    expect((await pending).fill).toMatchObject({ status: 'retreated', code: 'HP_FLOOR', placed: 0, safe: true });
    expect(place).not.toHaveBeenCalled(); expect(go).toHaveBeenCalledTimes(2); expect(vi.mocked(go).mock.calls[1][0].stop.aborted).toBe(false);
  });
  it('stops at the HP floor and samples HP through the entire return', async () => {
    const f = field();
    vi.mocked(place).mockImplementationOnce(async (c, a) => { const r = await f.lay(c, a); f.bot.health = 10; f.bot.emit('health'); return r; });
    vi.mocked(go).mockImplementation(async (c, a) => {
      if (key(a.goals[0]) === key(f.args.retreatTo)) { f.bot.health = 7; f.bot.emit('health'); f.bot.health = 12; f.bot.emit('health'); }
      return f.walk(c, a);
    });
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'retreated', code: 'HP_FLOOR', placed: 1, hpMin: 7, hpEnd: 12, safe: true });
    expect(place).toHaveBeenCalledTimes(1); expect(go).toHaveBeenCalledTimes(2);
  });
  it('reserves the destination stand return distance before leaving shelter', async () => {
    const f = field(); f.args.seconds = 5; f.args.groups[0].stand.x = 4;
    const r = await fill(f.ctx, f.args);
    expect(r.fill).toMatchObject({ status: 'retreated', code: 'TIME_LIMIT', placed: 0, safe: true });
    expect(place).not.toHaveBeenCalled(); expect(go).toHaveBeenCalledTimes(1);
    expect(vi.mocked(go).mock.calls[0][1].goals).toEqual([f.args.retreatTo]);
  });
  it('stops before the next cell when work starts eating the return budget', async () => {
    const f = field(); f.args.seconds = 10;
    vi.mocked(place).mockImplementationOnce(async (c, a) => { const r = await f.lay(c, a); vi.setSystemTime(Date.now() + 8000); return r; });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'retreated', code: 'TIME_LIMIT', placed: 1, safe: true, elapsedMs: 8000 });
    expect(place).toHaveBeenCalledTimes(1); expect(go).toHaveBeenCalledTimes(2);
  });
  it('latches the return reservation stop even when go resolves failure instead of throwing', async () => {
    const f = field(); f.args.groups[0].stand.x = 5;
    f.args.groups.push({ stand: { x: 2, y: 64, z: 0 }, at: [{ x: 4, y: 65, z: 0 }] });
    vi.mocked(go).mockImplementationOnce(part => new Promise(resolve => part.stop.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout', text: '期限で止まった' }), { once: true })));
    const pending = fill(f.ctx, f.args);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).fill).toMatchObject({ status: 'retreated', code: 'TIME_LIMIT', placed: 0, safe: true });
    expect(go).toHaveBeenCalledTimes(2); expect(place).not.toHaveBeenCalled();
  });
  it.each(['time', 'hp'])('interrupts an in-flight place at %s, unwinds it, then returns with the lease intact', async why => {
    const f = field(); f.args.seconds = 10;
    let unwound = false;
    vi.mocked(place).mockImplementation(async (part, a) => {
      try {
        await new Promise<void>((_resolve, reject) => part.stop.addEventListener('abort', () => {
          f.blocks.set(key(a.at[0]), a.block); reject(new StepStopped(String(part.stop.reason)));
        }, { once: true }));
      } finally { unwound = true; }
      return { ok: true, text: '置いた' };
    });
    vi.mocked(go).mockImplementation(async (c, a) => { if (key(a.goals[0]) === key(f.args.retreatTo)) expect(unwound).toBe(true); return f.walk(c, a); });
    const pending = fill(f.ctx, f.args);
    await vi.advanceTimersByTimeAsync(1);
    if (why === 'hp') { f.bot.health = 10; f.bot.emit('health'); }
    else await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(r.fill).toMatchObject({ status: 'retreated', code: why === 'hp' ? 'HP_FLOOR' : 'TIME_LIMIT', placed: 1, safe: true });
    expect(f.stop.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('cuts on a reflex without using its body to return or clearing its controls', async () => {
    const f = field();
    vi.mocked(place).mockImplementationOnce(async (c, a) => { const r = await f.lay(c, a); f.bot.lavaReflex = { engaged: true }; return r; });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'cut', code: 'REFLEX', placed: 1, safe: false });
    expect(go).toHaveBeenCalledTimes(1); expect(place).toHaveBeenCalledTimes(1); expect(f.bot.clearControlStates).not.toHaveBeenCalled();
  });
  it.each([20, 10])('accepts an exposed home at HP %s, recording the visible blaze and allowing the next fill', async health => {
    const f = field();
    vi.mocked(go).mockImplementation(async (c, a) => {
      const r = await f.walk(c, a);
      if (key(a.goals[0]) === key(f.args.retreatTo)) {
        f.bot.health = health;
        f.bot.entities[41] = { id: 41, name: 'blaze', position: new Vec3(4.5, 64, 0.5), width: 0.6, height: 1.8, type: 'hostile' };
      }
      return r;
    });
    const r = await fill(f.ctx, f.args);
    expect(r.ok).toBe(true); expect(r.fill).toMatchObject({ status: 'done', code: null, placed: 2, safe: false, reached: true, seen: 1 });
    // Arriving is not cover: safe keeps its meaning (no shooter sees the body), and the line says who sees it (review 2026-11-05).
    expect(r.text).toContain('安全未確認（射手1に見られている）');
    // The work HP floor remains inclusive; recover above it before starting another build.
    f.bot.health = 20;
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'done', code: null, safe: false, reached: true, seen: 1 });
  });
  it('keeps HP_FLOOR when a visible blaze remains at home below the HP threshold', async () => {
    const f = field();
    f.bot.entities[41] = { id: 41, name: 'blaze', position: new Vec3(4.5, 64, 0.5), width: 0.6, height: 1.8, type: 'hostile' };
    vi.mocked(place).mockImplementationOnce(async (c, a) => { const r = await f.lay(c, a); f.bot.health = 9; f.bot.emit('health'); return r; });
    const r = await fill(f.ctx, f.args);
    expect(r.ok).toBe(false);
    expect(r.fill).toMatchObject({ code: 'HP_FLOOR', placed: 1, safe: false, reached: false, seen: 1, at: { x: 0.5, y: 64, z: 0.5 } });
    expect(place).toHaveBeenCalledTimes(1);
  });
  it('still treats a covered home as safe below the HP threshold', async () => {
    const f = field(); f.blocks.set('2,65,0', 'stone');
    f.bot.entities[41] = { id: 41, name: 'blaze', position: new Vec3(4.5, 64, 0.5), width: 0.6, height: 1.8, type: 'hostile' };
    vi.mocked(place).mockImplementationOnce(async (c, a) => { const r = await f.lay(c, a); f.bot.health = 9; f.bot.emit('health'); return r; });
    expect((await fill(f.ctx, f.args)).fill).toMatchObject({ status: 'retreated', code: 'HP_FLOOR', placed: 1, safe: true, reached: true, seen: 0 });
    expect(place).toHaveBeenCalledTimes(1);
  });
  it.each(['blocked', 'wrong_cell', 'burning', 'lava', 'lost_floor'])('fails if the return is %s even at full HP with a visible blaze', async why => {
    const f = field();
    f.bot.entities[41] = { id: 41, name: 'blaze', position: new Vec3(4.5, 64, 0.5), width: 0.6, height: 1.8, type: 'hostile' };
    vi.mocked(go).mockImplementation(async (c, a) => {
      if (key(a.goals[0]) !== key(f.args.retreatTo)) return f.walk(c, a);
      if (why === 'blocked') return { ok: false, reason: 'dead_end', text: '通れない' };
      if (why === 'wrong_cell') return { ok: true, text: '着いたと言うが位置が違う' };
      const r = await f.walk(c, a);
      if (why === 'burning') f.bot.entity.metadata[0] = 1;
      if (why === 'lava') f.bot.entity.isInLava = true;
      if (why === 'lost_floor') f.blocks.set('0,63,0', 'air');
      return r;
    });
    const r = await fill(f.ctx, f.args);
    expect(r.ok).toBe(false); expect(r.fill).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', safe: false, at: { ...f.bot.entity.position } });
  });
  it('does not report done when a late return claims success past the overall deadline', async () => {
    const f = field();
    vi.mocked(go).mockImplementation(async (c, a) => {
      if (key(a.goals[0]) === key(f.args.retreatTo)) vi.setSystemTime(Date.now() + f.args.seconds * 1000 + 1);
      return f.walk(c, a);
    });
    const r = await fill(f.ctx, f.args);
    expect(r.ok).toBe(false); expect(r.fill).toMatchObject({ status: 'failed', code: 'RETREAT_BLOCKED', placed: 2, safe: false });
  });
  it('bounds remaining at 40 and keeps the full progress count', async () => {
    const f = field(); f.args.groups = Array.from({ length: 12 }, (_, z) => ({ stand: { x: 1, y: 64, z }, at: Array.from({ length: 8 }, (_, x) => ({ x: x + 2, y: 64, z })) }));
    vi.mocked(place).mockResolvedValue({ ok: false, reason: 'not_placed', text: '拒否' });
    const r = await fill(f.ctx, f.args);
    expect(r.fill.remaining).toHaveLength(40); expect(r.progress?.left).toBe(96);
    // With no placements in the first pass there is no automatic second pass. Only reachable, supported cells call place.
    expect(go).toHaveBeenCalledTimes(13);
    expect(place).toHaveBeenCalled();
    expect(r.fill.reasons?.not_placed).toBe(vi.mocked(place).mock.calls.length);
  });
});

describe('fill act receipt', () => {
  it('preserves the structured fill result on a done line', async () => {
    const f = field(), delegate = vi.spyOn(actions, 'delegateShield');
    const out = await actions.executeAction(f.bot, 'act', 60_000, () => runAct(actions.createMotorPort(f.bot), ACT_HANDS.parse([{ do: 'fill', ...f.args }])), { waitForQuiescence: true });
    const result = JSON.parse(out.result as string);
    expect(result.lines[0]).toMatchObject({ do: 'fill', status: 'done', fill: { status: 'done', placed: 2, safe: true } });
    expect(delegate).not.toHaveBeenCalled();
  });
  it('allows the HP-floor return to finish beyond the generic damage grace period', async () => {
    const f = field(), started = Date.now();
    vi.mocked(place).mockImplementationOnce(async (c, a) => { const r = await f.lay(c, a); f.bot.health = 10; f.bot.emit('health'); return r; });
    vi.mocked(go).mockImplementation(async (c, a) => {
      if (key(a.goals[0]) === key(f.args.retreatTo)) await new Promise(resolve => setTimeout(resolve, 700));
      return f.walk(c, a);
    });
    const pending = actions.executeAction(f.bot, 'act', 60_000, () => runAct(actions.createMotorPort(f.bot), ACT_HANDS.parse([{ do: 'fill', ...f.args }])), { waitForQuiescence: true });
    await vi.advanceTimersByTimeAsync(800); await pending;
    const report = takeActReport(f.bot, started)!;
    expect((report.lines[0] as any).fill).toMatchObject({ status: 'retreated', code: 'HP_FLOOR', placed: 1, safe: true });
    expect(report.lines[0].end).toBe('finished');
  });
  it('keeps explicit stopIf above the fill hand and preserves its cut result', async () => {
    const f = field(), started = Date.now();
    vi.mocked(place).mockImplementation(async part => {
      f.bot.health = 12;
      await new Promise<void>((_resolve, reject) => part.stop.addEventListener('abort', () => reject(new StepStopped(String(part.stop.reason))), { once: true }));
      return { ok: true, text: '置いた' };
    });
    const pending = actions.executeAction(f.bot, 'act', 60_000, () => runAct(actions.createMotorPort(f.bot), ACT_HANDS.parse([{ do: 'fill', ...f.args }]), { hpBelow: 14 }), { waitForQuiescence: true });
    await vi.advanceTimersByTimeAsync(150); await pending;
    const report = takeActReport(f.bot, started)!;
    expect(report.stoppedBy).toBe('stopIf'); expect((report.lines[0] as any).fill).toMatchObject({ status: 'cut', safe: false });
    expect(report.lines[0].end).toBe('cut');
  });
  it.each(['reflex', 'death', 'external_cut'])('preserves %s measurements and stops later hands even with onFail continue', async why => {
    const f = field(), started = Date.now();
    vi.mocked(place).mockImplementationOnce(async (c, a) => {
      const r = await f.lay(c, a);
      if (why === 'death') { f.bot.health = 0; f.bot.emit('health'); }
      else if (why === 'reflex') f.bot.lavaReflex = { engaged: true };
      else actions.currentAction(c.bot)!.controller.abort('floor-flee');
      return r;
    });
    const hands = ACT_HANDS.parse([{ do: 'fill', ...f.args, onFail: 'continue' }, { do: 'wait', seconds: 1 }]);
    await actions.executeAction(f.bot, 'act', 60_000, () => runAct(actions.createMotorPort(f.bot), hands), { waitForQuiescence: true });
    const report = takeActReport(f.bot, started)!;
    expect((report.lines[0] as any).fill).toMatchObject({ code: why === 'death' ? 'DEAD' : 'REFLEX', placed: 1, safe: false });
    expect(report.lines[0].end).toBe('cut'); expect(report.lines[1].status).toBe('skipped');
  });
});
