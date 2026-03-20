import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:repairItem');

/**
 * 金床を使ってアイテムを修理する。
 * XPが必要。同じアイテム同士の合成、または素材での修理が可能。
 */
class RepairItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'repair-item';
    this.description = '金床を使ってアイテムを修理・合成します。XPが必要です。同じアイテム2つの合成、またはアイテム+素材での修理が可能です。';
    this.params = [
      { name: 'x', type: 'number', description: '金床のX座標', required: true },
      { name: 'y', type: 'number', description: '金床のY座標', required: true },
      { name: 'z', type: 'number', description: '金床のZ座標', required: true },
      { name: 'targetItem', type: 'string', description: '修理対象のアイテム名（例: diamond_pickaxe）', required: true },
      { name: 'materialItem', type: 'string', description: '修理材料（同アイテムまたはインゴット等。例: diamond, diamond_pickaxe）', required: true },
    ];
  }

  async runImpl(x: number, y: number, z: number, targetItem: string, materialItem: string) {
    try {
      // ブロック検証
      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);
      if (!block || !block.name.includes('anvil')) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})に金床がありません${block ? `（${block.name}）` : ''}`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      // 距離チェック & 移動
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 4.5) {
        try {
          await this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
        } catch {
          return {
            success: false,
            result: `金床に近づけません（距離: ${distance.toFixed(1)}）`,
            failureType: 'distance_too_far',
            recoverable: true,
          };
        }
      }

      // アイテム確認
      const target = this.bot.inventory.items().find(i => i.name === targetItem);
      if (!target) {
        return {
          success: false,
          result: `修理対象${targetItem}を持っていません`,
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      const material = this.bot.inventory.items().find(i => i.name === materialItem);
      if (!material) {
        return {
          success: false,
          result: `修理材料${materialItem}を持っていません`,
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      // 金床を開く
      log.info(`🔨 金床を開きます: (${x}, ${y}, ${z})`);
      const anvilWindow = await this.openAnvil(block);
      if (!anvilWindow) {
        return {
          success: false,
          result: '金床を開けませんでした',
          failureType: 'interaction_failed',
          recoverable: true,
        };
      }

      try {
        // 金床のスロット:
        // 0 = 修理対象（左）
        // 1 = 材料（右）
        // 2 = 結果（出力）

        // 修理対象をスロット0に入れる
        await this.bot.clickWindow(target.slot, 0, 0); // pickup
        await this.bot.clickWindow(0, 0, 0); // place in slot 0
        await new Promise(resolve => setTimeout(resolve, 200));

        // 材料をスロット1に入れる
        const currentMaterial = this.bot.inventory.items().find(i => i.name === materialItem);
        if (currentMaterial) {
          await this.bot.clickWindow(currentMaterial.slot, 0, 0); // pickup
          await this.bot.clickWindow(1, 0, 0); // place in slot 1
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        // 結果スロットを確認
        const outputSlot = anvilWindow.slots[2];
        if (!outputSlot) {
          // 出力がない場合、組み合わせが無効
          anvilWindow.close();
          return {
            success: false,
            result: `${targetItem}と${materialItem}の組み合わせは修理/合成できません`,
            failureType: 'invalid_combination',
            recoverable: true,
          };
        }

        // XPコスト確認
        const xpLevel = this.bot.experience?.level ?? 0;
        // anvil window の xpCost は property で取得できる場合がある
        const xpCost = (anvilWindow as any).xpCost ?? 0;
        if (xpCost > 0 && xpLevel < xpCost) {
          anvilWindow.close();
          return {
            success: false,
            result: `XPレベルが不足です（必要: Lv${xpCost}、現在: Lv${xpLevel}）`,
            failureType: 'insufficient_xp',
            recoverable: false,
          };
        }

        // 結果を取り出す
        await this.bot.clickWindow(2, 0, 0); // pickup output
        // 空いてるインベントリスロットに置く
        const emptySlot = this.bot.inventory.firstEmptyInventorySlot();
        if (emptySlot !== null) {
          await this.bot.clickWindow(emptySlot, 0, 0);
        }
        await new Promise(resolve => setTimeout(resolve, 200));

        anvilWindow.close();

        const outputName = outputSlot.name ?? targetItem;
        log.success(`🔨 修理完了: ${outputName}`);

        return {
          success: true,
          result: `修理成功！${targetItem}を${materialItem}で修理しました${xpCost > 0 ? `（XPコスト: Lv${xpCost}）` : ''}`,
        };
      } catch (error: any) {
        try { anvilWindow.close(); } catch { /* ignore */ }
        throw error;
      }
    } catch (error: any) {
      return {
        success: false,
        result: `修理エラー: ${error.message}`,
        failureType: 'repair_failed',
        recoverable: true,
      };
    }
  }

  /** 金床を開く（windowOpen イベント経由） */
  private async openAnvil(block: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bot.removeListener('windowOpen', onWindow);
        reject(new Error('金床を開くのがタイムアウトしました'));
      }, 5000);

      const onWindow = (window: any) => {
        clearTimeout(timeout);
        resolve(window);
      };

      this.bot.once('windowOpen', onWindow);
      this.bot.activateBlock(block).catch((err: any) => {
        clearTimeout(timeout);
        this.bot.removeListener('windowOpen', onWindow);
        reject(err);
      });
    });
  }
}

export default RepairItem;
