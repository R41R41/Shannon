import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';

/**
 * Run 40 (2026-10-27): after the first `go` of a task the body's place was refused "Motor owner expired" 65 times of 68. go counted the digs and the blocks laid by
 * assigning `bot.dig` / `bot.placeBlock` on its act's motor port, which is a Proxy: the assignment went to the host body, what was read back was the port's wrapper of the
 * act's own owner, and the restore compared the host's function with a fresh wrapper and never ran. Every later place went through a port whose act was over.
 * This runs acts the way the body does (`executeAction` with a port of its own for each act) and asks for what the first act left behind.
 */
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const R = 40;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < 64 ? 'stone' : 'air');
async function drive<T>(sim: Sim, promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const act = (sim: Sim, hands: unknown) => drive(sim, executeAction(sim.bot, 'act', 120_000, async () => runAct(createMotorPort(sim.bot), ACT_HANDS.parse(hands)), { waitForQuiescence: true }));
const json = (result: { result: unknown }) => JSON.parse(String(result.result));

describe('a go leaves the body\'s dig and placeBlock as it found them', () => {
  it('a go that digs and lays blocks counts them, and the host\'s functions are the same objects after it', async () => {
    // A gap of air two wide across the way: a bridge is needed (cobblestone allowed), and a wall of stone beyond it to dig through.
    const ground: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : x >= 2 && x <= 3 && y >= 58 && y < 64 ? 'air' : y < 64 ? 'stone' : 'air');
    const sim = makeSim(ground, { items: [{ name: 'cobblestone', count: 16 }, { name: 'iron_pickaxe', count: 1 }] });
    const host = sim.bot as any;
    const [dig0, place0] = [host.dig, host.placeBlock];
    const result = await act(sim, [{ do: 'go', to: { x: 8, y: 64, z: 0 }, canPlace: ['cobblestone'], canDig: ['stone'], seconds: 60 }]);
    expect(json(result).ok).toBe(true);
    expect(json(result).lines[0].line).toMatch(/置 ?[1-9]/u);
    expect(host.dig).toBe(dig0);
    expect(host.placeBlock).toBe(place0);
  });

  it('the place of the next act works: it goes through its own port, not the first act\'s', async () => {
    const sim = makeSim(flat, { items: [{ name: 'cobblestone', count: 16 }, { name: 'crafting_table', count: 1 }] });
    const first = await act(sim, [{ do: 'go', to: { x: 5, y: 64, z: 0 } }]);
    expect(json(first).ok).toBe(true);
    const second = await act(sim, [{ do: 'place', block: 'crafting_table', at: [{ x: 5, y: 64, z: 1 }] }]);
    expect(json(second).lines[0].line).toContain('crafting_table を置いた');
    expect(json(second).ok).toBe(true);
    // and a third, after the second: the same
    const third = await act(sim, [{ do: 'place', block: 'cobblestone', at: [{ x: 4, y: 64, z: 1 }] }]);
    expect(json(third).ok).toBe(true);
  });

  it('a go that is cut (the act stops it) restores them as well', async () => {
    const sim = makeSim(flat, { items: [{ name: 'cobblestone', count: 16 }] });
    const host = sim.bot as any;
    const [dig0, place0] = [host.dig, host.placeBlock];
    const result = await act(sim, [{ do: 'go', to: { x: 38, y: 64, z: 0 }, seconds: 5 }]);
    expect(json(result).ok).toBe(false);
    expect(host.dig).toBe(dig0);
    expect(host.placeBlock).toBe(place0);
  });
});
