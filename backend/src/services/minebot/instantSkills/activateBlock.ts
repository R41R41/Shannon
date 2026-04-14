import minecraftData from 'minecraft-data';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
const { goals } = pathfinder;

class ActivateBlock extends InstantSkill {
  private mcData: any;
  constructor(bot: CustomBot) {
    super(bot);
    this.mcData = minecraftData(this.bot.version);
    this.skillName = 'activate-block';
    this.description =
      '指定したブロックを右クリック（activate）します。クラフトテーブルを使う、ケーキを食べる、レバーやボタンを押すなどの用途に使用します。';
    this.params = [
      {
        name: 'blockName',
        description: '対象ブロック名（例: crafting_table, cake など）。座標を指定しない場合は最も近いものを探します',
        type: 'string',
        required: true,
      },
      {
        name: 'x',
        description: 'X座標（省略可能）',
        type: 'number',
        required: false,
        default: null,
      },
      {
        name: 'y',
        description: 'Y座標（省略可能）',
        type: 'number',
        required: false,
        default: null,
      },
      {
        name: 'z',
        description: 'Z座標（省略可能）',
        type: 'number',
        required: false,
        default: null,
      },
    ];
  }

  async runImpl(blockName: string, x: number | null = null, y: number | null = null, z: number | null = null) {
    // 座標が指定されている場合はVec3に変換
    const blockPosition = (x !== null && y !== null && z !== null) ? new Vec3(x, y, z) : null;
    let targetBlock: ReturnType<CustomBot['blockAt']> | null = null;
    try {
      if (blockPosition) {
        targetBlock = this.bot.blockAt(blockPosition);
        if (!targetBlock || targetBlock.name !== blockName) {
          return {
            success: false,
            result: `指定座標に${blockName}はありません。`,
          };
        }
      } else {
        // 周囲で最も近いblockNameのブロックを探す
        const blockId = this.mcData.blocksByName[blockName]?.id;
        if (!blockId) {
          return {
            success: false,
            result: `ブロック名 ${blockName} が無効です。`,
          };
        }
        targetBlock = this.bot.findBlock({
          matching: blockId,
          maxDistance: 32,
        });
        if (!targetBlock) {
          return {
            success: false,
            result: `周囲に${blockName}が見つかりません。`,
          };
        }
      }
      // 近づく
      await gotoSafe(this.bot, new goals.GoalNear(
        targetBlock.position.x,
        targetBlock.position.y,
        targetBlock.position.z,
        1,
      ), { timeoutMs: 15_000 });

      await this.bot.activateBlock(targetBlock);
      return { success: true, result: `${blockName}を右クリックしました。` };
    } catch (error: any) {
      if (targetBlock) {
        const los = await ensureLineOfSight(this.bot, targetBlock.position);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
      }
      return {
        success: false,
        result: `activateBlock中にエラー: ${error.message}`,
      };
    }
  }
}

export default ActivateBlock;
