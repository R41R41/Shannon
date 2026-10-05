import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { AIR_CONTROL, installKnockBrace, leanAgainst } from '../../src/services/minebot/utils/knockBrace.js';

function body() {
  const controls: Record<string, boolean> = { forward: true, sprint: true };
  const bot: any = Object.assign(new EventEmitter(), { health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    getControlState: (name: string) => !!controls[name], setControlState: (name: string, value: boolean) => { controls[name] = value; }, controls });
  return bot;
}
/** A blow as the body's own physics shows it a tick later: off the ground, rising, thrown west. */
function knock(bot: any) {
  bot.emit('physicsTick');                                   // standing
  bot.entity.onGround = false;
  bot.entity.velocity = new Vec3(-0.22, 0.27, 0);
  bot.entity.position = new Vec3(0.28, 64.27, 0.5);
  bot.emit('physicsTick');                                   // thrown
}

describe('a blow that is throwing the body off a ledge is leaned against (lab: a standing body walked to the rim of its platform and over it, a block a blow)', () => {
  it('changes the speed against the push by what the game allows a body in the air, and no more', () => {
    const velocity = new Vec3(-0.22, 0.27, 0);
    leanAgainst(velocity, { x: -1, z: 0 });
    expect(velocity.x).toBeCloseTo(-0.22 + AIR_CONTROL);
    expect(velocity.y).toBe(0.27);                           // the rise and the fall are not its to change
    expect(AIR_CONTROL).toBeLessThan(0.026);
  });

  it('leans, and lets its own keys go, while the flight ends in a dangerous fall; to the end of that flight', () => {
    const bot = body();
    let ahead = Infinity;
    installKnockBrace(bot, () => ahead);
    knock(bot);
    expect(bot.knockBrace).toMatchObject({ launches: 1, braced: 1, ticks: 1 });
    expect(bot.entity.velocity.x).toBeCloseTo(-0.22 + AIR_CONTROL);
    expect(bot.controls.forward).toBe(false);
    expect(bot.controls.sprint).toBe(false);
    // The landing has become safe: it goes on leaning until it is down (set down on the very rim, the next blow takes it over).
    ahead = 0.3;
    bot.emit('physicsTick');
    expect(bot.knockBrace.ticks).toBe(2);
    bot.entity.onGround = true;
    bot.emit('physicsTick');
    bot.emit('physicsTick');
    expect(bot.knockBrace.ticks).toBe(2);
  });

  it('leaves a push that lands on safe ground to run: it takes the body out of reach of what struck it', () => {
    const bot = body();
    installKnockBrace(bot, () => 0.4);
    knock(bot);
    expect(bot.knockBrace).toMatchObject({ launches: 1, braced: 0, ticks: 0 });
    expect(bot.entity.velocity.x).toBe(-0.22);
    expect(bot.controls.forward).toBe(true);
  });

  it('does not take the body\'s own jump for a blow, nor a fall for a throw', () => {
    const bot = body();
    installKnockBrace(bot, () => Infinity);
    bot.controls.jump = true;
    knock(bot);
    expect(bot.knockBrace.launches).toBe(0);
    const falling = body();
    installKnockBrace(falling, () => Infinity);
    falling.emit('physicsTick');
    falling.entity.onGround = false;
    falling.entity.velocity = new Vec3(0.1, -0.2, 0);          // walked off a step: going down, not thrown up
    falling.emit('physicsTick');
    expect(falling.knockBrace.launches).toBe(0);
  });
});
