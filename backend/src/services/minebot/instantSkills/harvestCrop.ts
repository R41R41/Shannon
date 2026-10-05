import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { digBlockVerified, ServerDigUnconfirmedError } from '../utils/digBlockVerified.js';

/**
 * 原子的スキル: 作物を収穫する
 */
class HarvestCrop extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'harvest-crop';
    this.description = '指定座標の作物を収穫します。';
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

      // 作物かチェック
      const crops = [
        'wheat',
        'carrots',
        'potatoes',
        'beetroots',
        'nether_wart',
        'cocoa',
        'sweet_berry_bush',
      ];

      const isCrop = crops.some((crop) => block.name.includes(crop));
      if (!isCrop) {
        return {
          success: false,
          result: `${block.name}は作物ではありません`,
        };
      }

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 5) {
        return {
          success: false,
          result: `作物が遠すぎます（距離: ${distance.toFixed(
            1
          )}m、5m以内に近づいてください）`,
        };
      }

      // 成長度チェック（age プロパティ）
      const properties = block.getProperties();
      // Prismarine block states can expose integer properties as strings.
      const rawAge = properties.age;
      const age = rawAge === undefined ? NaN : Number(rawAge);
      // Numeric block IDs change between versions; the registry describes each
      // crop's actual age range (wheat/carrot/potato 7, beetroot 3, cocoa 2).
      const ageState = this.bot.registry.blocksByName[block.name]?.states?.find(state => state.name === 'age');
      const maxAge = ageState ? ageState.num_values - 1 : undefined;

      if (maxAge === undefined || !Number.isInteger(age) || age < 0 || age > maxAge) {
        return { success: false, result: `${block.name}の成長度を確認できません`, failureType: 'crop_age_unknown' };
      }

      if (age !== undefined && typeof age === 'number' && age < maxAge) {
        return {
          success: false,
          result: `${block.name}はまだ成長していません（成長度: ${age}/${maxAge}）`,
          failureType: 'crop_immature',
        };
      }

      try {
        await digBlockVerified(this.bot, block);
      } catch (actionError: any) {
        if (actionError instanceof ServerDigUnconfirmedError) {
          return { success: false, result: actionError.message, failureType: actionError.failureType, recoverable: true };
        }
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }

      return {
        success: true,
        result: `${block.name}を収穫しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `収穫エラー: ${error.message}`,
      };
    }
  }
}

export default HarvestCrop;
