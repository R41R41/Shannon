import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the actual strike loop with only its surrounding I/O replaced.
vi.mock('../../src/services/minebot/utils/mapMarks.js', () => ({ entityHealth: () => 200 }));
vi.mock('../../src/services/minebot/utils/engagement.js', () => ({ beginEngagement: () => () => undefined }));
vi.mock('../../src/services/minebot/execution/ActionExecution.js', () => ({ nativeActionHost: (bot: unknown) => bot }));
vi.mock('../../src/services/minebot/utils/dragonState.js', () => ({ dragonPhaseOf: (_bot: unknown, dragon: any) => dragon.phase, STRIKE_REACH: 5 }));
vi.mock('../../src/services/minebot/utils/primitives/common.js', () => ({
  letGo: vi.fn(), StepStopped: class extends Error {},
  stopped: (_bot: unknown, reason: string, text: string) => ({ ok: false, reason, text }),
  wait: (_ctx: unknown, ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}));

import { dragonStrikeAim, strikeDragon } from '../../src/services/minebot/utils/primitives/dragonStrike.js';
import { boxCentre, partBox } from '../../src/services/minebot/utils/dragonParts.js';
import { gazeEyes, installGazeGuard, viewVector } from '../../src/services/minebot/utils/gazeGuard.js';

afterEach(() => { vi.useRealTimers(); });
function fixture() {
  const dragon = { id: 100, position: new Vec3(0, 68, 0), yaw: 0, phase: 6 };
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 65, 10), yaw: 0, pitch: 0, eyeHeight: 1.62 }, entities: { 100: dragon },
    heldItem: { name: 'stone_sword' }, attack: vi.fn(),
    look: vi.fn(async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; }),
    lookAt: vi.fn(async () => undefined),
  });
  installGazeGuard(bot);
  return { bot, dragon };
}
function coverHead(bot: any, dragon: any) {
  const eye = gazeEyes(bot), centre = boxCentre(partBox(dragon, 'head'));
  const line = new Vec3(centre.x, centre.y, centre.z).minus(eye).normalize();
  const eyes = eye.plus(line.scaled(2));
  bot.entities[2] = { id: 2, name: 'enderman', position: eyes.offset(0, -2.55, 0) };
  return eyes;
}
function coverReachableParts(bot: any) {
  const eye = gazeEyes(bot);
  bot.entity.yaw = Math.PI;
  // A close, dense vertical group covers every forward pitch but leaves looking behind safe.
  for (let i = 0; i <= 24; i++) {
    const eyes = eye.plus(viewVector(0, -Math.PI / 2 + i * Math.PI / 24).scaled(2));
    bot.entities[i + 2] = { id: i + 2, name: 'enderman', position: eyes.offset(0, -2.55, 0) };
  }
}

describe('dragon aim shares the gaze geometry', () => {
  it('keeps an unblocked head aim exactly', () => {
    const { bot, dragon } = fixture();
    const aim = dragonStrikeAim(bot, dragon)!;
    expect(aim.part).toBe('head');
    expect(aim.point).toEqual(new Vec3(0, 67.5, 6.5));
    expect(aim.look).toEqual(aim.requested);
  });
  it('uses a safe elevation in the same part when a more distant eye only covers its centre', () => {
    const { bot, dragon } = fixture(), eye = gazeEyes(bot);
    const centre = new Vec3(0, 67.5, 6.5);
    const mobEyes = eye.plus(centre.minus(eye).normalize().scaled(30));
    bot.entities[2] = { id: 2, name: 'enderman', position: mobEyes.offset(0, -2.55, 0) };
    const aim = dragonStrikeAim(bot, dragon)!;
    expect(aim.part).toBe('head');
    expect(aim.point.y).toBeGreaterThan(67);
    expect(aim.point.y).toBeLessThan(68);
    expect(aim.look.pitch).not.toBe(aim.requested.pitch);
  });
  it('changes to a reachable neck when a close (2 m) eye covers the whole head column', () => {
    const { bot, dragon } = fixture(), mobEyes = coverHead(bot, dragon);
    const aim = dragonStrikeAim(bot, dragon)!;
    expect(aim.part).toBe('neck');
    const box = partBox(dragon, aim.part);
    expect(aim.point.y).toBeGreaterThan(box.minY);
    expect(aim.point.y).toBeLessThan(box.maxY);
    const line = mobEyes.minus(gazeEyes(bot));
    expect(viewVector(aim.look.yaw, aim.look.pitch).dot(line.normalize())).toBeLessThan(1 - 0.025 / line.norm());
  });
  it('counts a changed attack and still sends the actual dragon part id', async () => {
    vi.useFakeTimers();
    const { bot, dragon } = fixture();
    coverHead(bot, dragon);
    const run = strikeDragon({ bot } as any, dragon, 100);
    await vi.advanceTimersByTimeAsync(150);
    await run;
    expect(bot.attack).toHaveBeenCalledTimes(1);
    expect(bot.attack.mock.calls[0][0]).toMatchObject({ id: 102, dragonPart: 'neck' });
    expect(bot.gazeGuard).toMatchObject({ attackAverted: 1, attackBlocked: 0, bySource: { attack: 1 } });
    expect(bot.gazeGuard.lastAverted).toMatchObject({ target: { id: 100, part: 'neck' } });
  });
  it('counts a blocked attempt once per weapon cooldown, holds a safe gaze and does not claim out of reach', async () => {
    vi.useFakeTimers();
    const { bot, dragon } = fixture();
    coverReachableParts(bot);
    expect(dragonStrikeAim(bot, dragon)).toBeNull();
    const run = strikeDragon({ bot } as any, dragon, 1400);
    await vi.advanceTimersByTimeAsync(1450);
    const result = await run;
    expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.gazeGuard.attackBlocked).toBe(3);
    expect(bot.gazeGuard.lastAttackBlocked).toMatchObject({ source: 'attack', held: null, target: { id: 100, part: 'head' } });
    expect(bot.gazeGuard.lastAttackBlocked.creatures).toHaveLength(8);
    expect(result.reason).toBe('gaze_blocked');
  });
  it('uses the same crouched eye for reach and aim, and honours intentional gaze disable', () => {
    const { bot, dragon } = fixture();
    bot.entity.eyeHeight = 1.27;
    coverReachableParts(bot);
    bot.gazeGuard.enabled = false;
    const aim = dragonStrikeAim(bot, dragon)!;
    expect(aim.part).toBe('head');
    expect(aim.look.pitch).toBeCloseTo(Math.atan2(67.5 - 66.27, 3.5));
  });
});
