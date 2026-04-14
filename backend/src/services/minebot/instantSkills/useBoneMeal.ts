import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

/**
 * 原子的スキル: 骨粉を使う
 */
class UseBoneMeal extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-bone-meal';
    this.description = '指定座標の作物や苗木に骨粉を使用して成長を促進します。';
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
    ];
  }

  async runImpl(x: number, y: number, z: number) {
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

      // 骨粉を持っているかチェック
      const boneMeal = this.bot.inventory
        .items()
        .find((item) => item.name === 'bone_meal');

      if (!boneMeal) {
        return {
          success: false,
          result: '骨粉を持っていません',
        };
      }

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 4.5) {
        return {
          success: false,
          result: `対象が遠すぎます（距離: ${distance.toFixed(
            1
          )}m、4.5m以内に近づいてください）`,
        };
      }

      // 骨粉を使えるブロックかチェック
      const bonemealable = [
        'wheat',
        'carrots',
        'potatoes',
        'beetroots',
        'sapling',
        'oak_sapling',
        'spruce_sapling',
        'birch_sapling',
        'jungle_sapling',
        'acacia_sapling',
        'dark_oak_sapling',
        'bamboo',
        'sweet_berry_bush',
        'moss_block',
        'grass_block',
      ];

      const canUseBoneMeal = bonemealable.some((name) =>
        block.name.includes(name)
      );

      if (!canUseBoneMeal) {
        return {
          success: false,
          result: `${block.name}には骨粉を使用できません`,
        };
      }

      await this.bot.equip(boneMeal, 'hand');
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
        result: `${block.name}に骨粉を使用しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `骨粉使用エラー: ${error.message}`,
      };
    }
  }
}

export default UseBoneMeal;
