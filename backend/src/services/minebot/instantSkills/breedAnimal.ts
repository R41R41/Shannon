import { CustomBot, InstantSkill } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';

/**
 * 原子的スキル: 動物を繁殖させる
 */
class BreedAnimal extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'breed-animal';
    this.description = '最も近い2匹の動物を繁殖させます。';
    this.params = [
      {
        name: 'animalType',
        type: 'string',
        description: '動物の種類（cow, pig, sheep, chicken等）',
        required: true,
      },
      {
        name: 'foodItem',
        type: 'string',
        description: '繁殖に必要な食べ物（wheat, carrot, seeds等）',
        required: true,
      },
    ];
  }

  async runImpl(animalType: string, foodItem: string) {
    try {
      // 食べ物を持っているかチェック
      const food = this.bot.inventory
        .items()
        .find((item) => item.name === foodItem);

      if (!food || food.count < 2) {
        return {
          success: false,
          result: `${foodItem}が不足しています（2個以上必要、所持: ${
            food?.count || 0
          }個）`,
        };
      }

      // 指定された動物を探す
      const animals = Object.values(this.bot.entities).filter((entity) => {
        if (!entity || !entity.name) return false;
        const distance = entity.position.distanceTo(this.bot.entity.position);
        if (distance > 16) return false;
        return entity.name.toLowerCase().includes(animalType.toLowerCase());
      });

      if (animals.length < 2) {
        return {
          success: false,
          result: `近くに${animalType}が2匹以上見つかりません（発見: ${animals.length}匹）`,
        };
      }

      // 最も近い2匹を選択
      animals.sort((a, b) => {
        const distA = a.position.distanceTo(this.bot.entity.position);
        const distB = b.position.distanceTo(this.bot.entity.position);
        return distA - distB;
      });

      const animal1 = animals[0];
      const animal2 = animals[1];

      // 距離チェック
      const dist1 = animal1.position.distanceTo(this.bot.entity.position);
      const dist2 = animal2.position.distanceTo(this.bot.entity.position);

      if (dist1 > 4.5 || dist2 > 4.5) {
        return {
          success: false,
          result: `動物が遠すぎます（${animalType}1: ${dist1.toFixed(
            1
          )}m、${animalType}2: ${dist2.toFixed(
            1
          )}m、両方とも4.5m以内に近づいてください）`,
        };
      }

      // 食べ物を手に持つ
      await this.bot.equip(food, 'hand');

      // 1匹目に食べ物を与える
      await this.bot.activateEntity(animal1);
      await actionDelay(this.bot, 500);

      // 2匹目に食べ物を与える
      await this.bot.activateEntity(animal2);
      await actionDelay(this.bot, 500);

      return {
        success: true,
        result: `${animalType}を繁殖させました（${foodItem}を使用）`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `繁殖エラー: ${error.message}`,
      };
    }
  }
}

export default BreedAnimal;
