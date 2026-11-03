import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';

// Lab r54 (the End, a walk across the island): a reflex cancelled the act while its `go` was still searching for a way (five seconds of search for a place two levels up, nobody wanted it any more);
// the act held the body still until the search ran out, and a dragon's fireball landed on it. A stop ends the search at its next turn.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const FLOOR = 64;
const ground: Ground = (x, y, z) => (Math.abs(x) > 30 || Math.abs(z) > 30 ? null : y < FLOOR ? 'stone' : 'air');

describe('a stop while the route search is still going', () => {
  it('ends the go within a tick or two, not at the search\'s own time limit', async () => {
    const sim: Sim = makeSim(ground, { start: [0.5, FLOOR, 0.5] });
    // A search that never finishes: it answers "partial" every turn (as the library does while it thinks).
    sim.bot.pathfinder.getPathFromTo = function* () { for (;;) yield { result: { status: 'partial', path: [] } }; } as never;
    const controller = new AbortController();
    const ctx = { bot: sim.bot, stop: controller.signal, deadline: Date.now() + 600_000, facing: 'east' as const, base: { x: 0, y: FLOOR, z: 0 } };
    let outcome: unknown = 'pending';
    const run = go(ctx as never, { goals: [{ x: 12, y: FLOOR, z: 0 }], range: 1, seconds: 60, searchMs: 5000 } as never).then(value => { outcome = value; }, error => { outcome = error; });
    for (let elapsed = 0; elapsed < 300; elapsed += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(outcome).toBe('pending');
    controller.abort('reflex');
    const abortedAt = Date.now();
    for (let waited = 0; waited < 500 && outcome === 'pending'; waited += 50) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    await run;
    expect(outcome).toBeInstanceOf(StepStopped);
    expect(Date.now() - abortedAt).toBeLessThanOrEqual(150);
  });
});
