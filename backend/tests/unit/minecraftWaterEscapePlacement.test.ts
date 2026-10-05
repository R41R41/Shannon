import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import TowerUp from '../../src/services/minebot/instantSkills/towerUp.js';
import PlaceBlockAt from '../../src/services/minebot/instantSkills/placeBlockAt.js';

const water = (position: Vec3) => ({ name: 'water', boundingBox: 'empty', position, diggable: false });
const stone = (position: Vec3) => ({ name: 'stone', boundingBox: 'block', position, diggable: true });

describe('escaping water by placing blocks', () => {
  it('lets tower-up climb through water overhead while swimming, but not from dry ground', async () => {
    // Paid run 2026-10-01: tower-up refused "water overhead" in a flooded shaft and the bot drowned.
    const bot: any = { entity: { position: new Vec3(0.5, 59, 0.5), isInWater: true },
      blockAt: (pos: Vec3) => water(pos.floored()), inventory: { items: () => [] } };
    const skill: any = new TowerUp(bot);
    expect(await skill.clearAbove()).toBe(true);
    bot.entity.isInWater = false;
    expect(await skill.clearAbove()).toBe(false);
  });

  it('fills the flooded cell under a floating bot from the floor before climbing', async () => {
    const floorY = 57;
    const placed = new Set<number>();
    const bot: any = { entity: { position: new Vec3(0.5, 59.2, 0.5), isInWater: true, velocity: new Vec3(0, 0, 0) },
      blockAt: (pos: Vec3) => {
        const p = pos.floored();
        if (p.y <= floorY || placed.has(p.y)) return stone(p);
        return water(p);
      },
      placeBlock: vi.fn(async (ref: any) => { placed.add(ref.position.y + 1); }),
      inventory: { items: () => [] }, setControlState: vi.fn(), getControlState: () => false,
      heldItem: { name: 'cobblestone' }, pathfinder: { isMoving: () => false } };
    const skill: any = new TowerUp(bot);
    skill.clearAbove = async () => true;
    await skill.tryTowerOneBlock();
    expect(bot.placeBlock.mock.calls[0][0].position).toEqual(new Vec3(0, floorY, 0));
    expect(placed.has(floorY + 1)).toBe(true);
  });

  it('place-block-at places into water against a solid face, never against neighbouring water', async () => {
    const target = new Vec3(0, 60, 0);
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0.5, 60, 2.5) },
      inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
      blockAt: (pos: Vec3) => pos.equals(new Vec3(1, 60, 0)) ? stone(pos) : water(pos),
      equip: vi.fn(async () => {}), placeBlock: vi.fn(async () => {}) };
    const result: any = await new PlaceBlockAt(bot).runImpl('cobblestone', target.x, target.y, target.z);
    expect(result).toMatchObject({ success: true });
    expect(bot.placeBlock).toHaveBeenCalledWith(expect.objectContaining({ name: 'stone' }), new Vec3(-1, 0, 0));
  });
});
