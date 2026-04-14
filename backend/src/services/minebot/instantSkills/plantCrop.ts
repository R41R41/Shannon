import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

/**
 * 原子的スキル: 作物を植える
 */
class PlantCrop extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'plant-crop';
    this.description = '指定座標に作物を植えます。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標',
        required: true,
      },
      {
        name: 'cropName',
        type: 'string',
        description:
          '作物の種類（wheat_seeds, carrot, potato, beetroot_seeds等）',
        required: true,
      },
    ];
  }

  async runImpl(x: number, y: number, z: number, cropName: string) {
    try {
      // パラメータチェック
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }

      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
        };
      }

      // 耕地かチェック
      if (block.name !== 'farmland') {
        return {
          success: false,
          result: `${block.name}は耕地ではありません。farmlandが必要です`,
        };
      }

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 4.5) {
        return {
          success: false,
          result: `耕地が遠すぎます（距離: ${distance.toFixed(
            1
          )}m、4.5m以内に近づいてください）`,
        };
      }

      // 作物の種を持っているかチェック
      const item = this.bot.inventory
        .items()
        .find((item) => item.name.includes(cropName));

      if (!item) {
        return {
          success: false,
          result: `${cropName}を持っていません`,
        };
      }

      // 作物を持つ
      await this.bot.equip(item, 'hand');

      // 耕地の上のブロックを取得（ここに植える）
      const aboveBlock = this.bot.blockAt(pos.offset(0, 1, 0));
      if (aboveBlock && aboveBlock.name !== 'air') {
        return {
          success: false,
          result: `耕地の上に既に${aboveBlock.name}があります`,
        };
      }

      try {
        await this.bot.activateBlock(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }

      return {
        success: true,
        result: `${cropName}を座標(${x}, ${y}, ${z})に植えました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `植付けエラー: ${error.message}`,
      };
    }
  }
}

export default PlantCrop;
