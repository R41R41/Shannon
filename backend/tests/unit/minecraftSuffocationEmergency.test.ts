import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { BotEventHandler } from '../../src/services/minebot/events/BotEventHandler.js';

function fixture(): { bot: any; handler: any; reaction: any } {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), isInWater: true, isCollidedVertically: false },
    oxygenLevel: 20, health: 20,
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    constantSkills: { getSkill: () => undefined },
  });
  const reaction: any = { handleSuffocation: vi.fn(async () => {}) };
  const handler: any = new BotEventHandler(bot, {} as any, []);
  handler.setEventReactionSystem(reaction);
  return { bot, handler, reaction };
}

describe('native suffocation event detection', () => {
  it('preempts on Mineflayer breath before health loss and preserves oxygen zero', async () => {
    const { bot, handler, reaction } = fixture();
    handler.registerBreath();
    bot.oxygenLevel = 9;
    bot.emit('breath');
    await vi.waitFor(() => expect(reaction.handleSuffocation).toHaveBeenCalledOnce());
    expect(reaction.handleSuffocation.mock.calls[0][0]).toEqual({ oxygen: 9, health: 20, isInWater: true });
    await vi.waitFor(() => expect(handler.suffocationCheckPending).toBe(false));

    bot.oxygenLevel = 0;
    bot.emit('breath');
    await vi.waitFor(() => expect(reaction.handleSuffocation).toHaveBeenCalledTimes(2));
    expect(reaction.handleSuffocation.mock.calls[1][0].oxygen).toBe(0);

    bot.entity.isInWater = false;
    bot.oxygenLevel = 4;
    bot.emit('breath');
    await Promise.resolve();
    expect(reaction.handleSuffocation).toHaveBeenCalledTimes(2);
  });

  it('uses a solid head block plus damage for buried suffocation, not ordinary ground collision', async () => {
    const { bot, handler, reaction } = fixture();
    bot.entity.isInWater = false;
    bot.entity.isCollidedVertically = true;
    await handler.checkSuffocation(19, 20);
    expect(reaction.handleSuffocation).not.toHaveBeenCalled();
    bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' });
    await handler.checkSuffocation(18, 19);
    expect(reaction.handleSuffocation).toHaveBeenCalledOnce();
  });
});

describe('a spawn after a pass through a portal is no death (paid run L88: the task was failed as a death the moment the Nether was reached)', () => {
  it('fails the running task on a spawn only when the body has died since the last one', async () => {
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) }, health: 20, nearestEntity: () => null });
    const runtime: any = { isRunning: () => true, failCurrentTaskDueToDeath: vi.fn() };
    const handler: any = new BotEventHandler(bot, runtime, []);
    handler.registerDeath();
    handler.registerRespawn();
    bot.emit('spawn');                                   // through a portal
    await Promise.resolve();
    expect(runtime.failCurrentTaskDueToDeath).not.toHaveBeenCalled();
    bot.emit('death');
    await Promise.resolve();
    bot.emit('spawn');                                   // back after a death
    await Promise.resolve();
    expect(runtime.failCurrentTaskDueToDeath).toHaveBeenCalledTimes(2);   // at the death, and the fallback at the spawn
    bot.emit('spawn');                                   // the next portal: no death since
    await Promise.resolve();
    expect(runtime.failCurrentTaskDueToDeath).toHaveBeenCalledTimes(2);
  });
});

