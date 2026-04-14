import minecraftData from 'minecraft-data';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { setMovements } from '../utils/setMovements.js';
import { gotoSafe } from '../utils/gotoSafe.js';

const { goals } = pathfinder;
/**
 * 原子的スキル: 最も近いアイテムを拾う
 */
class PickupNearestItem extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'pickup-nearest-item';
    this.description = '最も近い地面のアイテムを拾います。dig-block-atの後に使用してください。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: '拾いたいアイテム名（例: oak_log, cobblestone）。省略時は最も近いアイテム',
        default: null,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '検索範囲（デフォルト: 16ブロック）',
        default: 16,
      },
    ];
  }

  /**
   * エンティティからアイテム名を取得
   */
  private getItemNameFromEntity(entity: any): string | null {
    try {
      // mineflayerのitem entityからアイテム情報を取得
      const metadata = entity.metadata;
      if (!metadata) return null;

      // metadata[8]にアイテム情報が格納されている（バージョンによって異なる場合あり）
      for (let i = 7; i <= 9; i++) {
        const itemData = metadata[i];
        if (itemData && typeof itemData === 'object' && 'itemId' in itemData) {
          const itemId = itemData.itemId;
          const item = this.mcData.items[itemId];
          if (item) {
            return item.name;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async runImpl(itemName: string | null = null, maxDistance: number = 16) {
    try {
      // 拾う前のインベントリを記録
      const beforeInventory = new Map<string, number>();
      for (const item of this.bot.inventory.items()) {
        beforeInventory.set(item.name, (beforeInventory.get(item.name) || 0) + item.count);
      }

      // 地面のアイテムエンティティを探す
      let foundItemName: string | null = null;

      const itemEntity = this.bot.nearestEntity((entity) => {
        // アイテムエンティティかチェック
        if (entity.name !== 'item') return false;

        // 距離チェック
        const distance = entity.position.distanceTo(this.bot.entity.position);
        if (distance > maxDistance) return false;

        // アイテム名を取得
        const entityItemName = this.getItemNameFromEntity(entity);

        // 特定アイテムを指定している場合
        if (itemName) {
          if (entityItemName && entityItemName.includes(itemName.replace('_', ''))) {
            foundItemName = entityItemName;
            return true;
          }
          if (entityItemName && entityItemName === itemName) {
            foundItemName = entityItemName;
            return true;
          }
          return false;
        }

        // アイテム名を記録
        if (entityItemName) {
          foundItemName = entityItemName;
        }
        return true;
      });

      if (!itemEntity) {
        const itemStr = itemName ? `${itemName}` : 'アイテム';
        return {
          success: false,
          result: `${maxDistance}ブロック以内に${itemStr}が見つかりません`,
        };
      }

      const distance = itemEntity.position.distanceTo(this.bot.entity.position);

      // アイテムに近づく（アイテムの真上に移動してピックアップ）
      if (distance > 0.5) {
        // 移動設定（障害物を壊す、ブロックを積んで登る）
        setMovements(
          this.bot,
          true,  // allow1by1towers: ブロックを積んで登る
          true,  // allowSprinting
          true,  // allowParkour
          true,  // canOpenDoors
          true,  // canDig: 障害物を壊す
          true,  // dontMineUnderFallingBlock
          1,     // digCost
          false  // allowFreeMotion
        );

        // まずアイテムの近くに移動
        const goal = new goals.GoalNear(
          itemEntity.position.x,
          itemEntity.position.y,
          itemEntity.position.z,
          0.5  // より近くに移動（ピックアップ範囲内）
        );

        const moveResult = await gotoSafe(this.bot, goal, { timeoutMs: 10_000, stuckAbortCount: 5 });
        if (!moveResult.success && (moveResult.error === 'timeout' || moveResult.error === 'stuck')) {
          return {
            success: false,
            result: 'アイテムに近づけませんでした（' + (moveResult.error === 'stuck' ? 'スタック' : 'タイムアウト') + '）',
          };
        }
      }

      // アイテムが自動的に拾われるまで待つ（少し長めに）
      await new Promise((resolve) => setTimeout(resolve, 800));

      // まだアイテムが存在する場合、直接その位置に歩いてみる
      const stillExists = this.bot.nearestEntity((e) => e === itemEntity);
      if (stillExists) {
        try {
          const sp = stillExists.position;
          await gotoSafe(this.bot, new goals.GoalNear(sp.x, sp.y, sp.z, 0.5), {
            timeoutMs: 3000,
            stuckAbortCount: 2,
            logStuck: false,
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch {
          // エラーは無視
        }
      }

      // 拾った後のインベントリを確認
      const afterInventory = new Map<string, number>();
      for (const item of this.bot.inventory.items()) {
        afterInventory.set(item.name, (afterInventory.get(item.name) || 0) + item.count);
      }

      // 増えたアイテムを検出
      const pickedItems: string[] = [];
      for (const [name, count] of afterInventory) {
        const beforeCount = beforeInventory.get(name) || 0;
        if (count > beforeCount) {
          pickedItems.push(`${name}x${count - beforeCount}`);
        }
      }

      if (pickedItems.length > 0) {
        return {
          success: true,
          result: `${pickedItems.join(', ')}を拾いました（距離: ${distance.toFixed(1)}m）`,
        };
      } else {
        const targetItem = foundItemName || itemName || 'アイテム';
        const stillThere = this.bot.nearestEntity((e) => e === itemEntity);
        const noEmptySlots = typeof this.bot.inventory.emptySlotCount === 'function'
          && this.bot.inventory.emptySlotCount() === 0;
        if (stillThere && noEmptySlots) {
          return {
            success: false,
            failureType: 'inventory_full',
            recoverable: true,
            result:
              `${targetItem}に近づきましたが、インベントリに空きがなく拾えません。` +
              '捨てずに必ず deposit-to-container で**地上（天光の届く場所）の**チェストまたは樽に預けて空きを作ってから再試行してください（無ければ地上へ出て find-blocks か chest をクラフトして屋外等に設置）。',
          };
        }
        return {
          success: false,
          result: `${targetItem}に近づきましたが、拾えませんでした（既に消えた可能性）`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        result: `アイテム拾得エラー: ${error.message}`,
      };
    }
  }
}

export default PickupNearestItem;
