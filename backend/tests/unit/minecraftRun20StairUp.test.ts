import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import StairMine from '../../src/services/minebot/instantSkills/stairMine.js';

function upBot(blocks = 64) {
  const bot: any = {
    version: '1.21.11', interruptExecution: false,
    entity: { position: new Vec3(0.5, -58, 0.5), yaw: 0, onGround: true },
    inventory: { items: () => [{ name: 'diamond_pickaxe', count: 1 }, ...(blocks ? [{ name: 'cobblestone', count: blocks }] : [])] },
    look: vi.fn(async () => {}), setControlState: vi.fn(),
    blockAt: (position: Vec3) => ({ name: 'air', boundingBox: 'empty', position }),
  };
  return bot;
}

describe('run 20: the way up from underground', () => {
  it('climbs by pillar (tower-up, twenty levels a call) when the blocks are there, and says the sideways part is not done', async () => {
    const bot = upBot();
    const skill: any = new StairMine(bot);
    const calls: number[] = [];
    skill.callSkill = vi.fn(async (name: string, height: number) => {
      calls.push(height); expect(name).toBe('tower-up');
      bot.entity.position = new Vec3(0.5, bot.entity.position.y + height, 0.5);
      return { success: true, result: 'ok' };
    });
    const result = await skill.runImpl(2, 'east');
    expect(calls).toEqual([20, 20, 20]);          // 60 levels from -58 to 2
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('60段上昇してY=2に到達しました');
    expect(result.result).toContain('直上登り');
    expect(result.result).toContain('east');
  });

  it('with too few blocks it does not pillar, and when the pillar stops it hands the rest to the stair with the reason kept', async () => {
    const few = upBot(5);
    const skillFew: any = new StairMine(few);
    skillFew.callSkill = vi.fn();
    skillFew.sleep = async () => {};
    await skillFew.runImpl(-40, 'east');
    expect(skillFew.callSkill).not.toHaveBeenCalled();

    const bot = upBot();
    const skill: any = new StairMine(bot);
    skill.sleep = async () => {};
    skill.callSkill = vi.fn(async (_name: string, height: number) => {
      bot.entity.position = new Vec3(0.5, bot.entity.position.y + 5, 0.5);
      return { success: false, result: '頭上に掘れないブロックがあります', failureType: 'place_failed' };
    });
    const result: any = await skill.runImpl(-40, 'east');
    expect(skill.callSkill).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.result).toContain('直上登りが途中で止まりました');
  });
});
