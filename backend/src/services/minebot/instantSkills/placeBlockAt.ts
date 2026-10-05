import { resyncInventory } from '../utils/inventorySync.js';
import minecraftData from 'minecraft-data';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;

/** Cells a block can be placed into, as in vanilla (fluids and non-solid plants are replaced). */
const REPLACEABLE_TARGETS = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column', 'short_grass',
  'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'glow_lichen', 'snow',
  'fire', 'soul_fire', 'light']);

/**
 * 原子的スキル: 指定座標にブロックを設置
 */
class PlaceBlockAt extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'place-block-at';
    this.description = '指定座標にブロックを設置します。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '設置するブロック名（例: crafting_table, stone, cobblestone）※必須',
        required: true,
      },
      {
        name: 'x',
        type: 'number',
        description: 'X座標（整数）',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標（整数）',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標（整数）',
        required: true,
      },
    ];
  }

  /** Too far to place from where the body is now: said without waiting for the body, with where the body is. */
  protected preflight(_blockName: string, x: number, y: number, z: number) {
    const position = this.bot.entity?.position;
    if (!position || ![x, y, z].every(Number.isFinite)) return null;
    const distance = position.distanceTo(new Vec3(x, y, z));
    if (distance <= 5) return null;
    return {
      success: false,
      result: `設置場所が遠すぎます（距離: ${distance.toFixed(1)}m、5m以内に近づいてください。現在位置: ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}）`,
      failureType: 'distance_too_far',
      recoverable: true,
    };
  }

  async runImpl(blockName: string, x: number, y: number, z: number) {
    try {
      // パラメータチェック
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
          failureType: 'invalid_input',
          recoverable: false,
        };
      }

      const blockType = this.mcData.blocksByName[blockName];
      if (!blockType) {
        return {
          success: false,
          result: `ブロック${blockName}が見つかりません`,
          failureType: 'invalid_block',
          recoverable: false,
        };
      }

      const item = this.bot.inventory
        .items()
        .find((item) => item.name === blockName);

      if (!item) {
        return {
          success: false,
          result: `インベントリに${blockName}がありません`,
          failureType: 'missing_item',
          recoverable: true,
        };
      }

      const targetPos = new Vec3(x, y, z);

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(targetPos);
      if (distance > 5) {
        return {
          success: false,
          result: `設置場所が遠すぎます（距離: ${distance.toFixed(
            1
          )}m、5m以内に近づいてください）`,
          failureType: 'distance_too_far',
          recoverable: true,
        };
      }

      // 設置場所がすでにブロックで埋まっているかチェック（水・草など置き換え可能なものは埋まっていない扱い）
      const existingBlock = this.bot.blockAt(targetPos);
      if (existingBlock && !REPLACEABLE_TARGETS.has(existingBlock.name)) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にはすでに${existingBlock.name}があります`,
          failureType: 'target_occupied',
          recoverable: true,
        };
      }

      // ボット自身がいる位置なら自動で退避してから設置
      const botPos = this.bot.entity.position;
      const botBlockX = Math.floor(botPos.x);
      const botBlockY = Math.floor(botPos.y);
      const botBlockZ = Math.floor(botPos.z);

      if (
        x === botBlockX &&
        z === botBlockZ &&
        (y === botBlockY || y === botBlockY + 1)
      ) {
        const moved = await this.stepAside(targetPos);
        if (!moved) {
          return {
            success: false,
            result: `座標(${x}, ${y}, ${z})はボット自身がいる位置で、退避先が見つかりません`,
            failureType: 'invalid_target',
            recoverable: true,
          };
        }
      }

      // 参照ブロックを探す（設置する場所の隣接ブロック）
      // 下→側面（東西南北）→上の順で探す
      const offsets: [number, number, number, number, number, number][] = [
        [0, -1, 0, 0, 1, 0],   // 下のブロック → 上向きに設置
        [1, 0, 0, -1, 0, 0],   // 東のブロック → 西向きに設置
        [-1, 0, 0, 1, 0, 0],   // 西のブロック → 東向きに設置
        [0, 0, 1, 0, 0, -1],   // 南のブロック → 北向きに設置
        [0, 0, -1, 0, 0, 1],   // 北のブロック → 南向きに設置
        [0, 1, 0, 0, -1, 0],   // 上のブロック → 下向きに設置
      ];

      let referenceBlock = null;
      let faceVector = new Vec3(0, 1, 0);

      for (const [ox, oy, oz, fx, fy, fz] of offsets) {
        const candidate = this.bot.blockAt(targetPos.offset(ox, oy, oz));
        // A placement face needs a solid block; water or grass beside the target cannot hold one.
        if (candidate && candidate.boundingBox === 'block') {
          referenceBlock = candidate;
          faceVector = new Vec3(fx, fy, fz);
          break;
        }
      }

      if (!referenceBlock) {
        return {
          success: false,
          result:
            `設置場所の周囲に参照ブロックがありません（空中には設置できません）。` +
            `座標(${x},${y},${z})の上下左右前後にソリッドブロックが必要です。` +
            `対処法: 下のブロック(${x},${y - 1},${z})から順に積み上げて設置するか、隣接する位置に先にブロックを置いてください。`,
          failureType: 'unsupported_target',
          recoverable: true,
        };
      }

      await this.bot.equip(item, 'hand');
      try {
        await this.bot.placeBlock(referenceBlock, faceVector);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, referenceBlock.position);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        // The server placed nothing. One reason is that the body does not hold what its copy of its pack says
        // it holds: a chest "crafted" in that copy only was placed eleven times, each waiting five seconds for a
        // block that never came (paid run L74). The pack is looked at before the failure is reported.
        const hadBefore = this.bot.inventory.items().filter((entry) => entry.name === blockName).reduce((sum, entry) => sum + entry.count, 0);
        let synced = false;
        try { synced = await resyncInventory(this.bot as any); } catch { synced = false; }
        const hasNow = this.bot.inventory.items().filter((entry) => entry.name === blockName).reduce((sum, entry) => sum + entry.count, 0);
        if (synced && hasNow === 0) {
          return { success: false, failureType: 'missing_item', recoverable: true,
            result: `${blockName}は実際には持っていませんでした（所持品をサーバーと照合した結果。写しでは${hadBefore}個）。作り直すか、入手してください` };
        }
        // Something stands in the cell (the body itself, a mob, a dropped block of sand): the server answers nothing.
        if (String(actionError?.message ?? '').includes('did not fire within timeout')) {
          return { success: false, failureType: 'place_failed', recoverable: true,
            result: `${blockName}を(${x}, ${y}, ${z})に置けませんでした: サーバーが設置を受け付けませんでした（${blockName}は${hasNow}個持っています）。`
              + '置き先に身体やMobが重なっているか、支えにしたブロックに届いていません。立ち位置か置き先を変えてください' };
        }
        throw actionError;
      }

      return {
        success: true,
        result: `${blockName}を(${x}, ${y}, ${z})に設置しました`,
      };
    } catch (error: any) {
      // エラーメッセージを詳細化
      let errorDetail = error.message;
      if (error.message.includes('far away')) {
        errorDetail = '設置場所が遠すぎます';
      } else if (error.message.includes('cannot place')) {
        errorDetail = 'ブロックを設置できません（空中、障害物など）';
      } else if (error.message.includes('equipped')) {
        errorDetail = 'アイテムを装備できませんでした';
      }

      return {
        success: false,
        result: `設置エラー: ${errorDetail}`,
        failureType: error.message.includes('far away')
          ? 'distance_too_far'
          : error.message.includes('cannot place')
            ? 'unsupported_target'
            : error.message.includes('equipped')
              ? 'equip_failed'
              : 'place_failed',
        recoverable:
          error.message.includes('far away') ||
          error.message.includes('cannot place') ||
          error.message.includes('equipped'),
      };
    }
  }
  /**
   * 設置対象座標から1ブロック退避する。
   * 隣接4方向で足場があり空気がある安全な場所に移動する。
   */
  private async stepAside(target: Vec3): Promise<boolean> {
    const cardinals = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];
    for (const dir of cardinals) {
      const dest = target.plus(dir);
      const ground = this.bot.blockAt(dest.offset(0, -1, 0));
      const feet = this.bot.blockAt(dest);
      const head = this.bot.blockAt(dest.offset(0, 1, 0));
      if (
        ground && ground.name !== 'air' &&
        feet && feet.name === 'air' &&
        head && head.name === 'air'
      ) {
        try {
          await gotoSafe(this.bot, new goals.GoalNear(dest.x + 0.5, dest.y, dest.z + 0.5, 0.5), {
            timeoutMs: 2000,
            stuckAbortCount: 2,
            logStuck: false,
          });
          await actionDelay(this.bot, 200);

          const newPos = this.bot.entity.position;
          const dx = Math.floor(newPos.x) - Math.floor(target.x);
          const dz = Math.floor(newPos.z) - Math.floor(target.z);
          if (dx !== 0 || dz !== 0) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  }
}

export default PlaceBlockAt;
