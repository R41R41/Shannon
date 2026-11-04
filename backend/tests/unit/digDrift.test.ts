import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim } from '../helpers/handsSim.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';
import { ServerDigUnconfirmedError } from '../../src/services/minebot/utils/digBlockVerified.js';
import { Vec3 } from 'vec3';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { recentStopLines } from '../../src/services/minebot/utils/localMap.js';

// Run 46 (hold 6): the water poured over the lava carried the body 7 m away while it dug obsidian; the dig waited for its guard (49 s) and the hand stood still.
// A body that has left the reach of the block it digs stops the dig at once (out_of_reach), so that the hand can stand again.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const ground: Ground = (x, y, z) => (Math.abs(x) > 40 || Math.abs(z) > 40 ? null : x === 3 && y === FLOOR && z === 0 ? 'obsidian' : y < FLOOR ? 'stone' : 'air');
const ctxOf = (sim: HandsSim): StepContext => ({ bot: sim.bot, stop: new AbortController().signal, deadline: Date.now() + 600_000, facing: 'east', base: { x: 0, y: FLOOR, z: 0 } });
async function drive<T>(sim: HandsSim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 120_000): Promise<{ value: T; elapsed: number }> {
  let settled = false, elapsed = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return { value: await promise, elapsed };
}

describe('dig: a body carried out of reach while it digs', () => {
  it('cancels an ongoing dry dig when flooding consumes its return reserve', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    sim.bot.dig = () => new Promise(() => undefined);
    const stop = vi.fn(); sim.bot.stopDigging = stop;
    const { value, elapsed } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], collect: false }), time => {
      if (time === 1000) {
        sim.world.set(0, FLOOR + 1, 0, 'water');
        sim.bot.oxygenLevel = 4;
      }
    });
    expect(value).toMatchObject({ ok: false, reason: 'breathing_work' });
    expect(value.text).toContain('掘削中止:');
    expect(value.text).toContain('残り掘削');
    expect(value.text).toContain('不足');
    expect(elapsed).toBeLessThan(2000);
    expect(stop).toHaveBeenCalled();
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('obsidian');
  });
  it('stops at once with out_of_reach (not after the dig\'s long guard), and the block is still there', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    // a server does not break a block from out of reach: the dig never comes back
    sim.bot.dig = () => new Promise(() => undefined);
    const { value, elapsed } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], tool: 'diamond_pickaxe', collect: false }), time => {
      if (time === 1000) sim.bot.entity.position.x = 12.5;   // carried away by the water
    });
    expect(value.ok).toBe(false);
    expect(value.reason).toBe('out_of_reach');
    expect(value.text).toContain('流されて届かなくなった');
    expect(elapsed).toBeGreaterThan(12_000);
    expect(elapsed).toBeLessThan(14_000);   // the block's own time (9.4 s) and three seconds over, not the guard of 31 s (the lab's was 49)
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('obsidian');
  });
  // The prompt stop (a33c5d0: reach checked before the block's time) is out of the 4th release: the obsidian hand's own pour carried the
  // simulated body 6 m off and every stand ended at once (0 obsidian). It returns with the obsidian hand re-standing within reach (S4, 11/6).

  it('lets a dig finish while a small displacement stays within reach', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    const { value } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], collect: false }), time => {
      if (time === 1000) sim.bot.entity.position.x = 1.5;
    });
    expect(value.ok).toBe(true);
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('air');
  });

  it('a body that stays where it is digs as before', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    const { value } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], tool: 'diamond_pickaxe', collect: false }));
    expect(value.ok).toBe(true);
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('air');
  });

  it('keeps an unconfirmed server result uncertain while telling that its reach precondition was lost', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    sim.bot.dig = async () => {
      sim.bot.entity.position.x = 12.5;
      throw new ServerDigUnconfirmedError(new Vec3(3, FLOOR, 0), []);
    };
    const { value } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], collect: false }));
    expect(value).toMatchObject({ ok: false, reason: 'dig_unconfirmed' });
    expect(value.text).toContain('採掘中に射程外へ移動した');
    expect(value.text).toContain('足場と視線を確かめる');
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('obsidian');
  });
});

describe('dig: the breathing refusal reaches the head', () => {
  it('keeps the budget and smaller-job advice in the act line and a breathing headline in recentStops', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    sim.world.set(0, FLOOR, 0, 'water');
    sim.world.set(0, FLOOR + 1, 0, 'water');
    sim.bot.oxygenLevel = 20;
    sim.bot.digTime = () => 20_000;
    const native = vi.spyOn(sim.bot, 'dig');
    const { value } = await drive(sim, runAct(sim.bot, ACT_HANDS.parse([{ do: 'dig', at: [
      { x: 0, y: FLOOR, z: 0 }, { x: 1, y: FLOOR, z: 0 }, { x: 2, y: FLOOR, z: 0 }, { x: 3, y: FLOOR, z: 0 },
    ], collect: false }])));
    expect(value.success).toBe(false);
    const line = JSON.parse(value.result).lines[0].line as string;
    expect(line).toMatch(/^呼吸不足:/u);
    expect(line).toContain('必要');
    expect(line).toContain('掘削20秒×1マス＋帰還');
    expect(line).toContain('余裕3秒');
    expect(line).toContain('残り息15秒');
    expect(line).toContain('不足');
    expect(line).toContain('1〜2マス単位で再判定');
    expect(line).toContain('1マスでも不足なら水外から掘る');
    expect(line.length).toBeLessThanOrEqual(160);
    expect(recentStopLines(sim.bot).join('\n')).toContain('呼吸不足');
    expect(native).not.toHaveBeenCalled();
  });
});

describe('dig: the breath watcher', () => {
  it('does not let a failing re-read of the dig time escape the dig', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    const digTime = sim.bot.digTime.bind(sim.bot);
    let calls = 0;
    // the first reads are the dig's own (its start, its expected time, the sim's wait); the watcher's reads come after them
    sim.bot.digTime = (block: any) => { if (++calls > 5) throw new Error('digTime failed'); return digTime(block); };
    const { value } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], tool: 'diamond_pickaxe', collect: false }));
    expect(calls).toBeGreaterThan(5);
    expect(value.ok).toBe(true);
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('air');
  });
});

describe('dig: the breath watcher keeps its eyes when the dig time cannot be read', () => {
  it('still stops a dig whose body is flooded and short of breath when digTime throws', async () => {
    const sim = makeHandsSim(ground, { items: [{ name: 'diamond_pickaxe', count: 1 }] });
    sim.bot.dig = () => new Promise(() => undefined);
    const stop = vi.fn(); sim.bot.stopDigging = stop;
    const digTime = sim.bot.digTime.bind(sim.bot);
    let calls = 0;
    sim.bot.digTime = (block: any) => { if (++calls > 4) throw new Error('digTime failed'); return digTime(block); };
    const { value, elapsed } = await drive(sim, dig(ctxOf(sim), { at: [{ x: 3, y: FLOOR, z: 0 }], collect: false }), time => {
      if (time === 1000) { sim.world.set(0, FLOOR + 1, 0, 'water'); sim.bot.oxygenLevel = 4; }
    });
    expect(calls).toBeGreaterThan(4);
    expect(value).toMatchObject({ ok: false, reason: 'breathing_work' });
    expect(elapsed).toBeLessThan(2500);
    expect(stop).toHaveBeenCalled();
    expect(sim.world.nameAt(3, FLOOR, 0)).toBe('obsidian');
  });
});
