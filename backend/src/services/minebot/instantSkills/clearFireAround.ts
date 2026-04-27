import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { equipDigTool } from '../utils/endDragonUtils.js';
import type { SkillResult } from '../types/skillParams.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:clearFireAround');

const DIG_REACH = 4.5;

class ClearFireAround extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'clear-fire-around';
    this.description =
      '指定座標周辺の炎（fire/soul_fire）を除去します。リーチ外の炎には自動で近寄ります。';
    this.params = [
      { name: 'x', type: 'number', description: '中心X座標', required: true },
      { name: 'z', type: 'number', description: '中心Z座標', required: true },
      { name: 'radius', type: 'number', description: '走査半径（デフォルト: 10）', required: false, default: 10 },
      { name: 'yBase', type: 'number', description: '基準Y座標（デフォルト: ボットの足元Y）', required: false, default: 0 },
    ];
  }

  async runImpl(x: number, z: number, radius: number = 10, yBase: number = 0): Promise<SkillResult> {
    const centerX = Math.round(x);
    const centerZ = Math.round(z);
    const baseY = yBase > 0 ? yBase : Math.floor(this.bot.entity.position.y);

    const firePositions: Vec3[] = [];

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -2; dy <= 5; dy++) {
          const pos = new Vec3(centerX + dx, baseY + dy, centerZ + dz);
          const block = this.bot.blockAt(pos);
          if (block && (block.name === 'fire' || block.name === 'soul_fire')) {
            firePositions.push(pos);
          }
        }
      }
    }

    if (firePositions.length === 0) {
      return { success: true, result: '炎は見つかりませんでした。' };
    }

    log.info(`🔥 炎検出: ${firePositions.length} 個 (中心: ${centerX}, ${centerZ} 半径: ${radius})`);

    let cleared = 0;
    for (const firePos of firePositions) {
      if (this.shouldInterrupt()) break;

      const botPos = this.bot.entity.position;
      if (botPos.distanceTo(firePos) > DIG_REACH) {
        try {
          await gotoSafe(
            this.bot,
            new goals.GoalNear(firePos.x, firePos.y, firePos.z, 3),
            { timeoutMs: 3_000, stuckAbortCount: 2 },
          );
        } catch { /* couldn't reach */ }
      }

      await equipDigTool(this.bot);
      for (let attempt = 0; attempt < 3; attempt++) {
        const block = this.bot.blockAt(firePos);
        if (!block || (block.name !== 'fire' && block.name !== 'soul_fire')) break;
        try {
          await this.bot.dig(block);
          await this.sleep(100);
        } catch { /* ignore */ }
        const after = this.bot.blockAt(firePos);
        if (!after || (after.name !== 'fire' && after.name !== 'soul_fire')) {
          cleared++;
          break;
        }
      }
    }

    return {
      success: true,
      result: `炎を ${cleared}/${firePositions.length} 個除去しました。`,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default ClearFireAround;
