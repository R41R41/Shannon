import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shoot } from '../../src/services/minebot/utils/primitives/shoot.js';
import { cancelActiveActions, createMotorPort, executeAction, setMotorOpSink } from '../../src/services/minebot/execution/ActionExecution.js';

afterEach(() => { vi.useRealTimers(); });
function fixture(weapon = 'bow') {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const stop = new AbortController(), calls: string[] = [], item = { name: weapon, type: 1, count: 1 }, arrow = { name: 'arrow', count: 4 };
  let wall = false, unknown = false, looks = 0;
  let terrain: ((p: Vec3) => boolean) | null = null;
  let onDraw = () => {}, onSlot = (_slot: number) => {};
  const target = { id: 9, name: 'end_crystal', width: 2, height: 2, position: new Vec3(24.5, 72, .5) };
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 }, entities: { 9: target },
    heldItem: item, inventory: { items: () => [item, arrow] }, game: { dimension: 'the_end' }, quickBarSlot: 0,
    blockAt: (p: Vec3) => { const solid = wall || terrain?.(p); return unknown ? null : { name: solid ? 'obsidian' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }; },
    look: vi.fn(async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; looks++; if (looks === 2) await finalLook(); }),
    activateItem: () => { calls.push('draw'); onDraw(); }, deactivateItem: () => { calls.push('release'); arrow.count--; },
    setQuickBarSlot: (slot: number) => { calls.push(`slot:${slot}`); bot.quickBarSlot = slot; onSlot(slot); },
  });
  let finalLook = async () => {};
  const ctx: any = { bot, stop: stop.signal, deadline: 10_000, facing: 'north', base: { x: 0, y: 64, z: 0 } };
  return { bot, ctx, calls, stop, onDraw: (work: () => void) => { onDraw = work; }, onSlot: (work: (slot: number) => void) => { onSlot = work; },
    terrain: (read: (p: Vec3) => boolean) => { terrain = read; }, finalLook: (work: () => Promise<void>) => { finalLook = work; }, wall: () => { wall = true; },
    unknown: () => { unknown = true; }, async run() { const result = shoot(ctx, { target: 9, charge: 1.05, weapon: weapon as 'bow' }); result.catch(() => {}); await vi.runAllTimersAsync(); return result; } };
}

describe('the actual crystal path immediately before releasing a drawn bow', () => {
  it('releases once on unchanged clear terrain', async () => {
    const f = fixture(); expect((await f.run()).ok).toBe(true); expect(f.calls).toEqual(['draw', 'release']);
  });
  // Review 2026-11-10 (KB1): an arrow at the dragon in flight is loosed as before, and the result says once what it is worth; a crystal's result does not carry the line.
  it('tells what an arrow at the flying dragon is worth, without refusing the shot', async () => {
    const f = fixture(); Object.assign(f.bot.entities[9], { name: 'ender_dragon', width: 16, height: 8, yaw: 0 });
    const out = await f.run(); expect(out.ok).toBe(true); expect(f.calls).toEqual(['draw', 'release']);
    expect(out.text).toContain('1発目'); expect(out.text.match(/飛んでいる竜は矢が当たりにくく/gu)).toHaveLength(1); expect(out.text).toContain('結晶が残るなら矢は結晶に使う');
    const crystal = fixture(); expect((await crystal.run()).text).not.toContain('飛んでいる竜');
  });
  it('cancels by slot change when a wall is observed only after the last awaited look', async () => {
    const f = fixture(); f.finalLook(async () => { f.wall(); });
    expect((await f.run()).text).toContain('矢の道'); expect(f.calls).toEqual(['draw', 'slot:1', 'slot:0']);
  });
  it('uses the real current actor position after the last look', async () => {
    const f = fixture(); f.finalLook(async () => { f.bot.entity.position = new Vec3(23.5, 72, .5); });
    expect((await f.run()).text).toContain('以上離れて'); expect(f.calls).not.toContain('release');
  });
  it('does not shoot a crystal lost during the last awaited look', async () => {
    const f = fixture(); f.finalLook(async () => { delete f.bot.entities[9]; });
    expect((await f.run()).text).toContain('見えなく'); expect(f.calls).toEqual(['draw', 'slot:1', 'slot:0']);
  });
  it('checks the angle already aimed from the new real position, not an unissued hypothetical re-aim', async () => {
    const f = fixture(); f.terrain(p => Math.floor(p.x) === 6 && Math.floor(p.z) === 4);
    f.finalLook(async () => { f.bot.entity.position.z = 4.5; });
    expect((await f.run()).text).toContain('矢の道'); expect(f.calls).not.toContain('release');
  });
  it('keeps the existing unread-cell policy rather than converting unknown to solid', async () => {
    const f = fixture(); f.finalLook(async () => { f.unknown(); }); await f.run(); expect(f.calls).toEqual(['draw', 'release']);
  });
  it('refuses a newly distant target rather than releasing into an obsolete range', async () => {
    const f = fixture(); f.finalLook(async () => { f.bot.entities[9].position = new Vec3(90, 72, .5); });
    expect((await f.run()).text).toContain('64m'); expect(f.calls).not.toContain('release');
  });
  it('retains stop cancellation from the last native await', async () => {
    const f = fixture(); f.finalLook(async () => { f.stop.abort('reflex'); });
    const result = f.run(); const rejected = expect(result).rejects.toThrow('step stopped'); await rejected;
    expect(f.calls).toEqual(['draw', 'slot:1']);   // a drawn bow stopped while the action still owns the body is let down, not loosed
  });
  it('checks a loaded crossbow before its firing activation', async () => {
    const f = fixture('crossbow'); f.finalLook(async () => { f.wall(); });
    await f.run(); expect(f.calls).toEqual(['draw', 'release', 'slot:1', 'slot:0']);
  });
  it('retains the real action motor owner while cancelling a newly blocked draw', async () => {
    const f = fixture(), ops: string[] = []; f.finalLook(async () => { f.wall(); }); setMotorOpSink(f.bot, row => ops.push(row.op));
    const work = executeAction(f.bot, 'act', 10_000, async () => {
      const out = await shoot({ ...f.ctx, bot: createMotorPort(f.bot) }, { target: 9 }); return { success: out.ok, result: out.text };
    });
    await vi.runAllTimersAsync(); expect((await work).result).toContain('矢の道');
    expect(ops.filter(op => op === 'setQuickBarSlot')).toHaveLength(2); expect(ops).not.toContain('deactivateItem');
  });
  it('does not dispatch a release after the action owner expires during the last native await', async () => {
    const f = fixture(), ops: string[] = []; f.finalLook(async () => { cancelActiveActions(f.bot, 'reflex'); }); setMotorOpSink(f.bot, row => ops.push(row.op));
    const work = executeAction(f.bot, 'act', 10_000, async () => {
      const out = await shoot({ ...f.ctx, bot: createMotorPort(f.bot) }, { target: 9 }); return { success: out.ok, result: out.text };
    });
    await vi.runAllTimersAsync(); expect((await work).success).toBe(false); expect(ops).not.toContain('deactivateItem');
    expect(ops).not.toContain('setQuickBarSlot');
  });
  it('cancels without releasing when the target disappears during the draw, preserving the lost-target result', async () => {
    const f = fixture(); f.onDraw(() => { delete f.bot.entities[9]; });
    expect((await f.run()).text).toContain('的が見えなくなった'); expect(f.calls).toEqual(['draw', 'slot:1', 'slot:0']);
  });
  it('cancels an unreachable post-draw aim without releasing, preserving its too-far result', async () => {
    const f = fixture(); f.onDraw(() => { f.bot.entities[9].position.x = 500; });
    expect((await f.run()).text).toContain('遠すぎて届かない'); expect(f.calls).toEqual(['draw', 'slot:1', 'slot:0']);
  });
  it('keeps the crossbow load/deactivate boundary when its target disappears during loading', async () => {
    const f = fixture('crossbow'); f.onDraw(() => { delete f.bot.entities[9]; });
    expect((await f.run()).text).toContain('的が見えなくなった'); expect(f.calls).toEqual(['draw', 'release', 'release']);
  });
  it('fences the delayed slot restoration if the owner expires during lost-target cancellation', async () => {
    const f = fixture(), ops: string[] = []; f.onDraw(() => { delete f.bot.entities[9]; });
    f.onSlot(slot => { if (slot === 1) cancelActiveActions(f.bot, 'reflex'); }); setMotorOpSink(f.bot, row => ops.push(row.op));
    const work = executeAction(f.bot, 'act', 10_000, async () => {
      const out = await shoot({ ...f.ctx, bot: createMotorPort(f.bot) }, { target: 9 }); return { success: out.ok, result: out.text };
    });
    await vi.runAllTimersAsync(); expect((await work).success).toBe(false);
    expect(ops.filter(op => op === 'setQuickBarSlot')).toHaveLength(1); expect(ops).not.toContain('deactivateItem');
  });
});

describe('a bow drawn among blazes (lab s1d1107: with the shield reflex on, 0 arrows left the bow; off, 17 and five blazes)', () => {
  it('brings a raised shield down before the draw, since the server starts no draw while the shield is in use, and frees the reflex after the release', async () => {
    const f = fixture();
    f.bot.shieldBlock = { enabled: true, guard: true, raised: 1, guards: 0, upTicks: 3, up: true, lowered: 0 };
    let heldAtDraw: number | undefined;
    f.onDraw(() => { heldAtDraw = f.bot.shieldBlock.drawUntil; });
    expect((await f.run()).ok).toBe(true);
    expect(f.calls).toEqual(['release', 'draw', 'release']);     // the shield's lowering, then the bow's draw and release
    expect(f.bot.shieldBlock.up).toBe(false);
    expect(heldAtDraw).toBeGreaterThan(0);
    expect(f.bot.shieldBlock.drawUntil).toBeUndefined();
  });
  it('waits out a volley still in flight behind the shield, then draws in the lull', async () => {
    const f = fixture();
    f.bot.shieldBlock = { enabled: true, guard: true, raised: 0, guards: 0, upTicks: 0, up: false, comingAt: 0 };
    let drawnAt = -1;
    f.onDraw(() => { drawnAt = Date.now(); });
    expect((await f.run()).ok).toBe(true);
    expect(drawnAt).toBeGreaterThanOrEqual(400);
    expect(f.calls).toEqual(['draw', 'release']);
  });
  it('draws at once with no shield reflex on the body', async () => {
    const f = fixture();
    let drawnAt = -1;
    f.onDraw(() => { drawnAt = Date.now(); });
    await f.run();
    expect(drawnAt).toBeLessThan(400);
  });
});

describe('a hand stopped mid-draw (end1108h15 S7: five stopped hands loosed 9 of 30 arrows with no hit told)', () => {
  const arrows = (f: ReturnType<typeof fixture>) => f.bot.inventory.items()[1].count as number;
  it('lets the bow down by the slot when the step is stopped during the draw', async () => {
    const f = fixture('bow'); f.onDraw(() => { setTimeout(() => f.stop.abort('stopIf'), 300); });
    const result = f.run(); await expect(result).rejects.toThrow('step stopped');
    expect(f.calls).toEqual(['draw', 'slot:1']); expect(arrows(f)).toBe(4);
  });
  it('turns the stops\' release into a let-down when the action is cancelled during the draw, and gives the release back after', async () => {
    const f = fixture('bow');
    f.onDraw(() => { setTimeout(() => cancelActiveActions(f.bot, 'hurt'), 300); });
    const work = executeAction(f.bot, 'act', 10_000, async () => {
      const out = await shoot({ ...f.ctx, bot: createMotorPort(f.bot) }, { target: 9 }); return { success: out.ok, result: out.text };
    });
    await vi.runAllTimersAsync(); expect((await work).success).toBe(false);
    expect(f.calls).toEqual(['draw', 'slot:1']); expect(arrows(f)).toBe(4);
    f.bot.deactivateItem(); expect(f.calls.at(-1)).toBe('release');
  });
  it('still looses the shot it meant to, once', async () => {
    const f = fixture('bow'); expect((await f.run()).ok).toBe(true); expect(f.calls).toEqual(['draw', 'release']); expect(arrows(f)).toBe(3);
    f.bot.deactivateItem(); expect(f.calls).toEqual(['draw', 'release', 'release']);
  });
});
