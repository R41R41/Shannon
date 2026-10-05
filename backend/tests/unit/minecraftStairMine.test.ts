import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import StairMine from '../../src/services/minebot/instantSkills/stairMine.js';

function stairBot(startY = 44) {
  const controls = { forward: false, jump: false };
  const bot: any = {
    version: '1.21.11', interruptExecution: false,
    entity: { position: new Vec3(0.5, startY, 0.5), yaw: 0, onGround: true },
    inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] },
    look: vi.fn(async () => {}),
    setControlState: vi.fn((control: 'forward' | 'jump', active: boolean) => { controls[control] = active; }),
    blockAt: (position: Vec3) => position.y === startY && position.x > 0
      ? { name: 'stone', boundingBox: 'block', diggable: true, position }
      : { name: 'air', boundingBox: 'empty', position },
  };
  return { bot, controls };
}

describe('stair-mine movement verification', () => {
  it('does not report a successful ascent when controls never move the bot', async () => {
    const { bot, controls } = stairBot();
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {};

    const result = await skill.runImpl(63, 'east');

    expect(result).toMatchObject({ success: false, failureType: 'stair_progress_blocked' });
    expect(result.result).toContain('Y=44');
    expect(bot.look).toHaveBeenCalledWith(-Math.PI / 2, 0, true);
    expect(controls).toEqual({ forward: false, jump: false });
  });

  it('counts an ascent only after reaching the requested adjacent column and Y', async () => {
    const { bot, controls } = stairBot();
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {
      if (controls.forward && controls.jump) bot.entity.position = new Vec3(1.5, 45, 0.5);
    };

    const result = await skill.runImpl(45, 'east');

    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('Y=45');
    expect(bot.look).toHaveBeenCalledWith(-Math.PI / 2, 0, true);
    expect(controls).toEqual({ forward: false, jump: false });
  });

  it('retains partial progress in the message but does not treat it as achieving the target', async () => {
    const { bot, controls } = stairBot();
    bot.blockAt = (position: Vec3) =>
      (position.x === 1 && position.y === 44 || position.x === 2 && position.y === 45)
      ? { name: 'stone', boundingBox: 'block', diggable: true, position }
      : { name: 'air', boundingBox: 'empty', position };
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {
      if (controls.forward && controls.jump && bot.entity.position.y === 44) {
        bot.entity.position = new Vec3(1.5, 45, 0.5);
      }
    };

    const result = await skill.runImpl(46, 'east');

    expect(result).toMatchObject({ success: false, failureType: 'stair_progress_blocked' });
    expect(result.result).toContain('1段上昇');
    expect(result.result).toContain('Y=45');
  });

  it('does not step down into a column without solid support', async () => {
    const { bot } = stairBot();
    bot.blockAt = (position: Vec3) => ({ name: 'air', boundingBox: 'empty', position });
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {};

    const result = await skill.runImpl(43, 'east');

    expect(result).toMatchObject({ success: false, failureType: 'stair_progress_blocked' });
    expect(bot.look).not.toHaveBeenCalled();
  });

  it('faces the specified direction and verifies a one-block descent', async () => {
    const { bot, controls } = stairBot();
    bot.blockAt = (position: Vec3) => position.x === 1 && position.y === 42
      ? { name: 'stone', boundingBox: 'block', diggable: true, position }
      : { name: 'air', boundingBox: 'empty', position };
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {
      if (controls.forward) bot.entity.position = new Vec3(1.5, 43, 0.5);
    };

    const result = await skill.runImpl(43, 'east');

    expect(result).toMatchObject({ success: true });
    expect(bot.look).toHaveBeenCalledWith(-Math.PI / 2, 0, true);
    expect(controls).toEqual({ forward: false, jump: false });
  });
});

describe('stair-mine tool choice from block data', () => {
  it('equips a pickaxe for andesite and tuff, and picks the fastest harvesting tool', async () => {
    // Diamond descent diagnosis 2026-10-01: andesite matched no name keyword and the iron pickaxe was ignored.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const registry = require('prismarine-registry')('1.21.11');
    const { repairTierToolMaterials } = await import('../../src/services/minebot/utils/registryRepairs.js');
    repairTierToolMaterials(registry);
    const Block = require('prismarine-block')(registry);
    const item = (name: string) => ({ name, type: registry.itemsByName[name].id, count: 1 });
    const bot: any = { version: '1.21.11', entity: { effects: {} },
      inventory: { items: () => [item('wooden_pickaxe'), item('iron_pickaxe'), item('iron_shovel')] } };
    const skill: any = new StairMine(bot);
    const block = (name: string) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
    expect(skill.findBestTool(block('andesite')).name).toBe('iron_pickaxe');
    expect(skill.findBestTool(block('tuff')).name).toBe('iron_pickaxe');
    expect(skill.findBestTool(block('deepslate_diamond_ore')).name).toBe('iron_pickaxe');
    expect(skill.findBestTool(block('gravel')).name).toBe('iron_shovel');
    bot.inventory.items = () => [item('wooden_pickaxe')];
    expect(skill.findBestTool(block('iron_ore'))).toBeNull(); // wood cannot harvest iron ore
  });
});

describe('stair-mine keeps descents dry', () => {
  it('stops before digging into a block beside water and names the water', async () => {
    const bot: any = {
      version: '1.21.11', interruptExecution: false,
      entity: { position: new Vec3(0.5, 40, 0.5), yaw: 0, onGround: true },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, type: 1 }] },
      look: vi.fn(async () => {}), setControlState: vi.fn(), equip: vi.fn(async () => {}), dig: vi.fn(async () => {}),
      blockAt: (position: Vec3) => position.x === 1 && position.y === 42 && position.z === 0
        ? { name: 'water', boundingBox: 'empty', position }
        : position.x === 1 && position.y >= 39 && position.y <= 41
          ? { name: 'stone', boundingBox: 'block', diggable: true, position }
          : { name: 'stone', boundingBox: 'block', diggable: true, position },
    };
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {};
    const result = await skill.runImpl(20, 'east');
    expect(result).toMatchObject({ success: false, failureType: 'stair_progress_blocked' });
    expect(result.result).toContain('が水です');
    expect(bot.dig).not.toHaveBeenCalled();
  });
});
