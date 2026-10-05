import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

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
        const r = await gotoSafe(this.bot, new goals.GoalNear(x, y, z, 2), { timeoutMs: 15_000 });
        if (!r.success) {
          return {
            success: false,
            result: `金床に近づけません（距離: ${distance.toFixed(1)}、${r.error}）`,
            failureType: r.error === 'stuck' ? 'stuck' : 'distance_too_far',
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

      log.info(`🔨 金床を開きます: (${x}, ${y}, ${z})`);
      let anvilWindow: any;
      try {
        // Use Mineflayer's anvil abstraction. It maps the player inventory
        // into the open container, computes the XP cost, and takes slot 2 with
        // the correct transaction state for the current protocol.
        anvilWindow = await (this.bot as any).openAnvil(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }
      if (!anvilWindow) {
        return {
          success: false,
          result: '金床を開けませんでした',
          failureType: 'interaction_failed',
          recoverable: true,
        };
      }

      try {
        await anvilWindow.combine(target, material);

        anvilWindow.close();

        log.success(`🔨 修理完了: ${targetItem}`);

        return {
          success: true,
          result: `修理成功！${targetItem}を${materialItem}で修理しました`,
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

}

export default RepairItem;
