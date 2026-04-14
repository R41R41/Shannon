import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:sleepInBed');

/**
 * 原子的スキル: ベッドで寝る
 */
class SleepInBed extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'sleep-in-bed';
    this.description =
      'ベッドで眠ります。近くにベッドがない場合はインベントリのベッドを設置して眠ります。wakeUpをtrueにするとベッドから起きます。';
    this.params = [
      {
        name: 'wakeUp',
        type: 'boolean',
        description: 'trueの場合、ベッドから起きます。',
        default: false,
      },
      {
        name: 'isTakeBed',
        type: 'boolean',
        description:
          '既に寝ている村人がいた場合にベッドを奪うかどうか。デフォルトはfalse。',
        default: false,
      },
    ];
  }

  // ベッドを設置できる場所を探す
  async findPlaceForBed(): Promise<Vec3 | null> {
    // プレイヤーの近くを探索
    const startPos = this.bot.entity.position.clone();
    const searchRadius = 5;

    for (let x = -searchRadius; x <= searchRadius; x++) {
      for (let z = -searchRadius; z <= searchRadius; z++) {
        for (let y = -1; y <= 1; y++) {
          const pos = startPos.offset(x, y, z).floored();

          // ベッドを設置するには2つの空きブロックと下に固体ブロックが必要
          const blockPos = this.bot.blockAt(pos);
          let blockPosHead = this.bot.blockAt(pos.offset(1, 0, 0));
          const blockBelow = this.bot.blockAt(pos.offset(0, -1, 0));
          let blockBelowHead = this.bot.blockAt(pos.offset(1, -1, 0));

          // 設置場所と頭部位置のブロックが空気で、下のブロックが固体かどうか確認
          if (blockPos && blockPosHead && blockBelow && blockBelowHead) {
            if (
              (blockPos.name === 'air' || blockPos.name === 'cave_air') &&
              (blockPosHead.name === 'air' || blockPosHead.name === 'cave_air') &&
              blockBelow.name !== 'air' &&
              blockBelow.name !== 'cave_air' &&
              blockBelowHead.name !== 'air' &&
              blockBelowHead.name !== 'cave_air'
            ) {
              return pos;
            }
          }

          // 別方向も試す (z方向)
          blockPosHead = this.bot.blockAt(pos.offset(0, 0, 1));
          blockBelowHead = this.bot.blockAt(pos.offset(0, -1, 1));

          if (blockPos && blockPosHead && blockBelow && blockBelowHead) {
            if (
              (blockPos.name === 'air' || blockPos.name === 'cave_air') &&
              (blockPosHead.name === 'air' || blockPosHead.name === 'cave_air') &&
              blockBelow.name !== 'air' &&
              blockBelow.name !== 'cave_air' &&
              blockBelowHead.name !== 'air' &&
              blockBelowHead.name !== 'cave_air'
            ) {
              return pos;
            }
          }
        }
      }
    }
    return null;
  }

  async runImpl(wakeUp?: boolean, isTakeBed?: boolean) {
    try {
      // ベッドから起きる場合
      if (wakeUp) {
        if (this.bot.isSleeping) {
          await this.bot.wake();
          return { success: true, result: 'ベッドから起きました' };
        } else {
          return { success: false, result: '現在寝ていません' };
        }
      }

      // 時間チェック
      const timeOfDay = this.bot.time.timeOfDay;
      // 夜は12542～23459
      if (timeOfDay < 12542 || timeOfDay > 23459) {
        return {
          success: false,
          result: '夜または嵐の時にしか寝られません（現在の時間: ' + timeOfDay + '）',
        };
      }

      // 敵が近くにいないかチェック
      const nearbyMobs = Object.values(this.bot.entities).filter((entity) => {
        if (!entity || !entity.position) return false;
        const dist = entity.position.distanceTo(this.bot.entity.position);
        if (dist > 8) return false;

        const hostileMobs = [
          'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
          'witch', 'slime', 'phantom', 'blaze', 'ghast',
        ];

        const entityName = entity.name?.toLowerCase() || '';
        return hostileMobs.some((mob) => entityName.includes(mob));
      });

      if (nearbyMobs.length > 0) {
        const mob = nearbyMobs[0];
        const dist = mob.position.distanceTo(this.bot.entity.position).toFixed(1);
        return {
          success: false,
          result: `近くに敵がいるため寝られません（${mob.name}が${dist}m先にいます）`,
        };
      }

      // まず近くにベッドがあるか探す
      let bed = this.bot.findBlock({
        matching: this.bot.isABed,
        maxDistance: 16,
      });

      if (bed) {
        // すでにベッドがある場合は、そこに移動して寝る
        try {
          const distance = this.bot.entity.position.distanceTo(bed.position);
          if (distance > 3) {
            this.bot.pathfinder.stop();
            await gotoSafe(this.bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { timeoutMs: 15_000 });
          }

          // ベッドで寝ている村人を探す
          const villagers = Object.values(this.bot.entities).filter(
            (entity) =>
              entity.name === 'villager' &&
              entity.position.distanceTo(bed!.position) < 2
          );
          const sleepingVillager = villagers.find(
            (entity) => Number(entity.metadata[6]) === 2
          );

          if (sleepingVillager && isTakeBed) {
            // ベッドをアクティブにして村人を起こす
            try {
              await this.bot.activateBlock(bed);
            } catch (error: any) {
              log.warn(`村人起こしエラー: ${error.message}`);
            }
            // 村人が起きるまで少し待つ
            await new Promise((resolve) => setTimeout(resolve, 500));
            bed = this.bot.findBlock({
              matching: this.bot.isABed,
              maxDistance: 8,
            });
          } else if (sleepingVillager && !isTakeBed) {
            return {
              success: false,
              result:
                '既に村人が寝ているベッドです。isTakeBedをtrueに設定すると村人を起こしてベッドを奪うことができます。',
            };
          }

          if (!bed) {
            return { success: false, result: 'ベッドが見つかりません' };
          }

          await this.bot.sleep(bed);

          // 起床を待つ
          return new Promise<{ success: boolean; result: string }>((resolve) => {
            const timeout = setTimeout(() => {
              resolve({
                success: true,
                result: '既存のベッドで眠りました',
              });
            }, 10000);

            const onWake = () => {
              clearTimeout(timeout);
              this.bot.removeListener('wake', onWake);
              resolve({
                success: true,
                result: '既存のベッドで眠り、朝になりました',
              });
            };

            this.bot.once('wake', onWake);
          });
        } catch (error: any) {
          // エラーを詳細化して返す
          let errorDetail = error.message;
          if (error.message.includes('too far')) {
            errorDetail = 'ベッドが遠すぎます';
          } else if (error.message.includes('monsters')) {
            errorDetail = '近くに敵がいます';
          } else if (error.message.includes('occupied')) {
            errorDetail = 'ベッドは使用中です';
          }
          return {
            success: false,
            result: `ベッドで眠ることができませんでした: ${errorDetail}`,
          };
        }
      }

      // インベントリにベッドがあるか確認
      const bedItem = this.bot.inventory
        .items()
        .find((i) => i.name.includes('bed'));

      if (!bedItem) {
        return {
          success: false,
          result:
            'インベントリにベッドがなく、周囲にもベッドが見つかりませんでした',
        };
      }

      // ベッドを設置できる場所を探す
      const placePos = await this.findPlaceForBed();
      if (!placePos) {
        return {
          success: false,
          result: 'ベッドを設置できる適切な場所が見つかりませんでした',
        };
      }

      // 設置場所に移動
      const distToPlace = this.bot.entity.position.distanceTo(placePos);
      if (distToPlace > 3) {
        this.bot.pathfinder.stop();
        await gotoSafe(this.bot, new goals.GoalNear(placePos.x, placePos.y, placePos.z, 2), { timeoutMs: 15_000 });
      }

      // ベッドを手に持つ
      await this.bot.equip(bedItem, 'hand');

      // 設置場所の下のブロックを参照ブロックとして使用
      const referenceBlock = this.bot.blockAt(placePos.offset(0, -1, 0));
      if (!referenceBlock) {
        return {
          success: false,
          result: 'ベッドを設置するための参照ブロックが見つかりませんでした',
        };
      }

      // ベッドを設置
      await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 設置したベッドを探す
      const placedBed = this.bot.findBlock({
        matching: this.bot.isABed,
        maxDistance: 3,
      });

      if (!placedBed) {
        return { success: false, result: 'ベッドの設置に失敗しました' };
      }

      // ベッドで寝る
      await this.bot.sleep(placedBed);

      // 起床を待つ
      return new Promise<{ success: boolean; result: string }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({
            success: true,
            result: 'ベッドを設置して眠りました',
          });
        }, 10000);

        const onWake = () => {
          clearTimeout(timeout);
          this.bot.removeListener('wake', onWake);
          resolve({
            success: true,
            result: 'ベッドを設置して眠り、朝になりました',
          });
        };

        this.bot.once('wake', onWake);
      });
    } catch (error: any) {
      return { success: false, result: `${error.message}` };
    }
  }
}

export default SleepInBed;
