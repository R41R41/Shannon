import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { sleepPatiently } from '../../src/services/minebot/utils/bedRules.js';
import { airborneGround, buriedSurface } from '../../src/services/minebot/utils/farLegs.js';

// end1108g S9 (11/8): three sleeps came back "bot is not sleeping" on a slow server, and the head waited out a 20-minute night in place.
function sleeper(after: (bot: any) => void) {
  const bot: any = Object.assign(new EventEmitter(), {
    isSleeping: false,
    sleep: async () => { after(bot); throw new Error('bot is not sleeping'); },
  });
  return bot;
}

describe('sleepPatiently: the server lays the body down later than mineflayer waits', () => {
  it('a sleep that comes late is taken as slept', async () => {
    const bot = sleeper(b => setTimeout(() => { b.isSleeping = true; b.emit('sleep'); }, 300));
    await expect(sleepPatiently(bot, {}, 2_000)).resolves.toBeUndefined();
    expect(bot.listenerCount('message')).toBe(0);
  });

  it('the server saying monsters are near is said as monsters (the callers map it to enemy_near)', async () => {
    const bot = sleeper(b => b.emit('message', { json: { translate: 'block.minecraft.bed.not_safe' }, toString: () => 'You may not rest now; there are monsters nearby' }));
    await expect(sleepPatiently(bot, {}, 2_000)).rejects.toThrow(/monsters nearby: 近くに敵/u);
  });

  it('no sleep and no reason: says the server did not lay it down within the time', async () => {
    const bot = sleeper(() => undefined);
    const t0 = Date.now();
    await expect(sleepPatiently(bot, {}, 400)).rejects.toThrow(/bot is not sleeping（サーバーが/u);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it('another error from mineflayer passes through as it was', async () => {
    const bot: any = Object.assign(new EventEmitter(), { isSleeping: false, sleep: async () => { throw new Error('the bed is too far'); } });
    await expect(sleepPatiently(bot, {}, 400)).rejects.toThrow('the bed is too far');
  });
});

// end1108g S9: every go of a 1.3 km walk aimed at y=62, inside the hills: the walk tunnelled (171 dug for 161 steps).
describe('buriedSurface: a far place inside the rock is walked to on the ground over it', () => {
  const hill = (x: number, z: number) => x >= 30 && x <= 50 && Math.abs(z) <= 10;
  const bot: any = {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    game: { dimension: 'overworld' },
    blockAt: (p: Vec3) => {
      const top = hill(p.x, p.z) ? 75 : 63;
      if (Math.abs(p.x) > 200) return null;
      return { name: p.y <= top ? 'stone' : 'air', boundingBox: p.y <= top ? 'block' : 'empty' };
    },
  };
  it('a place 40 m off inside a hill: the hill top', () => {
    expect(buriedSurface(bot, { x: 40, y: 62, z: 0 })).toBe(76);
  });
  it('near (within 24 m), open, or not loaded: null', () => {
    bot.entity.position = { x: 30.5, y: 64, z: 0.5 };
    expect(buriedSurface(bot, { x: 40, y: 62, z: 0 })).toBeNull();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    expect(buriedSurface(bot, { x: 80, y: 64, z: 0 })).toBeNull();
    expect(buriedSurface(bot, { x: 300, y: 62, z: 0 })).toBeNull();
  });
  it('a place 60 m off under a mountain 53 above it (end1109s02): the mountain top', () => {
    const mountain: any = { ...bot, entity: { position: { x: 0.5, y: 71, z: 0.5 } }, blockAt: (p: Vec3) => {
      const top = p.x >= 50 && p.x <= 90 ? 122 : 70;
      return { name: p.y <= top ? 'stone' : 'air', boundingBox: p.y <= top ? 'block' : 'empty' };
    } };
    expect(buriedSurface(mountain, { x: 60, y: 70, z: 0 })).toBe(123);
  });
  it('not in the overworld: null', () => {
    expect(buriedSurface({ ...bot, game: { dimension: 'the_nether' } }, { x: 40, y: 62, z: 0 })).toBeNull();
  });
});

describe('airborneGround: a far place in the air is walked to on the ground under it (end1109s02)', () => {
  // A mountain (top y 122) from x 0 to 20, a valley floor at y 88 beyond it.
  const top = (x: number) => (x <= 20 ? 122 : 88);
  const bot: any = {
    entity: { position: { x: 0.5, y: 123, z: 0.5 } },
    blockAt: (p: Vec3) => (Math.abs(p.x) > 250 ? null : { name: p.y <= top(p.x) ? 'stone' : 'air', boundingBox: p.y <= top(p.x) ? 'block' : 'empty' }),
  };
  it('196 m off at the mountain top height over the valley: the valley floor', () => {
    expect(airborneGround(bot, { x: 196, y: 120, z: 0 })).toBe(89);
  });
  it('near, standing on the ground, a step down, inside the rock, or not loaded: null', () => {
    expect(airborneGround(bot, { x: 20, y: 120, z: 0 })).toBeNull();
    expect(airborneGround(bot, { x: 196, y: 89, z: 0 })).toBeNull();
    expect(airborneGround(bot, { x: 196, y: 92, z: 0 })).toBeNull();
    expect(airborneGround(bot, { x: 10, y: 100, z: 60 })).toBeNull();
    expect(airborneGround(bot, { x: 300, y: 120, z: 0 })).toBeNull();
  });
  it('not in the overworld: null', () => {
    expect(airborneGround({ ...bot, game: { dimension: 'the_nether' } }, { x: 196, y: 120, z: 0 })).toBeNull();
  });
});
