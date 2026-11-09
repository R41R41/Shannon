import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';

// h19 (11/8): the head's `attack #584` on a wither skeleton was cut in 0.4 s by "被弾: 体力 15 → 10" (damage_taken), the body then stood still
// 8 s and died. A targeted attack trades blows by design: its target's kind is accepted for the length of the hand, as fight's already was.
vi.mock('../../src/services/minebot/utils/primitives/attack.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/attack.js')>();
  return { ...actual, attack: vi.fn(async (ctx: any) => {
    ctx.bot.health = 10;
    await new Promise(resolve => setTimeout(resolve, 400));
    return { ok: true, text: '#7 を倒した（3回振って 3回当たった）' };
  }) };
});

function body() {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 },
    health: 20, food: 20, game: { dimension: 'the_nether' },
    entities: { 7: { id: 7, name: 'wither_skeleton', type: 'hostile', position: new Vec3(2.5, 64, 0.5), height: 2.4 } },
    inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3) => ({ name: Math.floor(p.y) < 64 ? 'netherrack' : 'air', boundingBox: Math.floor(p.y) < 64 ? 'block' : 'empty', diggable: true, hardness: 0.4, position: p.floored() }),
    setControlState: () => undefined, clearControlStates: () => undefined,
  });
  bot.entities[7].entity = bot.entities[7];
  return bot;
}
const hands = (value: unknown) => ACT_HANDS.parse(value);

describe('a targeted attack is not cut by its own target\'s blows', () => {
  it('the target hits for 10 during the attack: the hand runs to its end', async () => {
    const bot = body();
    const result = await runAct(bot, hands([{ do: 'attack', target: '#7', seconds: 5 }]), undefined, undefined, { tickMs: 20 });
    expect(result.failureType).not.toBe('damage_taken');
    expect(result.success).toBe(true);
  });

  it('the same loss on a wait (no fight chosen) still stops it', async () => {
    const bot = body();
    setTimeout(() => { bot.health = 10; }, 60);
    const result = await runAct(bot, hands([{ do: 'wait', seconds: 1 }]), undefined, undefined, { tickMs: 20 });
    expect(result.failureType).toBe('damage_taken');
  });

  it('stopIf hpBelow still stops the attack', async () => {
    const bot = body();
    const result = await runAct(bot, hands([{ do: 'attack', target: '#7', seconds: 5 }]), { hpBelow: 12 }, undefined, { tickMs: 20 });
    expect(result.success).toBe(false);
    expect(result.failureType).not.toBe('damage_taken');
  });
});
