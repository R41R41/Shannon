import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepIntoEndPortal } from '../../src/services/minebot/utils/primitives/walk.js';

// The last step into an End portal (S2 lab, 2026-11-02): the portal is a sheet over lava, so the route search cannot path onto it ("no_floor" for go, "4秒進めず" for walk, with 12 eyes
// in the frames); the walk goes to within 2.5 blocks of it and the last step is made by hand: face its middle and walk forward until the dimension changes.

function body(options: { changeAfterMs?: number } = {}) {
  const keys: Record<string, boolean[]> = { forward: [], sprint: [] };
  const looks: Vec3[] = [];
  const edgeSeen: boolean[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    game: { dimension: 'minecraft:overworld' }, edgeGuard: { enabled: true },
    entity: { position: new Vec3(1738.5, 33, 594.5) },
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    setControlState: (name: string, value: boolean) => { (keys[name] ??= []).push(value); edgeSeen.push(bot.edgeGuard.enabled); },
    lookAt: async (point: Vec3) => { looks.push(point); },
  });
  if (options.changeAfterMs !== undefined) setTimeout(() => { bot.game.dimension = 'minecraft:the_end'; }, options.changeAfterMs);
  return { bot, keys, looks, edgeSeen };
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: { x: 1738, y: 33, z: 594 } });

describe('stepIntoEndPortal', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('faces the middle of the portal cell and walks forward until the dimension changes, then lets go of the key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { bot, keys, looks, edgeSeen } = body({ changeAfterMs: 700 });
    const running = stepIntoEndPortal(ctx(bot), { x: 1740, y: 32, z: 594 });
    await vi.advanceTimersByTimeAsync(1500);
    await running;
    expect(looks.length).toBeGreaterThan(0);
    expect(looks[0].x).toBeCloseTo(1740.5, 5);
    expect(looks[0].z).toBeCloseTo(594.5, 5);
    expect(keys.forward[0]).toBe(true);
    expect(keys.forward[keys.forward.length - 1]).toBe(false);
    expect(keys.sprint.every(value => value === false)).toBe(true);
    expect(bot.pathfinder.stop).toHaveBeenCalled();
    // the edge guard is let off while the body steps off the ring, and put back
    expect(edgeSeen.slice(0, -1).every(value => value === false)).toBe(true);
    expect(bot.edgeGuard.enabled).toBe(true);
  });

  it('gives up after a few seconds when nothing changes (the walk then says the dimension did not change), and the key is let go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { bot, keys } = body();
    const running = stepIntoEndPortal(ctx(bot), { x: 1740, y: 32, z: 594 });
    await vi.advanceTimersByTimeAsync(5000);
    await running;
    expect(keys.forward[keys.forward.length - 1]).toBe(false);
    expect(bot.game.dimension).toBe('minecraft:overworld');
  });
});
