import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({ window: true, digOk: true, placeOk: true, dug: [] as any[], placed: [] as any[] }));
vi.mock('../../src/services/minebot/utils/primitives/dig.js', () => ({
  dig: vi.fn(async (_ctx: any, args: any) => {
    world.dug.push(args);
    if (!world.digOk) return { ok: false, reason: 'threat_exposure', text: '掘ると blaze に体がさらされる' };
    world.window = false;
    return { ok: true, text: '掘った' };
  }),
}));
vi.mock('../../src/services/minebot/utils/primitives/place.js', () => ({
  place: vi.fn(async (_ctx: any, args: any) => {
    world.placed.push(args);
    if (!world.placeOk) return { ok: false, reason: 'no_support', text: '置けなかった' };
    world.window = true;
    return { ok: true, text: '置いた' };
  }),
}));

import { shoot } from '../../src/services/minebot/utils/primitives/shoot.js';

// end1108b S7 (11/8): a blaze beyond the camp's window; the window cell (netherrack, beside the head) blocked six shoot hands, and the
// head never dug it. The hand opens it, shoots, and shuts it.
const windowCell = { x: 1, y: 65, z: 0 };
const isWindow = (p: Vec3) => p.x === windowCell.x && p.y === windowCell.y && p.z === windowCell.z;
function fakeBot() {
  const bow = { name: 'bow', type: 1, count: 1 }, arrow = { name: 'arrow', count: 8 }, rack = { name: 'netherrack', type: 2, count: 20 };
  const blaze = { id: 7, name: 'blaze', position: new Vec3(10.5, 65, 0.5), height: 1.8, width: 0.6 };
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) },
    entities: { 7: blaze }, heldItem: bow, inventory: { items: () => [bow, arrow, rack] }, game: { dimension: 'the_nether' },
    blockAt: (p: Vec3) => isWindow(p) && world.window ? { name: 'netherrack', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : null,
    look: vi.fn(async () => {}), activateItem: vi.fn(), deactivateItem: vi.fn(() => { arrow.count--; }), setQuickBarSlot: vi.fn(),
  }) as any;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'east', base: { x: 0, y: 64, z: 0 } }) as any;

beforeEach(() => { Object.assign(world, { window: true, digOk: true, placeOk: true, dug: [], placed: [] }); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('end1108b S7: shoot opens the window in the body\'s own wall, shoots, and shuts it', () => {
  it('digs the window cell letting in only the target\'s kind, shoots all the asked arrows, and shuts it with a carried block', async () => {
    const bot = fakeBot();
    const pending = shoot(ctx(bot), { target: 7, shots: 3 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(world.dug).toEqual([{ at: [windowCell], exposeOk: ['blaze'] }]);
    expect(bot.deactivateItem).toHaveBeenCalledTimes(3);
    expect(world.placed).toEqual([{ block: 'netherrack', at: [windowCell] }]);
    expect(world.window).toBe(true);
    expect(outcome.text).toContain('窓 (1,65,0) を開けて撃ち、netherrack で閉じた');
  });

  it('tells why when the window could not be dug, and draws nothing', async () => {
    world.digOk = false;
    const bot = fakeBot();
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, reason: 'line_blocked' });
    expect(outcome.text).toContain('窓を開けられなかった: 掘ると blaze に体がさらされる');
    expect(bot.activateItem).not.toHaveBeenCalled();
    expect(world.placed).toEqual([]);
  });

  it('says the window stayed open when it could not be shut', async () => {
    world.placeOk = false;
    const bot = fakeBot();
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('窓 (1,65,0) を開けて撃った。閉じられなかった: 置けなかった');
  });

  it('leaves a wall that is not beside the body alone', async () => {
    const bot = fakeBot();
    bot.entity.position = new Vec3(-2.5, 64, 0.5);
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, reason: 'line_blocked' });
    expect(outcome.text).toContain('位置を変えるか');
    expect(world.dug).toEqual([]);
  });
});
