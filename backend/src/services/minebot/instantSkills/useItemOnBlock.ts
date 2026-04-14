import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { getWaterLevel } from '../utils/waterLevel.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Skill:useItemOnBlock');

/**
 * 原子的スキル: 指定座標のブロックにアイテムを使用（右クリック）
 *
 * water_bucket + lava → マグマ隣の固体ブロックに水を設置し水流で黒曜石を生成。
 */
class UseItemOnBlock extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-item-on-block';
    this.description =
      '手に持っているアイテムを指定ブロックに対して使用します（右クリック）。'
      + '⚠️ 黒曜石を作るには water_bucket を持って lava ブロックの座標を指定してください。'
      + 'スキル側が自動的にマグマ隣の固体ブロックに水を設置し、水流でマグマを黒曜石に変換します。';
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
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }

      const heldItem = this.bot.heldItem;
      if (!heldItem) {
        return {
          success: false,
          result: '手に何も持っていません',
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

      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 5) {
        return {
          success: false,
          result: `ブロックが遠すぎます（距離: ${distance.toFixed(1)}m、5m以内に近づいてください）`,
        };
      }

      // ── water_bucket × lava → 自動リダイレクトで黒曜石生成 ──
      if (heldItem.name === 'water_bucket' && block.name === 'lava') {
        return await this.placeWaterNearLava(pos);
      }

      // ── bucket × liquid: 水源/溶岩源 level=0 チェック ──
      if (heldItem.name === 'bucket') {
        if (block.name === 'water' || block.name === 'lava') {
          const level = getWaterLevel(block);
          if (level > 0) {
            const typeName = block.name === 'water' ? '水流' : '溶岩流';
            return {
              success: false,
              result: `このブロックは${typeName}です（level=${level}）。バケツで汲めるのは水源/溶岩源（level=0）のみです。find-blocksで水源ブロックを探してください`,
            };
          }
        }
      }

      const itemBefore = heldItem.name;

      try {
        await this.bot.lookAt(pos.offset(0.5, 0.5, 0.5));
        await this.bot.activateBlock(block);
      } catch (actionError: any) {
        // 失敗 → LOS遮蔽が原因かを診断
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        return { success: false, result: `使用エラー: ${actionError.message}` };
      }

      // バケツで液体/粉雪を汲む操作の検証: 手持ちが実際に変化したか確認
      if (itemBefore === 'bucket' && (block.name === 'water' || block.name === 'lava' || block.name === 'powder_snow')) {
        await new Promise(r => setTimeout(r, 150));
        const itemAfter = this.bot.heldItem?.name;
        const expected = block.name === 'water' ? 'water_bucket'
          : block.name === 'lava' ? 'lava_bucket'
          : 'powder_snow_bucket';
        if (itemAfter !== expected) {
          const blockAfter = this.bot.blockAt(pos);
          const stillThere = blockAfter && blockAfter.name === block.name;
          return {
            success: false,
            result: `${block.name}にバケツを使いましたが汲めませんでした（手持ち: ${itemAfter ?? 'なし'}）。`
              + (stillThere ? `${block.name}はまだ存在しています。` : '')
              + `原因: 距離が遠い・角度が悪い・遮蔽物がある可能性。move-toで近づいてから再試行してください。`,
          };
        }
        return {
          success: true,
          result: `${expected}を入手しました（${block.name}を(${x},${y},${z})から回収）`,
        };
      }

      return {
        success: true,
        result: `${itemBefore}を${block.name}に使用しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `使用エラー: ${error.message}`,
      };
    }
  }

  /**
   * マグマ隣の固体ブロックに水を設置して水流で黒曜石を生成する。
   * マグマに直接水バケツを使うのではなく、水流がマグマに当たるように設置する。
   */
  private async placeWaterNearLava(lavaPos: Vec3) {
    const placement = this.findWaterPlacementForLava(lavaPos);
    if (!placement) {
      return {
        success: false,
        result: `マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})の隣に水を設置できる固体ブロックがありません。`
          + `マグマの端（固体ブロックが隣接する場所）に近づいてから再試行してください。`,
      };
    }

    const { refBlock, faceVec } = placement;
    const waterPos = refBlock.position.plus(faceVec);

    const losTarget = refBlock.position;
    const dist = this.bot.entity.position.distanceTo(losTarget);
    if (dist > 5) {
      return {
        success: false,
        result: `水の設置先(${losTarget.x},${losTarget.y},${losTarget.z})が遠すぎます（${dist.toFixed(1)}m）。近づいてください。`,
      };
    }

    log.info(`💧 マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})に対し ${refBlock.name}(${losTarget.x},${losTarget.y},${losTarget.z}) の面(${faceVec.x},${faceVec.y},${faceVec.z})に水を設置`);

    try {
      await this.bot.lookAt(losTarget.offset(0.5, 0.5, 0.5));
      await this.bot.placeBlock(refBlock, faceVec);
    } catch (placeError: any) {
      const los = await ensureLineOfSight(this.bot, losTarget);
      if (!los.clear) {
        const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
        return { success: false, result: los.message!, failureType: failType, recoverable: true };
      }
      return { success: false, result: `水の設置エラー: ${placeError.message}` };
    }

    // 水流がマグマに到達するまで少し待つ
    await new Promise(r => setTimeout(r, 500));

    const afterBlock = this.bot.blockAt(lavaPos);
    const converted = afterBlock && afterBlock.name === 'obsidian';

    return {
      success: true,
      result: converted
        ? `✅ マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})が黒曜石に変換されました！`
          + `水源(${waterPos.x},${waterPos.y},${waterPos.z})を空バケツで回収してから、diamond_pickaxeで黒曜石を採掘してください。`
        : `💧 水を(${waterPos.x},${waterPos.y},${waterPos.z})に設置しました。`
          + `水流がマグマに向かって流れています。近くのマグマが黒曜石になっている可能性があります。`
          + `水源を空バケツで回収してから、diamond_pickaxeでobsidianを採掘してください。`,
    };
  }

  /**
   * マグマの隣の固体ブロックを探し、水を設置するのに最適な面を返す。
   *
   * 優先順位:
   *  1. マグマと同じY、隣の固体ブロックの上にairがある → 上面に水設置（水が横に流れてマグマへ）
   *  2. マグマの上にairがある → その空間の隣の固体ブロックの面に水設置（水が下に流れてマグマへ）
   *  3. マグマの下の固体ブロック → 上面に水設置（水がマグマ位置に出現）
   */
  private findWaterPlacementForLava(lavaPos: Vec3): { refBlock: any; faceVec: Vec3 } | null {
    const horizontals = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];

    // Strategy 1: 同じY高さの隣接固体ブロック（上がair）の上面に水設置
    for (const off of horizontals) {
      const edgePos = lavaPos.plus(off);
      const edge = this.bot.blockAt(edgePos);
      if (!edge || edge.boundingBox !== 'block' || edge.name === 'lava') continue;

      const aboveEdge = this.bot.blockAt(edgePos.offset(0, 1, 0));
      if (aboveEdge && (aboveEdge.name === 'air' || aboveEdge.name === 'cave_air')) {
        return { refBlock: edge, faceVec: new Vec3(0, 1, 0) };
      }
    }

    // Strategy 2: マグマの上がair → そのairの隣の固体ブロックの面に水設置
    const aboveLava = this.bot.blockAt(lavaPos.offset(0, 1, 0));
    if (aboveLava && (aboveLava.name === 'air' || aboveLava.name === 'cave_air')) {
      for (const off of horizontals) {
        const adjPos = lavaPos.offset(off.x, 1, off.z);
        const adj = this.bot.blockAt(adjPos);
        if (!adj || adj.boundingBox !== 'block') continue;

        const faceVec = new Vec3(-off.x, 0, -off.z);
        return { refBlock: adj, faceVec };
      }
    }

    // Strategy 3: マグマ直下の固体ブロックの上面に水設置
    const below = this.bot.blockAt(lavaPos.offset(0, -1, 0));
    if (below && below.boundingBox === 'block' && below.name !== 'lava') {
      return { refBlock: below, faceVec: new Vec3(0, 1, 0) };
    }

    return null;
  }
}

export default UseItemOnBlock;
