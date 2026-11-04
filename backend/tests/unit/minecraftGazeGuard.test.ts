import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { avertedPitch, avertedPitchInRange, gazeEyes, gazeGuardTick, installGazeGuard, viewVector } from '../../src/services/minebot/utils/gazeGuard.js';

const TOLERANCE = 0.025;
/** The server's test: does a look from `eyes` fall on the creature's eyes? */
function staring(eyes: Vec3, yaw: number, pitch: number, target: Vec3): boolean {
  const line = target.minus(eyes), distance = line.norm();
  return viewVector(yaw, pitch).dot(line.scaled(1 / distance)) > 1 - TOLERANCE / distance;
}
const yawTo = (from: Vec3, to: Vec3) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

describe('the look is kept off the eyes of a creature that attacks what looks at it (paid run L64 was killed by an enderman it had walked towards)', () => {
  const eyes = new Vec3(0.5, 71.62, 0.5);

  it('a level look along the way the body walks falls on the eyes of one twenty metres ahead; the guard lowers it', () => {
    const creature = new Vec3(22.5, 72.55, 0.5);
    const yaw = yawTo(eyes, creature);
    expect(staring(eyes, yaw, 0, creature)).toBe(true);
    const pitch = avertedPitch(eyes, yaw, 0, [{ eyes: creature, tolerance: TOLERANCE }]);
    expect(pitch).toBeLessThan(0);
    expect(pitch).toBeGreaterThan(-0.2); // a few degrees, not at the ground
    expect(staring(eyes, yaw, pitch, creature)).toBe(false);
    // The same from close by, where the eyes are well above the body's: a level look is already under them.
    const near = new Vec3(3.5, 72.55, 0.5);
    expect(avertedPitch(eyes, yawTo(eyes, near), 0, [{ eyes: near, tolerance: TOLERANCE }])).toBe(0);
  });

  it('leaves a look that is on no such eyes alone', () => {
    const creature = new Vec3(22.5, 72.55, 0.5);
    const yaw = yawTo(eyes, creature);
    expect(avertedPitch(eyes, yaw + 0.4, 0, [{ eyes: creature, tolerance: TOLERANCE }])).toBe(0);
    expect(avertedPitch(eyes, yaw, -0.5, [{ eyes: creature, tolerance: TOLERANCE }])).toBe(-0.5);
    expect(avertedPitch(eyes, yaw, 0, [{ eyes: new Vec3(100.5, 72.55, 0.5), tolerance: TOLERANCE }])).toBe(0); // out of its range
  });

  it('clears two at once, and looks above eyes that are straight below', () => {
    const one = new Vec3(22.5, 72.55, 0.5), lower = new Vec3(30.5, 69.5, 0.5);
    const yaw = yawTo(eyes, one);
    const pitch = avertedPitch(eyes, yaw, 0, [{ eyes: one, tolerance: TOLERANCE }, { eyes: lower, tolerance: TOLERANCE }]);
    expect(staring(eyes, yaw, pitch, one)).toBe(false);
    expect(staring(eyes, yaw, pitch, lower)).toBe(false);
    const below = new Vec3(0.5, 60, 0.5);
    const up = avertedPitch(eyes, 0, -Math.PI / 2, [{ eyes: below, tolerance: TOLERANCE }]);
    expect(up).toBeGreaterThan(-Math.PI / 2);
    expect(staring(eyes, 0, up, below)).toBe(false);
  });

  it('as a reflex: changes only the pitch, only for such creatures, and can be switched off', () => {
    const at = new Vec3(0.5, 70, 0.5);
    const make = (name: string) => ({ entity: { position: at, yaw: yawTo(at, new Vec3(22.5, 70, 0.5)), pitch: 0 },
      entities: { 7: { name, position: new Vec3(22.5, 70, 0.5) } }, on: () => undefined }) as any;
    const bot = make('enderman');
    const yaw = bot.entity.yaw;
    const state = { enabled: true, averted: 0 };
    expect(gazeGuardTick(bot, state)).toBe(true);
    expect(bot.entity.yaw).toBe(yaw);
    expect(bot.entity.pitch).toBeLessThan(0);
    expect(staring(at.offset(0, 1.62, 0), yaw, bot.entity.pitch, new Vec3(22.5, 72.55, 0.5))).toBe(false);
    expect(gazeGuardTick(bot, state)).toBe(false); // already clear
    const zombie = make('zombie');
    expect(gazeGuardTick(zombie, state)).toBe(false);
    expect(zombie.entity.pitch).toBe(0);
    const off = make('enderman');
    expect(gazeGuardTick(off, { enabled: false, averted: 0 })).toBe(false);
    expect(off.entity.pitch).toBe(0);
  });
});

function movingBody() {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 }, entities: {},
    _client: { write: vi.fn(() => 'written') },
    look: vi.fn(async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; }),
    lookAt: vi.fn(async () => undefined),
  });
  bot.sent = bot._client.write;
  installGazeGuard(bot);
  return bot;
}
const enderman = (id: number, eyes: Vec3) => ({ id, name: 'enderman', position: eyes.offset(0, -2.55, 0) });

describe('requested looks and the last outgoing rotation', () => {
  it('corrects a close (2 m) look after physicsTick, keeping yaw and using the nearer side of the cone', async () => {
    const bot = movingBody(), eyes = gazeEyes(bot);
    const mobEyes = eyes.offset(0, 0, -2);
    bot.entities[2] = enderman(2, mobEyes);
    bot.emit('physicsTick');
    await bot.look(0, 0.1, true);
    expect(bot.entity.yaw).toBe(0);
    expect(bot.entity.pitch).toBeGreaterThan(0.1); // below would be a larger change
    expect(staring(eyes, 0, bot.entity.pitch, mobEyes)).toBe(false);
    expect(bot.gazeGuard.bySource.look).toBe(1);
    expect(bot.gazeGuard.lastAverted).toMatchObject({ source: 'look', requested: { pitch: 0.1 }, creatures: [{ id: 2, distance: 2 }] });
  });

  it('looks at points from crouched eyes in both open sky and a low ceiling', async () => {
    for (const crouch of ['reported', 'sneak', 'ceiling']) {
      const bot = movingBody();
      if (crouch === 'reported') bot.entity.eyeHeight = 1.27;
      if (crouch === 'sneak') bot.getControlState = () => true;
      if (crouch === 'ceiling') {
        bot.entity.position.y = 64.47;
        bot.blockAt = (p: Vec3) => ({ boundingBox: p.y >= 66 ? 'block' : 'empty' });
      }
      expect(gazeEyes(bot).y - bot.entity.position.y).toBeCloseTo(1.27);
      const mobEyes = gazeEyes(bot).offset(0, 0, -3);
      bot.entities[2] = enderman(2, mobEyes);
      await bot.lookAt(mobEyes, true);
      expect(staring(gazeEyes(bot), bot.entity.yaw, bot.entity.pitch, mobEyes)).toBe(false);
      expect(bot.gazeGuard.bySource.lookAt).toBe(1);
    }
  });

  it('protects the held gaze immediately after a known teleport into it', () => {
    const bot = movingBody(), mobEyes = gazeEyes(bot).offset(0, 0, -3);
    bot.entities[2] = enderman(2, mobEyes.offset(10, 0, 0));
    bot.emit('physicsTick');
    expect(bot.gazeGuard.averted).toBe(0);
    bot.entities[2].position = mobEyes.offset(0, -2.55, 0);
    bot.emit('physicsTick');
    expect(staring(gazeEyes(bot), 0, bot.entity.pitch, mobEyes)).toBe(false);
    expect(bot.gazeGuard.bySource.tick).toBe(1);
  });

  it('does not lose a creature at the 64 m feet boundary because its eyes are slightly farther away', async () => {
    const bot = movingBody();
    bot.entities[2] = { id: 2, name: 'enderman', position: bot.entity.position.offset(0, 0, -64) };
    const mobEyes = bot.entities[2].position.offset(0, 2.55, 0);
    expect(mobEyes.distanceTo(gazeEyes(bot))).toBeGreaterThan(64);
    await bot.lookAt(mobEyes, true);
    expect(staring(gazeEyes(bot), bot.entity.yaw, bot.entity.pitch, mobEyes)).toBe(false);
    expect(bot.gazeGuard.averted).toBe(1);
  });

  it.each(['look', 'position_look'])('checks a raw %s after later listeners overwrite the rotation, without changing position or flags', name => {
    const bot = movingBody();
    const position = name === 'position_look' ? new Vec3(20, 65, 10) : bot.entity.position;
    const mobEyes = gazeEyes(bot, position).offset(0, 0, -3);
    bot.entities[2] = enderman(2, mobEyes);
    const write = bot._client.write;
    installGazeGuard(bot);
    expect(bot._client.write).toBe(write);
    const packet = { yaw: 180, pitch: 0, x: position.x, y: position.y, z: position.z, onGround: true, flags: { onGround: true } };
    expect(bot._client.write(name, packet)).toBe('written');
    const sent = bot.sent.mock.calls[0][1];
    expect(staring(gazeEyes(bot, position), Math.PI - sent.yaw * Math.PI / 180, -sent.pitch * Math.PI / 180, mobEyes)).toBe(false);
    expect(sent).toMatchObject({ x: packet.x, y: packet.y, z: packet.z, yaw: 180, onGround: true, flags: { onGround: true } });
    expect(bot.gazeGuard.bySource.packet).toBe(1);
    expect(bot.gazeGuard.lastAverted.eyes).toEqual(gazeEyes(bot, position));
    expect(packet.pitch).toBe(0); // no mutation of mineflayer's reusable lastSent object
  });

  it('passes safe dragon/crystal aims exactly, and only changes an overlapping crystal line by the nearest pitch', async () => {
    const bot = movingBody(), eyes = gazeEyes(bot);
    const yaw = 0.7, pitch = 0.6;
    bot.entities[3] = { name: 'end_crystal', position: eyes.plus(viewVector(yaw, pitch).scaled(30)) };
    await bot.look(yaw, pitch, true);
    expect(bot.entity).toMatchObject({ yaw, pitch });
    expect(bot.gazeGuard.averted).toBe(0);
    const mobEyes = eyes.plus(viewVector(yaw, pitch).scaled(3));
    bot.entities[2] = enderman(2, mobEyes);
    await bot.look(yaw, pitch, true);
    expect(bot.entity.yaw).toBe(yaw);
    expect(Math.abs(bot.entity.pitch - pitch)).toBeLessThan(0.21);
    expect(staring(eyes, yaw, bot.entity.pitch, mobEyes)).toBe(false);
  });

  it('honours the existing temporary disable and does not add listeners on a second installation', async () => {
    const bot = movingBody();
    bot.entities[2] = enderman(2, gazeEyes(bot).offset(0, 0, -3));
    bot.gazeGuard.enabled = false;
    await bot.look(0, 0, true);
    bot.emit('physicsTick');
    bot._client.write('look', { yaw: 180, pitch: 0 });
    installGazeGuard(bot);
    expect(bot.entity.pitch).toBe(0);
    expect(bot.gazeGuard.averted).toBe(0);
    expect(bot.listenerCount('physicsTick')).toBe(1);
  });
});

describe('the complete set of gaze cones', () => {
  const eyes = new Vec3(0, 65.62, 0);
  it('clears a chain of more than four overlapping cones, independently of entity enumeration order', () => {
    const mobs = Array.from({ length: 15 }, (_, i) => ({ eyes: eyes.plus(viewVector(0, -0.7 + i * 0.1).scaled(3)), tolerance: TOLERANCE }));
    const held = avertedPitch(eyes, 0, 0, mobs);
    expect(avertedPitch(eyes, 0, 0, [...mobs].reverse())).toBeCloseTo(held);
    expect(mobs.every(m => !staring(eyes, 0, held, m.eyes))).toBe(true);
    expect(avertedPitch(eyes, 0, held, mobs)).toBe(held);
  });
  it('keeps an attack inside its pitch interval, or reports no safe aim instead of returning an unsafe one', () => {
    const mobs = [{ eyes: eyes.offset(0, 0, -2), tolerance: TOLERANCE }];
    expect(avertedPitchInRange(eyes, 0, 0, mobs, -0.1, 0.1)).toBeNull();
    const held = avertedPitchInRange(eyes, 0, 0, mobs, -0.1, 0.5)!;
    expect(held).toBeGreaterThan(0.1);
    expect(held).toBeLessThan(0.5);
    expect(staring(eyes, 0, held, mobs[0].eyes)).toBe(false);
  });
  it('handles yaw wrap, eyes above/below and deterministic crowds without leaving any server cone', () => {
    for (let scene = 0; scene < 80; scene++) {
      const yaw = scene * 0.37, pitch = -1.5 + (scene % 30) * 0.1;
      const mobs = Array.from({ length: 12 }, (_, i) => ({ tolerance: TOLERANCE,
        eyes: eyes.plus(viewVector(yaw + Math.sin(i * 1.71) * 0.2, Math.max(-1.57, Math.min(1.57, pitch + (i - 5) * 0.06))).scaled(2 + (i % 4))) }));
      const held = avertedPitchInRange(eyes, yaw, pitch, mobs);
      expect(held).not.toBeNull();
      expect(mobs.every(m => !staring(eyes, yaw, held!, m.eyes))).toBe(true);
    }
  });
});
