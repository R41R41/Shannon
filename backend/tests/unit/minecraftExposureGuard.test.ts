import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { installExposureDigGuard, ThreatExposedError, threatExposedBy } from '../../src/services/minebot/utils/exposureGuard.js';
import { exposedByOpening, threatExposure } from '../../src/services/minebot/utils/threatExposure.js';

const stone = { name: 'stone', boundingBox: 'block' }, air = { name: 'air', boundingBox: 'empty' };
/**
 * Stone up to y=64 and open air above. The body stands shut in a shaft two deep at (0, 62..63, 0), roofed at
 * y=64. A second, separate pocket at (6, 62..63, 0) holds whatever is put there.
 */
function world(extraAir: string[] = []) {
  const open = new Set(['0,62,0', '0,63,0', '6,62,0', '6,63,0', ...extraAir]);
  return (pos: Vec3) => pos.y > 64 || open.has(`${pos.x},${pos.y},${pos.z}`) ? air : stone;
}
function body(entities: Record<string, any>, extraAir: string[] = [], extra: Record<string, unknown> = {}) {
  return { entity: { position: new Vec3(0.5, 62, 0.5), id: 1 }, entities, blockAt: world(extraAir), oxygenLevel: 20, ...extra } as any;
}
const mob = (name: string, x: number, y: number, z: number, id = 2) => ({ id, name, position: new Vec3(x, y, z), height: 1.95 });

describe('a dig that would let a shut-out hostile at the body is refused (paid run L72 dug its roof off five times; L70 died of it)', () => {
  it('the roof over a shut-in body, with a zombie standing on the ground above, is refused; without the zombie it is not', () => {
    const zombie = mob('zombie', 3.5, 65, 0.5);
    const bot = body({ 2: zombie });
    expect(threatExposure(bot, zombie, 1)).toBe('sealed');
    expect(threatExposedBy(bot, new Vec3(0, 64, 0))).toMatchObject({ name: 'zombie' });
    expect(threatExposedBy(body({}), new Vec3(0, 64, 0))).toBeNull();
    // An animal is no reason to stay in.
    expect(threatExposedBy(body({ 2: mob('cow', 3.5, 65, 0.5) }), new Vec3(0, 64, 0))).toBeNull();
    // Too far to matter, by the radius the emergency layer judges by.
    expect(threatExposedBy(body({ 2: mob('zombie', 30.5, 65, 0.5) }), new Vec3(0, 64, 0))).toBeNull();
    expect(threatExposedBy(body({ 2: mob('skeleton', 20.5, 65, 0.5) }, [], { hostileThreatRadius: () => 22 }), new Vec3(0, 64, 0))).toMatchObject({ name: 'skeleton' });
  });

  it('a wall into solid rock is not refused: the body may tunnel away from what is outside', () => {
    const bot = body({ 2: mob('zombie', 3.5, 65, 0.5) });
    expect(threatExposedBy(bot, new Vec3(-1, 62, 0))).toBeNull();
    expect(threatExposedBy(bot, new Vec3(0, 61, 0))).toBeNull();
    // A wall with the mob's own pocket behind it is.
    const tunnel = ['2,62,0', '3,62,0', '4,62,0', '5,62,0', '2,63,0', '3,63,0', '4,63,0', '5,63,0'];   // open, two high, from x=2 to its pocket
    const zombieNextDoor = () => ({ 2: mob('zombie', 6.5, 62, 0.5) });
    // What is left of the wall is one block at the head, over a gap at the feet: taking it lets the zombie in.
    expect(threatExposedBy(body(zombieNextDoor(), [...tunnel, '1,62,0']), new Vec3(1, 63, 0))).toMatchObject({ name: 'zombie' });
    // A gap one cell high is no way in for a mob two cells tall, nor a line between its eyes and the body's;
    // it is a way in for a mob that fits it (lab: a blaze behind a slit was "let in" by a dig that widened
    // nothing it could use, and the dig was refused).
    expect(threatExposedBy(body(zombieNextDoor(), tunnel), new Vec3(1, 62, 0))).toBeNull();
    expect(threatExposedBy(body({ 2: { ...mob('spider', 6.5, 62, 0.5), height: 0.9 } }, tunnel), new Vec3(1, 62, 0))).toMatchObject({ name: 'spider' });
  });

  it('never stands between the body and its air: its own cells, and any dig while it is short of air under water', () => {
    const zombie = mob('zombie', 3.5, 65, 0.5);
    expect(threatExposedBy(body({ 2: zombie }), new Vec3(0, 63, 0))).toBeNull();           // the cell its head is in
    const drowning = body({ 2: zombie }, [], { oxygenLevel: 6 });
    drowning.entity.isInWater = true;
    expect(threatExposedBy(drowning, new Vec3(0, 64, 0))).toBeNull();
  });

  it('only what is shut out now is counted: a mob already able to reach the body is not what this dig lets in', () => {
    const open = ['0,64,0'];                                  // the roof is already off
    const zombie = mob('zombie', 3.5, 65, 0.5);
    const bot = body({ 2: zombie }, open);
    expect(threatExposure(bot, zombie, 1)).not.toBe('sealed');
    expect(exposedByOpening(bot, [zombie], new Vec3(1, 63, 0), 1)).toEqual([]);
  });

  it('as a guard on the body: the dig is not sent, the reason says who and how far, and the count is kept', async () => {
    let sent = 0;
    const bot = body({ 2: mob('zombie', 3.5, 65, 0.5) }, [], { dig: async () => { sent++; } });
    installExposureDigGuard(bot);
    await expect(bot.dig({ name: 'stone', position: new Vec3(0, 64, 0) })).rejects.toBeInstanceOf(ThreatExposedError);
    expect(sent).toBe(0);
    expect(bot.exposureDigGuard).toMatchObject({ refused: 1 });
    expect(bot.exposureDigGuard.last).toContain('zombie');
    expect(bot.exposureDigGuard.last).toContain('待つ');
    await bot.dig({ name: 'stone', position: new Vec3(-1, 62, 0) });
    expect(sent).toBe(1);
  });
});
