import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';

// Run 9 (11/13): the hole's own dig was refused with threat_exposed (an enemy behind a wall, 9 cases), so nothing was thrown. The hole's cells lie below the feet and are covered after: they are dug with exposeOk.
const calls: Array<{ exposeOk?: unknown }> = [];
vi.mock('../../src/services/minebot/utils/primitives/dig.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/dig.js')>();
  return {
    ...actual,
    dig: async (ctx: any, args: any) => {
      calls.push({ exposeOk: args.exposeOk });
      if (!args.exposeOk) return { ok: false, reason: 'threat_exposed', text: 'threat' };
      return actual.dig(ctx, args);
    },
  };
});
const { openDropPit } = await import('../../src/services/minebot/utils/primitives/dropPit.js');

let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; calls.length = 0; });

describe('openDropPit', () => {
  it('digs the hole with exposeOk, so a dig that is refused without it goes through', async () => {
    ground = createGround({ pathfinder: true });
    ground.start();
    ground.give('stone_pickaxe', 1);
    const out = await openDropPit(stepContext(ground.bot));
    expect('plan' in out, JSON.stringify(out)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.exposeOk === true)).toBe(true);
  }, 30_000);
});
