import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avertedPitch, gazeEyes, installGazeGuard, viewVector } from '../../src/services/minebot/utils/gazeGuard.js';

const require = createRequire(import.meta.url);
const injectPhysics = require('mineflayer/lib/plugins/physics.js');
afterEach(() => { vi.restoreAllMocks(); });

/** Actual installed mineflayer look/cache/packet code. Physics simulation is off; only its timer's send path runs. */
function physicsBody() {
  let now = 0, physicsTick = () => {};
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { physicsTick = fn; return 1; }) as any);
  const wire = vi.fn();
  const client = Object.assign(new EventEmitter(), { write: wire });
  const bot: any = Object.assign(new EventEmitter(), {
    registry: require('minecraft-data')('1.21.4'), _client: client, supportFeature: () => false, isAlive: true,
    entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, eyeHeight: 1.62 },
    entities: {}, blockAt: () => ({ boundingBox: 'empty' }),
  });
  injectPhysics(bot, { physicsEnabled: false });
  bot.emit('login');
  client.emit('position', { x: 0, y: 64, z: 0, yaw: 180, pitch: 0, flags: 0 });
  wire.mockClear();
  return { bot, wire, send: () => { now += 51; physicsTick(); } };
}
function unsafe(packet: any, eyes: Vec3, target: Vec3): boolean {
  const line = target.minus(eyes), distance = line.norm();
  return viewVector(Math.PI - packet.yaw * Math.PI / 180, -packet.pitch * Math.PI / 180).dot(line.scaled(1 / distance)) > 1 - 0.025 / distance;
}

describe('mineflayer sends the protected gaze', () => {
  it('reproduces the old entity-only pitch hole at 2 m, and sends the forced correction in one tick now', () => {
    for (const protect of [false, true]) {
      const { bot, wire, send } = physicsBody();
      const eyes = gazeEyes(bot), target = eyes.offset(0, 0, -2);
      bot.entities[2] = { id: 2, name: 'enderman', position: target.offset(0, -2.55, 0) };
      if (protect) { installGazeGuard(bot); bot.emit('physicsTick'); }
      else bot.entity.pitch = avertedPitch(eyes, 0, 0, [{ eyes: target, tolerance: 0.025 }]);
      send();
      const packet = wire.mock.calls.find(([name]) => name === 'look' || name === 'position_look')![1];
      expect(unsafe(packet, eyes, target)).toBe(!protect);
    }
  });
  it('covers a rotation set by a later physics listener, even when it bypasses bot.look', async () => {
    const { bot, wire, send } = physicsBody();
    const unwrappedLook = bot.look;
    installGazeGuard(bot);
    const eyes = gazeEyes(bot), target = eyes.offset(0, 0, -2);
    bot.entities[2] = { id: 2, name: 'enderman', position: target.offset(0, -2.55, 0) };
    bot.on('physicsTick', () => { void unwrappedLook(0, 0, true); bot.entity.pitch = 0; });
    bot.emit('physicsTick');
    bot.entity.position.x += 0.001; // force a position_look packet on this send
    send();
    const packets = wire.mock.calls.filter(([name]) => name === 'look' || name === 'position_look');
    expect(packets.length).toBe(1);
    expect(unsafe(packets[0][1], gazeEyes(bot), target)).toBe(false);
    expect(bot.gazeGuard.bySource.packet).toBe(1);
  });
  it('checks the intermediate yaw during an ordinary smooth turn, although its requested endpoint is safe', async () => {
    const { bot, wire, send } = physicsBody();
    installGazeGuard(bot);
    const eyes = gazeEyes(bot), target = eyes.offset(0, 0, -3);
    bot.entities[2] = { id: 2, name: 'enderman', position: target.offset(0, -2.55, 0) };
    // The target look is clear; the first interpolated yaw is still close to zero.
    const pending = bot.look(0.5, 0, false);
    for (let i = 0; i < 5; i++) send();
    await pending;
    const packets = wire.mock.calls.filter(([name]) => name === 'look' || name === 'position_look');
    expect(packets.length).toBeGreaterThan(0);
    expect(packets.every(([, packet]) => !unsafe(packet, eyes, target))).toBe(true);
  });
});
