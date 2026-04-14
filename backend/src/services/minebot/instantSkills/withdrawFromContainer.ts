import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import {
  countItemInInventory,
  hasNearbyDroppedItemNamed,
  inventoryNoEmptySlots,
  INVENTORY_FULL_RECOVERY_HINT_JA,
} from '../utils/inventorySpillDetection.js';

/**
 * 原子的スキル: コンテナからアイテムを取り出す
 */
class WithdrawFromContainer extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'withdraw-from-container';
    this.description = 'コンテナからアイテムを取り出します。先にコンテナの中身を確認してください（check-container）。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'コンテナのX座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'コンテナのY座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'コンテナのZ座標',
        required: true,
      },
      {
        name: 'itemName',
        type: 'string',
        description: '取り出すアイテム名',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '取り出す個数（nullの場合は全部）',
        default: null,
      },
    ];
  }

  async runImpl(
    x: number,
    y: number,
    z: number,
    itemName: string,
    count: number | null = null
  ) {
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

      // かまど系ブロックの場合は専用ツールへ誘導
      if (block.name.includes('furnace') || block.name === 'smoker' || block.name === 'blast_furnace') {
        return {
          success: false,
          result: `${block.name}はコンテナではなくかまどです。withdraw-from-furnace ツールを使用してください（座標: x=${x}, y=${y}, z=${z}）`,
          failureType: 'wrong_tool',
          recoverable: true,
        };
      }

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 4.5) {
        return {
          success: false,
          result: `コンテナが遠すぎます（距離: ${distance.toFixed(
            1
          )}m、4.5m以内に近づいてください）`,
        };
      }

      let container;
      try {
        container = await this.bot.openContainer(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }
      if (!container) {
        return {
          success: false,
          result: `${block.name}を開けませんでした`,
        };
      }

      try {
        // コンテナ内のアイテムを探す
        const containerItems = container.containerItems();
        const targetItems = containerItems.filter(
          (item) => item.name === itemName
        );

        if (targetItems.length === 0) {
          container.close();
          return {
            success: false,
            result: `${block.name}内に${itemName}がありません`,
          };
        }

        const totalCount = targetItems.reduce(
          (sum, item) => sum + item.count,
          0
        );
        const withdrawCount =
          count !== null ? Math.min(count, totalCount) : totalCount;

        const beforeInv = countItemInInventory(this.bot, itemName);

        // アイテムを取り出す
        let remaining = withdrawCount;
        for (const item of targetItems) {
          if (remaining <= 0) break;
          const withdrawAmount = Math.min(item.count, remaining);
          await container.withdraw(item.type, null, withdrawAmount);
          remaining -= withdrawAmount;
        }

        container.close();

        await new Promise(r => setTimeout(r, 450));
        let gained = countItemInInventory(this.bot, itemName) - beforeInv;
        if (gained < withdrawCount) {
          await new Promise(r => setTimeout(r, 350));
          gained = countItemInInventory(this.bot, itemName) - beforeInv;
        }

        if (gained >= withdrawCount) {
          return {
            success: true,
            result: `${itemName}を${withdrawCount}個${block.name}から取り出しました`,
          };
        }

        if (
          hasNearbyDroppedItemNamed(this.bot, this.mcData, itemName, 10) &&
          inventoryNoEmptySlots(this.bot)
        ) {
          return {
            success: true,
            failureType: 'inventory_full',
            recoverable: true,
            result:
              `${itemName}をインベントリに${gained}個しか収められませんでした（要求${withdrawCount}個）。満杯で残りが地上に落ちた可能性があります。${INVENTORY_FULL_RECOVERY_HINT_JA}`,
          };
        }

        return {
          success: false,
          recoverable: true,
          result:
            `${itemName}を${gained}個のみ取り出せました（要求${withdrawCount}個）。pickup-nearest-itemを試すか、インベントリを整理してください。`,
        };
      } catch (error: any) {
        container.close();
        throw error;
      }
    } catch (error: any) {
      // エラーメッセージを詳細化
      let errorDetail = error.message;
      if (error.message.includes('full')) {
        errorDetail = 'インベントリが満杯です';
      } else if (error.message.includes('withdraw')) {
        errorDetail = 'アイテムを取り出せませんでした';
      }

      return {
        success: false,
        result: `取り出しエラー: ${errorDetail}`,
        ...(error.message.includes('full') || errorDetail.includes('満杯')
          ? { failureType: 'inventory_full' as const, recoverable: true }
          : {}),
      };
    }
  }
}

export default WithdrawFromContainer;
