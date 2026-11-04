import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { endermenFarther, endermenWithoutSight, pickEnderman } from '../../src/services/minebot/utils/primitives/fight.js';

/**
 * `fight target=enderman` (the kind): the one picked is the one the roof hunts of 11/4 won with (S6): an angry one first, else the nearest whose
 * eyes are in sight within 8-48 m (30 m first). A trunk between the body's eyes and an enderman's eyes leaves that one out.
 */
const registry = { entitiesByName: { enderman: { metadataKeys: ['flags', 'carried', 'creepy', 'stared_at'] } } };
function body(blocks: Record<string, string> = {}, entities: any[] = []) {
  const self = { position: new Vec3(0.5, 64, 0.5) };
  const all: Record<number, any> = {};
  for (const e of entities) all[e.id] = e;
  return {
    entity: self, registry, entities: all,
    blockAt: (p: Vec3) => {
      const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 ? 'warped_nylium' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
  };
}
const enderman = (id: number, x: number, z = 0.5, angry = false) => ({ id, name: 'enderman', position: new Vec3(x, 64, z), isValid: true,
  metadata: [0, null, angry, false] });

describe('fight picks the enderman of a roof hunt', () => {
  it('takes one 40 m off whose eyes are seen (the old 32 m pick found none)', () => {
    const bot = body({}, [enderman(7, 40.5)]);
    expect(pickEnderman(bot)?.id).toBe(7);
  });

  it('passes over a nearer one whose eyes a trunk hides, for one in sight', () => {
    // A stem column at x=6 from the floor up to the eye's height on the line to #1 (straight east); #2 stands to the north-east, clear.
    const stem: Record<string, string> = {};
    for (let y = 64; y <= 68; y++) stem[`6,${y},0`] = 'warped_stem';
    const bot = body(stem, [enderman(1, 12.5), enderman(2, 14.5, 14.5)]);
    expect(pickEnderman(bot)?.id).toBe(2);
  });

  it('keeps the 8-30 m band ahead of a farther one, and an angry one ahead of all', () => {
    expect(pickEnderman(body({}, [enderman(3, 40.5), enderman(4, 20.5, 5.5)]))?.id).toBe(4);
    expect(pickEnderman(body({}, [enderman(3, 40.5), enderman(4, 20.5, 5.5), enderman(5, 45.5, -9.5, true)]))?.id).toBe(5);
  });

  it('gives none when no eyes are in sight in 8-48 m (the caller keeps its own pick)', () => {
    expect(pickEnderman(body({}, [enderman(6, 4.5), enderman(8, 60.5)]))).toBeNull();
  });

  it('says at once that the endermen about all have their eyes hidden, the nearest and what hides it', () => {
    const stem: Record<string, string> = {};
    for (let y = 64; y <= 68; y++) stem['6,' + y + ',0'] = 'warped_stem';
    const bot = body(stem, [enderman(1, 12.5)]);
    expect(pickEnderman(bot)).toBeNull();
    const words = endermenWithoutSight(bot)!;
    expect(words).toContain('1 体はどれも目が見えない');
    expect(words).toContain('#1 12.0m');
    expect(words).toContain('warped_stem');
    expect(endermenWithoutSight(body({}, []))).toBeNull();
    // A near one in sight (under the 8 m band) is not "none in sight": the old pick takes it.
    expect(endermenWithoutSight(body({}, [enderman(6, 4.5)]))).toBeNull();
  });

  it('names the endermen seen beyond 48 m, nearest first, with the way to them', () => {
    const words = endermenFarther(body({}, [enderman(9, 70.5), enderman(10, 0.5, -90.5), enderman(11, 20.5)]));
    expect(words).toContain('#9 70m 東');
    expect(words).toContain('#10 91m 北');
    expect(words).not.toContain('#11');
    expect(endermenFarther(body({}, [enderman(11, 20.5)]))).toBe('');
  });
});
