import { expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { probeWorksite } from '../../src/services/minebot/utils/probeWorksite.js';
import { probeSight, SIGHT_LIMIT } from '../../src/services/minebot/utils/probeTools.js';
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
it('does not walk a line to a target much farther than the loaded world', async () => {
  const read = () => ({ name: 'air', boundingBox: 'empty' }) as any;
  const far = probeSight(read, [0.5, 2.62, 0.5], { block: { x: 90_000_000, y: 1, z: 0 } });
  expect(far).toMatchObject({ visible: false, reach: false, between: [] });
  expect(far.text).toContain('遠すぎて');
  const edge = probeSight(read, [0.5, 2.62, 0.5], { block: { x: SIGHT_LIMIT - 4, y: 1, z: 0 } });
  expect(edge.text).not.toContain('遠すぎて');
  const bot = botIn((x, y) => Math.abs(x) > 12 ? null : y <= 0 ? 'stone' : 'air');
  const started = performance.now();
  const value = await probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 90_000_000, y: 1, z: 0 });
  expect(performance.now() - started).toBeLessThan(3000);
  expect(value.text).toContain('目的物は未ロード');
  expect(value.text).not.toContain('対象に届く=true');
  expect(value.approach.status).not.toBe('verified_segment');
});
it('discards what it found when the body changes world while the searches wait', async () => {
  const bot = botIn((x, y, z) => x === 2 && y === 1 && z === 0 ? 'iron_ore' : y <= 0 ? 'stone' : 'air');
  const pending = probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, undefined, { x: 0, y: 1, z: 0 });
  bot.game.dimension = 'the_nether';   // a portal taken between the start and the end of the searches
  const value = await pending;
  expect(value).toMatchObject({ stale: true, standCandidates: [] });
  expect(value.approach.status).toBe('unknown');
  expect(value.retreat.status).toBe('unknown');
  expect(value.text).toContain('使えない');
});
it('says a target that is not loaded as such in the sentence the head reads first', async () => {
  const bot = botIn((x, y, z) => x === 2 && y === 1 && z === 0 ? null : y <= 0 ? 'stone' : 'air');
  const value = await probeWorksite(bot, { x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, undefined, { x: 0, y: 1, z: 0 });
  expect(value.target.block).toBeNull();
  expect(value.text).toContain('目的物は未ロード');
  expect(value.text).not.toContain('対象に届く=true');
});
it('refuses a coordinate that is not a finite number before it can turn into null in the answer', async () => {
  const { runProbe } = await import('../../src/services/minebot/instantSkills/probe.js');
  const bot = botIn((x, y) => y <= 0 ? 'stone' : 'air') as any;
  bot.entity.position = new Vec3(0.5, 1, 0.5);
  for (const target of [{ x: NaN, y: 1, z: 0 }, { x: 1, y: Infinity, z: 0 }]) {
    const answer = await runProbe(bot, { kind: 'worksite', target });
    expect(answer.success).toBe(false);
    expect(answer.result).toContain('有限の数');
  }
  const bad = await runProbe(bot, { kind: 'worksite', target: { x: 2, y: 1, z: 0 }, retreat: { x: 0, y: NaN, z: 0 } });
  expect(bad.success).toBe(false);
  const fine = await runProbe(bot, { kind: 'worksite', target: { x: 2, y: 1, z: 0 }, retreat: { x: 0, y: 1, z: 0 } });
  expect(fine.success).toBe(true);
});
