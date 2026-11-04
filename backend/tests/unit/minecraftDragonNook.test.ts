import { describe, expect, it } from 'vitest';
import { dragonNook, insideDragonNook, type NookWorld } from '../../src/services/minebot/utils/dragonNook.js';
import { boxDistance, partBox } from '../../src/services/minebot/utils/dragonParts.js';
import { cloudReaches, dragonHazards } from '../../src/services/minebot/utils/dragonDanger.js';
import { Vec3 } from 'vec3';
import { blastAt } from '../../src/services/minebot/utils/crystalBlast.js';

function fixture(dx = 0, dy = 0, dz = 0, yaw = 0) {
  const blocks = new Map<string, any>(), key = (p: any) => `${p.x},${p.y},${p.z}`;
  const world: NookWorld = { perch: { x: dx + 0.5, y: dy + 68, z: dz + 0.5 },
    dragon: { position: { x: dx + 0.5, y: dy + 68, z: dz + 0.5 }, yaw, phase: 6 }, dragonBreath: [] };
  const read = (p: any) => blocks.get(key(p)) ?? (p.y < dy + 64 ? { name: 'end_stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', shapes: [] });
  const build = (bed = false) => {
    const result = dragonNook(world, read, bed);
    expect(result.reason).toBeNull(); const plan = result.plan!;
    for (const p of plan.cells) blocks.set(key(p), { name: p.block, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
    for (const p of plan.dig) blocks.set(key(p), { name: 'air', boundingBox: 'empty' });
    return plan;
  };
  return { world, read, build, blocks, key };
}

describe('observed raised dragon nook geometry', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('stays within sword reach and material limits at yaw %s', yaw => {
    const f = fixture(110, 6, -31, yaw), plan = f.build();
    expect(plan.stand).toEqual(plan.strike);
    expect(boxDistance({ ...plan.stand, y: plan.stand.y + 1.62 }, partBox(f.world.dragon!, 'head'))).toBeLessThanOrEqual(5);
    expect(plan.cells.filter(c => c.block === 'obsidian').length).toBeLessThanOrEqual(12);
    expect(plan.cells.filter(c => c.block === 'cobblestone').length).toBeLessThanOrEqual(64);
    expect(plan.window).toMatchObject({ walkMeters: 0, firstBlowSeconds: 0.65, minimumSeconds: 2.45, fits: true });
    expect(insideDragonNook(plan, plan.stand, f.read)).toBe(true);
    expect(plan.protection.unconditionalSafety).toBe(false);
  });

  it('translates with the observed island; has no fountain/world coordinates baked in', () => {
    const a = fixture().build(), b = fixture(123, 13, -211).build();
    expect(b.stand).toEqual({ x: a.stand.x + 123, y: a.stand.y + 13, z: a.stand.z - 211 });
    expect(b.cells.map(p => ({ ...p, x: p.x - 123, y: p.y - 13, z: p.z + 211 }))).toEqual(a.cells);
  });

  it('offers a bed screen only when both possible explosion halves estimate at most four damage', () => {
    const f = fixture(), plan = f.build(true);
    expect(plan.bed).not.toBeNull(); expect(plan.bed!.expectedDamage).toBeLessThanOrEqual(4);
    expect(plan.cells.filter(c => c.block === 'obsidian').length).toBeLessThanOrEqual(12);
    const bot = { blockAt: f.read, health: 20, game: { difficulty: 'normal' }, inventory: { slots: {
      5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' }, 8: { name: 'iron_boots' },
    } } };
    for (const half of [plan.bed!.foot, plan.bed!.partner]) {
      expect(blastAt(bot, { x: half.x + 0.5, y: half.y + 0.5, z: half.z + 0.5 }, plan.stand, 5, [plan.bed!.foot, plan.bed!.partner]).expected).toBeLessThanOrEqual(4);
    }
  });

  it('refuses unknown/liquid/void ground and a flying or unobserved dragon', () => {
    const f = fixture();
    for (const read of [() => null, () => ({ name: 'water' }), () => ({ name: 'air' })]) expect(dragonNook(f.world, read).plan).toBeNull();
    expect(dragonNook({}, f.read).plan).toBeNull();
    f.world.dragon!.phase = 3; expect(dragonNook(f.world, f.read).plan).toBeNull();
  });

  it('does not count residence with a missing roof or before the scaffold is removed', () => {
    const f = fixture(), plan = f.build(), roof = plan.cells.find(c => c.role === 'roof')!;
    f.blocks.delete(f.key(roof)); expect(insideDragonNook(plan, plan.stand, f.read)).toBe(false);
    f.blocks.set(f.key(roof), { name: 'obsidian', boundingBox: 'block' });
    f.blocks.set(f.key(plan.dig[0]), { name: 'cobblestone', boundingBox: 'block' });
    expect(insideDragonNook(plan, plan.stand, f.read)).toBe(false);
  });

  it('clears a ground cloud vertically, but a new cloud at the raised feet still reaches it', () => {
    const f = fixture(), plan = f.build();
    expect(cloudReaches({ ...plan.stand, y: 64 }, 7, plan.stand)).toBe(false);
    expect(cloudReaches(plan.stand, 7, plan.stand)).toBe(true);
  });

  it('keeps the existing fireball reflex even when an overhead roof stops the predicted line', () => {
    const f = fixture(), plan = f.build();
    const p = plan.stand, ball = { id: 30, name: 'dragon_fireball', position: new Vec3(p.x, p.y + 9, p.z), metadata: [] };
    const bot = { game: { dimension: 'minecraft:the_end' }, entity: { position: new Vec3(p.x, p.y, p.z) },
      entities: { 30: ball }, toldVelocities: new Map([[30, new Vec3(0, -0.5, 0)]]), blockAt: (v: any) => f.read(v) };
    expect(dragonHazards(bot).some(h => h.kind === 'fireball')).toBe(true);
  });
});
