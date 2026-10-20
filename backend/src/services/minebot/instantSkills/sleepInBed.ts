import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';
import { BED_EXPLODES, bedExplodesHere, isBedName } from '../utils/bedRules.js';
import { hostileNear, PICKUP_SAFE_RANGE } from './craftOne.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:sleepInBed');

/** Blocks a placed block takes the place of (a bed can be set down on grass, not only in air). */
export const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'leaf_litter', 'snow', 'vine', 'glow_lichen', 'seagrass']);
export const isFreeCell = (block: { name?: string } | null | undefined) => !!block && REPLACEABLE.has(String(block.name));
/** The cells the body's box (0.6 wide, 1.8 high) is in: a block placed there is refused by the server. */
export function bodyCells(at: { x: number; y: number; z: number }): Vec3[] {
  const cells: Vec3[] = [];
  for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) for (const dy of [0, 1, 1.79]) {
    const cell = new Vec3(Math.floor(at.x + dx), Math.floor(at.y + dy), Math.floor(at.z + dz));
    if (!cells.some(other => other.equals(cell))) cells.push(cell);
  }
  return cells;
}

/**
 * 原子的スキル: ベッドで寝る
 */
class SleepInBed extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'sleep-in-bed';
    this.description =
      'ベッドで眠ります（夜か雷雨の時だけ。ネザー・エンドでは爆発するので拒みます）。近くにベッドがない場合はインベントリのベッドを設置して眠ります。wakeUpをtrueにするとベッドから起きます。';
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

  /**
   * Where a bed can be set down near the body: the foot cell and the head cell beyond it (the bed lies the way the body faces when it
   * places it, so the head is the cell past the foot, away from the body), both free (air, or grass and the like that a placed block
   * replaces) and on solid ground, neither in a cell the body itself fills. Nearest first, within reach. Run 17 failed three times
   * with "something may be standing in that cell" (its own body) and once on a grass cell (D54).
   */
  findPlaceForBed(): Vec3 | null {
    const at = this.bot.entity.position;
    const feet = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
    const body = bodyCells(at);
    const spots: Array<{ pos: Vec3; distance: number }> = [];
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [0, -1, 1]) {
      const pos = feet.offset(x, y, z);
      const dx = pos.x - feet.x, dz = pos.z - feet.z;
      if (!dx && !dz) continue;
      const dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
      const head = pos.plus(dir);
      if ([pos, head].some(cell => body.some(b => b.equals(cell)))) continue;
      const free = (cell: Vec3) => isFreeCell(this.bot.blockAt(cell));
      const floor = (cell: Vec3) => this.bot.blockAt(cell.offset(0, -1, 0))?.boundingBox === 'block';
      if (!free(pos) || !free(head) || !floor(pos) || !floor(head)) continue;
      const distance = pos.offset(0.5, 0.5, 0.5).distanceTo(at.offset(0, 1.62, 0));
      if (distance <= 4) spots.push({ pos, distance });
    }
    spots.sort((a, b) => a.distance - b.distance);
    return spots[0]?.pos ?? null;
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

      // A bed placed or used in the Nether or the End explodes.
      if (bedExplodesHere(this.bot)) return { success: false, result: BED_EXPLODES, failureType: 'bed_explodes', recoverable: true };

      // 時間チェック
      const timeOfDay = this.bot.time.timeOfDay;
      // 夜は12542～23459（雷雨の時は昼でも眠れる）
      // The library's own test for a storm (bed.js): rain with thunder.
      if ((timeOfDay < 12542 || timeOfDay > 23459) && !((this.bot as any).isRaining && (this.bot as any).thunderState > 0)) {
        return {
          success: false,
          result: '夜または雷雨の時にしか寝られません（現在の時間: ' + timeOfDay + '）。'
            + 'リスポーン地点を決めるだけなら、昼でも activate-block（blockName: bed）でベッドを右クリックすれば決まります',
          failureType: 'not_night', recoverable: true,
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
            await actionDelay(this.bot, 500);
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
        .find((i) => isBedName(i.name));

      if (!bedItem) {
        return {
          success: false,
          result:
            'インベントリにベッドがなく、周囲にもベッドが見つかりませんでした',
        };
      }

      // ベッドを設置できる場所を探す
      let placePos = this.findPlaceForBed();
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
        // From where it stands now the bed would lie another way (its head is away from the body): the spot is read again.
        placePos = this.findPlaceForBed() ?? placePos;
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
      await actionDelay(this.bot, 500);

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
      const slept = await new Promise<{ success: boolean; result: string; woke: boolean }>((resolve) => {
        const timeout = setTimeout(() => {
          this.bot.removeListener('wake', onWake);
          resolve({ success: true, result: 'ベッドを設置して眠りました', woke: false });
        }, 10000);

        const onWake = () => {
          clearTimeout(timeout);
          this.bot.removeListener('wake', onWake);
          resolve({ success: true, result: 'ベッドを設置して眠り、朝になりました', woke: true });
        };

        this.bot.once('wake', onWake);
      });
      // Woken: the bed this call set down goes back into the pack (run 17 left its only bed where it slept and came to the next
      // night without one). Not while still asleep: that would wake the body.
      const at = placedBed.position;
      if (!slept.woke || this.bot.isSleeping) return { success: slept.success, result: `${slept.result}。置いたベッドは(${at.x}, ${at.y}, ${at.z})にあります（起きたら dig-block-at takeEquipment=true で拾えます）` };
      if (hostileNear(this.bot as any, PICKUP_SAFE_RANGE)) {
        return { success: true, result: `${slept.result}。敵が近いので、ベッド(${at.x}, ${at.y}, ${at.z})はそのままにしました（後で dig-block-at takeEquipment=true で拾えます）` };
      }
      let taken: { success: boolean; result: string };
      try { taken = await this.callSkill('dig-block-at', at.x, at.y, at.z, true, 'target', true); }
      catch (error: any) { taken = { success: false, result: String(error?.message ?? error) }; }
      // Dug but not in the pack (drop_not_collected): it lies there, and digging the spot again finds air.
      const notTaken = (taken as { failureType?: string }).failureType === 'drop_not_collected'
        ? `ベッドは掘りましたが持ち物に入っていません（(${at.x}, ${at.y}, ${at.z}) の近くに落ちていれば pickup-nearest-item で拾えます）`
        : `ベッド(${at.x}, ${at.y}, ${at.z})を拾えませんでした（dig-block-at takeEquipment=true で拾えます）`;
      return { success: true, result: `${slept.result}。${taken.success ? 'ベッドは拾い直しました' : notTaken}` };
    } catch (error: any) {
      return { success: false, result: `${error.message}` };
    }
  }
}

export default SleepInBed;
