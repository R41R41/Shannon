import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';
import { BED_EXPLODES, bedExplodesHere, isBedName } from '../utils/bedRules.js';
import { planBedSpot, walkableCells } from '../utils/bedSpot.js';
import { hostileNear, PICKUP_SAFE_RANGE } from './craftOne.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:sleepInBed');

/** Blocks a placed block takes the place of (a bed can be set down on grass, not only in air). */
export const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'leaf_litter', 'snow', 'vine', 'glow_lichen', 'seagrass']);
/** The wider bed search: its radius, and the steps of walk a spot may be from the body (run 21). */
const BED_WIDE_RADIUS = 8;
const BED_WALK_STEPS = 10;
/** Blocks put into a hole in the floor under a bed, in the order used (rock the body has to spare). */
const BED_FILLERS = ['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'dirt', 'stone', 'deepslate', 'netherrack'];
export const isFreeCell =(block: { name?: string } | null | undefined) => !!block && REPLACEABLE.has(String(block.name));
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
  findPlaceForBed(radius: number = 3, reach: number = 4, walk?: Map<string, number>, levels: number[] = [0, -1, 1]): Vec3 | null {
    const at = this.bot.entity.position;
    const feet = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
    const body = bodyCells(at);
    const spots: Array<{ pos: Vec3; distance: number }> = [];
    // With `walk` (cells the body can reach in a few steps) a spot counts only when one of them is beside it.
    const walkable = (pos: Vec3) => !walk || [...walk.keys()].some(key => {
      const [wx, wy, wz] = key.split(',').map(Number);
      return Math.abs(wx - pos.x) <= 2 && Math.abs(wz - pos.z) <= 2 && Math.abs(wy - pos.y) <= 2;
    });
    for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) for (const y of levels) {
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
      if (distance <= reach && walkable(pos)) spots.push({ pos, distance });
    }
    spots.sort((a, b) => a.distance - b.distance);
    return spots[0]?.pos ?? null;
  }

  /**
   * The same search over eight blocks round, for a spot the body can walk to in BED_WALK_STEPS steps or fewer (a cheap walk over standable
   * cells, not the path planner). Run 21 found nothing in a rock passage's three blocks while a wider cave was a few steps off.
   */
  findWiderPlaceForBed(): Vec3 | null {
    let walk: Map<string, number>;
    try { walk = walkableCells(this.bot as any, this.bot.entity.position, BED_WALK_STEPS); } catch { return null; }
    // Up and down a few levels too: a cave below a stair is a short walk.
    return this.findPlaceForBed(BED_WIDE_RADIUS, Infinity, walk, [0, -1, 1, -2, 2, -3, 3, -4]);
  }

  /** The foot cell and head cell of a spot being made, so the body faces the way the bed is to lie when it places it. */
  private plannedHead: Vec3 | null = null;

  /**
   * Makes a spot where there is none: rock cells over and in the bed's two cells are dug out and a hole in the floor is filled (utils/bedSpot
   * plans it, nearest and cheapest first). Returns the foot cell, or why not. Dangerous cells are never touched (liquid or fire beside a
   * cell to dig, goods and workstations, obsidian); a dig that is refused ends it with what was refused.
   */
  private async prepareBedSpot(): Promise<{ pos: Vec3 } | { failure: string; failureType: string }> {
    const items = this.bot.inventory.items();
    const hasPickaxe = items.some(item => item.name.endsWith('_pickaxe'));
    const fillers = items.filter(item => BED_FILLERS.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    const plan = planBedSpot(this.bot as any, this.bot.entity.position, { isFree: isFreeCell, hasPickaxe, fillers, body: bodyCells(this.bot.entity.position) });
    if (!plan) {
      return { failureType: 'no_bed_spot', failure: 'ベッドを設置できる適切な場所が見つかりませんでした（周囲8マスの歩ける所を探し、岩を掘って2×1の床を作る方法も試しましたが、'
        + `掘れる安全な場所がありません。${hasPickaxe ? '' : 'ツルハシを持っていません。'}${fillers > 0 ? '' : '床の穴を埋める石も持っていません。'}溶岩・水・設備のそばは掘りません）。開けた所へ移動してからもう一度試してください` };
    }
    for (const cell of plan.dig) {
      let dug: { success?: boolean; result?: unknown } = { success: false };
      try { dug = await this.callSkill('dig-block-at', cell.x, cell.y, cell.z, false); } catch (error) { if (this.shouldInterrupt()) throw error; }
      if (!dug.success) {
        return { failureType: 'bed_spot_prepare_failed', failure: `ベッドを置く場所を作ろうとして(${cell.x}, ${cell.y}, ${cell.z})を掘りましたが掘れませんでした（${String(dug.result ?? '').slice(0, 100)}）` };
      }
    }
    for (const cell of plan.fill) {
      const filler = this.bot.inventory.items().find(item => BED_FILLERS.includes(item.name));
      let placed: { success?: boolean; result?: unknown } = { success: false };
      if (filler) { try { placed = await this.callSkill('place-block-at', filler.name, cell.x, cell.y, cell.z); } catch (error) { if (this.shouldInterrupt()) throw error; } }
      if (!placed.success) {
        return { failureType: 'bed_spot_prepare_failed', failure: `ベッドの床になる穴(${cell.x}, ${cell.y}, ${cell.z})を埋められませんでした（${String(placed.result ?? '床を埋める石がありません').slice(0, 100)}）` };
      }
    }
    // What stands there now has to be what the plan wanted: two free cells with a floor under, and the air over them.
    const free = (cell: Vec3) => isFreeCell(this.bot.blockAt(cell));
    const floor = (cell: Vec3) => this.bot.blockAt(cell.offset(0, -1, 0))?.boundingBox === 'block';
    if (![plan.pos, plan.head].every(cell => free(cell) && floor(cell) && free(cell.offset(0, 1, 0)))) {
      return { failureType: 'bed_spot_prepare_failed', failure: `ベッドを置く場所(${plan.pos.x}, ${plan.pos.y}, ${plan.pos.z})を掘って整えましたが、まだ2×1の床になっていません` };
    }
    this.plannedHead = plan.head;
    log.info(`ベッドの置き場所を作りました: 掘る${plan.dig.length}・床を埋める${plan.fill.length}（${plan.pos.x}, ${plan.pos.y}, ${plan.pos.z}）`);
    return { pos: plan.pos };
  }

  /** The nearest hostile mob within eight blocks, if any. */
  private hostileWithinEight(): { name?: string; distance: number } | null {
    const hostileMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'phantom', 'blaze', 'ghast'];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.position) continue;
      const distance = entity.position.distanceTo(this.bot.entity.position);
      if (distance > 8) continue;
      const entityName = entity.name?.toLowerCase() || '';
      if (hostileMobs.some(mob => entityName.includes(mob))) return { name: entity.name, distance };
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
      this.plannedHead = null;
      let placePos = this.findPlaceForBed();
      // Nothing within three blocks (run 21: a rock passage one block wide): a spot a few steps' walk off, then one made by digging.
      if (!placePos) placePos = this.findWiderPlaceForBed();
      if (!placePos) {
        const prepared = await this.prepareBedSpot();
        if ('failure' in prepared) return { success: false, result: prepared.failure, failureType: prepared.failureType, recoverable: true };
        // The digging took a while: a mob that came meanwhile is still a reason not to lie down.
        const mob = this.hostileWithinEight();
        if (mob) return { success: false, result: `ベッドを置く場所を作りましたが、近くに敵がいるため寝られません（${mob.name}が${mob.distance.toFixed(1)}m先にいます）`, failureType: 'hostile_near', recoverable: true };
        placePos = prepared.pos;
      }

      // 設置場所に移動
      const distToPlace = this.bot.entity.position.distanceTo(placePos);
      if (distToPlace > 3) {
        this.bot.pathfinder.stop();
        await gotoSafe(this.bot, new goals.GoalNear(placePos.x, placePos.y, placePos.z, 2), { timeoutMs: 15_000 });
        // From where it stands now the bed would lie another way (its head is away from the body): the spot is read again.
        // (A spot that was just made is kept: the cells were cleared for it.)
        if (!this.plannedHead) placePos = this.findPlaceForBed() ?? placePos;
      }

      // ベッドを手に持つ
      await this.bot.equip(bedItem, 'hand');
      // A spot that was made lies along the cells that were cleared: the body faces the head cell, so the bed is laid that way.
      const plannedHead = this.plannedHead as Vec3 | null;
      if (plannedHead && typeof this.bot.lookAt === 'function') {
        try { await this.bot.lookAt(plannedHead.offset(0.5, 0.5, 0.5), true); } catch { /* placed as the body stands */ }
      }

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
