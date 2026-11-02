import { expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { probeWorksite } from '../../src/services/minebot/utils/probeWorksite.js';
const botIn = (nameAt: (x: number, y: number, z: number) => string | null) => ({
  entity: { position: new Vec3(0.5, 1, 0.5), onGround: true }, game: { dimension: 'overworld' },
  inventory: { items: () => [{ type: 1 }] },
  blockAt: (at: Vec3) => {
    const name = nameAt(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
    return name === null ? null : { name, position: at, boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block',
      shapes: ['air', 'water'].includes(name) ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}),
      digTime: () => 500, canHarvest: (type: number) => type === 1 };
  },
});
it('uses the current reachable stand and verifies the return separately', async () => {
  const bot = botIn((x, y, z) => x === 2 && y === 1 && z === 0 ? 'iron_ore' : y <= 0 ? 'stone' : 'air');
  const value = await probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, undefined, { x: 0, y: 1, z: 0 });
  expect(value.approach.status).toBe('verified_segment');
  expect(value.standCandidates[0]?.at).toEqual({ x: 0, y: 1, z: 0 });
  expect(value.retreat.status).toBe('verified_segment');
  expect(value.work.harvest).toBe(true);
});
it('does not certify a route from a start without footing', async () => {
  const bot = botIn((x, y, z) => x === 2 && y === 1 && z === 0 ? 'iron_ore'
    : y <= 0 && (x !== 0 || z !== 0) ? 'stone' : 'air');
  const value = await probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, { x: 1, y: 1, z: 0 });
  expect(value.approach.status).toBe('unknown');
});
it('does not mistake a downhill approach for a return route', async () => {
  const bot = botIn((x, y, z) => {
    if (z !== 0) return 'bedrock';
    if (x === 3 && y === -2) return 'iron_ore';
    return y <= (x <= 0 ? 0 : -3) ? 'stone' : 'air';
  });
  const value = await probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 3, y: -2, z: 0 }, { x: 2, y: -2, z: 0 }, { x: 0, y: 1, z: 0 });
  expect(value.approach.status).toBe('verified_segment');
  expect(value.retreat.status).toBe('blocked');
});
it('leaves an unloaded return and a submerged head explicit', async () => {
  const bot = botIn((x, y, z) => x > 4 ? null : x === 2 && y === 1 && z === 0 ? 'iron_ore' : y <= 0 ? 'stone' : y === 2 ? 'water' : 'air');
  const value = await probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 300, y: 1, z: 0 });
  expect(value.standCandidates[0]).toMatchObject({ breathing: 'submerged' });
  expect(value.retreat.status).toBe('unknown');
});
