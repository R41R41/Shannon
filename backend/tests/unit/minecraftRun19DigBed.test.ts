import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

// The dig and the walk for the drop are stood in for: what is tested is what dig-block-at says about the pack afterwards.
const world = { bedGone: false, pickedBy: 'none' as 'collect' | 'pickup' | 'none' };
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async (original) => ({
  ...(await original() as object), digBlockVerified: vi.fn(async () => { world.bedGone = true; }),
}));
vi.mock('../../src/services/minebot/execution/collectDrops.js', async (original) => ({
  ...(await original() as object),
  collectDrops: vi.fn(async (bot: any) => { if (world.pickedBy === 'collect') { bot.items.push({ name: 'white_bed', count: 1 }); return ['white_bedx1']; } return []; }),
}));
vi.mock('../../src/services/minebot/utils/toolStock.js', async (original) => ({ ...(await original() as object) }));

const { default: DigBlockAt } = await import('../../src/services/minebot/instantSkills/digBlockAt.js');
const registry = minecraftData('1.21.11');
const bed = new Vec3(2, 64, 0);

function body(pickedBy: typeof world.pickedBy) {
  world.bedGone = false; world.pickedBy = pickedBy;
  const items: any[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, items, entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, onGround: true, isInWater: false }, entities: {},
    health: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, heldItem: null,
    inventory: { items: () => items, slots: new Array(46).fill(null), emptySlotCount: () => 20 },
    equip: async () => {}, digTime: () => 300, canDigBlock: () => true,
    blockAt: (at: Vec3) => {
      const p = at.floored();
      if (p.equals(bed) && !world.bedGone) return { name: 'white_bed', type: registry.blocksByName.white_bed.id, boundingBox: 'block', diggable: true, position: p };
      return p.y < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, position: p } : { name: 'air', boundingBox: 'empty', position: p };
    },
  });
  const skill: any = new DigBlockAt(bot);
  skill.callSkill = vi.fn(async (name: string) => {
    if (name === 'pickup-nearest-item' && pickedBy === 'pickup') items.push({ name: 'white_bed', count: 1 });
    return { success: true, result: 'ok' };
  });
  return { bot, skill, items };
}

describe('a placed bed dug with takeEquipment ends in the pack, or is said not to (run 19: an igloo bed never taken)', () => {
  it('the bed picked up with the dig: in the pack, and said as a bed to use', async () => {
    const { skill, items } = body('collect');
    const result = await skill.runImpl(2, 64, 0, true, 'target', true);
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('white_bedx1を持ち物に入れました');
    expect(result.result).toContain('作る必要は無い');
    expect(items).toEqual([{ name: 'white_bed', count: 1 }]);
  });
  it('the drop left lying: looked for once by name, then in the pack', async () => {
    const { skill } = body('pickup');
    const result = await skill.runImpl(2, 64, 0, true, 'target', true);
    expect(result).toMatchObject({ success: true });
    expect(skill.callSkill).toHaveBeenCalledWith('pickup-nearest-item', 'white_bed', 6);
  });
  it('not in the pack after both: no success, and said so (not "taken back")', async () => {
    const { skill } = body('none');
    const result = await skill.runImpl(2, 64, 0, true, 'target', true);
    expect(result).toMatchObject({ success: false, failureType: 'drop_not_collected', recoverable: true });
    expect(result.result).toContain('white_bedは持ち物に入っていません');
  });
});
