import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { getWaterLevel } from '../utils/waterLevel.js';
import { createLogger } from '../../../utils/logger.js';
import { activateItemFacing } from '../utils/activateItemFacing.js';
import { actionDelay } from '../execution/observedWait.js';
import pathfinder from 'mineflayer-pathfinder';
import { gotoSafe } from '../utils/gotoSafe.js';
import { liquidAim, liquidAimPoints } from '../utils/liquidAim.js';

const { goals } = pathfinder;

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
      {
        name: 'itemName',
        type: 'string',
        description: '使うアイテムの正確なID（例: bucket, water_bucket, flint_and_steel）。指定すると使用直前にメインハンドへ装備する。省略時は現在の手持ち',
        required: false,
      },
    ];
  }

  private liquidAim(pos: Vec3): { point?: Vec3; reason?: string } { return liquidAim(this.bot, pos); }

  async runImpl(x: number, y: number, z: number, itemName?: string) {
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }

      if (itemName) {
        const wanted = this.bot.inventory.items().find(item => item.name === itemName);
        if (!wanted && this.bot.heldItem?.name !== itemName) {
          return { success: false, result: `${itemName}を持っていません`, failureType: 'material_missing', recoverable: true };
        }
        if (wanted && this.bot.heldItem?.name !== itemName) await this.bot.equip(wanted, 'hand');
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
        if (!(itemBefore === 'bucket' && (block.name === 'water' || block.name === 'lava'))) await this.bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
        // 液体は衝突判定のないブロックなので activateBlock() のレイキャスト
        // 対象にならない。空バケツは視線方向へ use_item を送り、Minecraft
        // サーバー自身に水源/溶岩源をレイキャストさせる。
        if (itemBefore === 'bucket' && (block.name === 'water' || block.name === 'lava')) {
          // The server takes the liquid its own ray from the eyes finds, within reach. Aimed at the middle of the
          // source from wherever the body stood, the ray met a bank or fell short, and the answer was only "could
          // not scoop: far, a bad angle or something in the way": a planner with a bucket spent seven calls
          // and two pillars on one pool (paid run L74). A point on the source the eyes can see is looked for;
          // with none, the body steps up to the source once.
          let aim = this.liquidAim(pos);
          if (!aim.point) {
            try { await gotoSafe(this.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), { timeoutMs: 8000 }); } catch { /* judged by the aim below */ }
            aim = this.liquidAim(pos);
          }
          if (!aim.point) {
            return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
              result: `${block.name}(${pos.x},${pos.y},${pos.z})にバケツが届きません: ${aim.reason}。その水源の真横か真上に立ってからやり直してください` };
          }
          await activateItemFacing(this.bot, aim.point);
        } else {
          await this.bot.activateBlock(block);
        }
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
        const expected = block.name === 'water' ? 'water_bucket'
          : block.name === 'lava' ? 'lava_bucket'
          : 'powder_snow_bucket';
        // The held-item update can arrive after several ticks.
        const heldDeadline = Date.now() + 1500;
        while (Date.now() < heldDeadline && this.bot.heldItem?.name !== expected) await actionDelay(this.bot, 100);
        const itemAfter = this.bot.heldItem?.name;
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
      // A bucket is an item use resolved by the server's own ray cast, not a
      // block placement: placeBlock sends only use_item_on and never pours.
      const faceCenter = refBlock.position.offset(0.5, 0.5, 0.5).plus(faceVec.scaled(0.5));
      await activateItemFacing(this.bot, faceCenter);
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && this.bot.blockAt(waterPos)?.name !== 'water') await actionDelay(this.bot, 100);
      if (this.bot.blockAt(waterPos)?.name !== 'water') {
        return {
          success: false,
          result: `水バケツを(${waterPos.x},${waterPos.y},${waterPos.z})へ使いましたが水が置かれていません（手持ち: ${this.bot.heldItem?.name ?? 'なし'}）。`
            + '設置面が見える位置へ近づき、別の縁から再試行してください。',
          failureType: 'placement_unconfirmed',
          recoverable: true,
        };
      }
    } catch (placeError: any) {
      // Cancellation is not a line-of-sight failure: never dig obstructions after it.
      if (this.shouldInterrupt()) throw placeError;
      const los = await ensureLineOfSight(this.bot, losTarget);
      if (!los.clear) {
        const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
        return { success: false, result: los.message!, failureType: failType, recoverable: true };
      }
      return { success: false, result: `水の設置エラー: ${placeError.message}` };
    }

    // 水流がマグマに到達するまで待つ（流水は数tickずつ広がる）。長く待つと
    // Bot自身が流されて水源に届かなくなるため、1.5秒で打ち切る。
    const convertDeadline = Date.now() + 1500;
    while (Date.now() < convertDeadline && this.bot.blockAt(lavaPos)?.name !== 'obsidian') await actionDelay(this.bot, 100);
    // Scoop the source back at once, as a player does: a flooded pit slows
    // obsidian mining about fivefold and pushes the bot out of reach.
    let recovered = false;
    if (this.bot.heldItem?.name === 'bucket' && this.bot.blockAt(waterPos)?.name === 'water') {
      // Read afresh each tick: the held item changes from a server packet.
      const heldName = (): string | undefined => this.bot.heldItem?.name;
      // Each point of the source the eyes can see, in turn: the centre can lie behind the edge of a block
      // the line to it clips (paid run L77 left its water standing and lost it).
      const visible = liquidAimPoints(this.bot, waterPos).points;
      for (const point of visible.length ? visible.slice(0, 4) : [waterPos.offset(0.5, 0.5, 0.5)]) {
        try {
          await activateItemFacing(this.bot, point);
          const scoopDeadline = Date.now() + 800;
          while (Date.now() < scoopDeadline && heldName() !== 'water_bucket') await actionDelay(this.bot, 100);
        } catch { /* reported below */ }
        if (heldName() === 'water_bucket') { recovered = true; break; }
      }
    }

    const afterBlock = this.bot.blockAt(lavaPos);
    const converted = afterBlock && afterBlock.name === 'obsidian';
    const obsidianNearby = this.bot.findBlocks?.({ matching: (candidate: any) => candidate?.name === 'obsidian',
      point: lavaPos, maxDistance: 8, count: 64 })?.length ?? 0;

    return {
      success: true,
      result: converted
        ? `✅ マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})が黒曜石に変換されました（周囲8m内の黒曜石${obsidianNearby}個）。`
          + (recovered ? '水はwater_bucketへ回収済み。残りの溶岩には別の縁から同様に水を流せます。diamond_pickaxeで黒曜石を採掘できます。'
            : `水源(${waterPos.x},${waterPos.y},${waterPos.z})が残っています。近づいて空バケツで回収してから、diamond_pickaxeで黒曜石を採掘してください（水中の採掘は遅い）。`)
        : `💧 水を(${waterPos.x},${waterPos.y},${waterPos.z})に設置しました。指定したマグマはまだ変換されていません（周囲8m内の黒曜石${obsidianNearby}個）。`
          + (recovered ? '水はwater_bucketへ回収済み。' : '水源が残っています。空バケツで回収してください。')
          + `水流の届かない溶岩源は、隣の縁から別に水を流してください。`
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
