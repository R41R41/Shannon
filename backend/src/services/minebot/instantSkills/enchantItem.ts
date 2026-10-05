import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:enchantItem');

/**
 * エンチャントテーブルを使ってアイテムをエンチャントする。
 * ラピスラズリと十分なXPレベルが必要。
 */
class EnchantItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'enchant-item';
    this.description = 'エンチャントテーブルを使ってアイテムをエンチャントします。ラピスラズリと十分なXPレベルが必要です。';
    this.params = [
      { name: 'x', type: 'number', description: 'エンチャントテーブルのX座標', required: true },
      { name: 'y', type: 'number', description: 'エンチャントテーブルのY座標', required: true },
      { name: 'z', type: 'number', description: 'エンチャントテーブルのZ座標', required: true },
      { name: 'slot', type: 'number', description: 'エンチャントスロット（0=弱, 1=中, 2=強）。デフォルト: 0', default: 0 },
    ];
  }

  async runImpl(x: number, y: number, z: number, slot: number = 0) {
    try {
      // スロット検証
      if (slot < 0 || slot > 2) {
        return {
          success: false,
          result: `無効なスロット: ${slot}（0, 1, 2 のいずれかを指定）`,
          failureType: 'invalid_args',
          recoverable: true,
        };
      }

      // ブロック検証
      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);
      if (!block || block.name !== 'enchanting_table') {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にエンチャントテーブルがありません${block ? `（${block.name}）` : ''}`,
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
            result: `エンチャントテーブルに近づけません（距離: ${distance.toFixed(1)}、${r.error}）`,
            failureType: r.error === 'stuck' ? 'stuck' : 'distance_too_far',
            recoverable: true,
          };
        }
      }

      // ラピスラズリ確認
      const lapisCount = this.bot.inventory.items()
        .filter(i => i.name === 'lapis_lazuli')
        .reduce((sum, i) => sum + i.count, 0);
      const requiredLapis = slot + 1;
      if (lapisCount < requiredLapis) {
        return {
          success: false,
          result: `ラピスラズリが不足（必要: ${requiredLapis}個、所持: ${lapisCount}個）`,
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      // XPレベル確認
      const xpLevel = this.bot.experience?.level ?? 0;
      if (xpLevel < slot + 1) {
        return {
          success: false,
          result: `XPレベルが不足（スロット${slot}には最低Lv${slot + 1}が必要、現在: Lv${xpLevel}）`,
          failureType: 'insufficient_xp',
          recoverable: false,
        };
      }

      // エンチャントテーブルを開く
      const enchantTable = await (this.bot as any).openEnchantmentTable(block);
      if (!enchantTable) {
        return {
          success: false,
          result: 'エンチャントテーブルを開けませんでした',
          failureType: 'interaction_failed',
          recoverable: true,
        };
      }

      try {
        const targetItem = this.bot.inventory.items().find(item =>
          item.name !== 'lapis_lazuli'
          && (item.maxDurability > 0 || item.name === 'book' || item.name === 'bow' || item.name === 'crossbow')
        );
        const lapisItem = this.bot.inventory.items().find(item => item.name === 'lapis_lazuli');
        if (!targetItem || !lapisItem) {
          enchantTable.close();
          return {
            success: false,
            result: 'エンチャント対象またはラピスラズリが見つかりません',
            failureType: 'material_missing',
            recoverable: true,
          };
        }

        await this.transferToSlot(enchantTable, targetItem, 0, 1);
        await this.transferToSlot(enchantTable, lapisItem, 1, requiredLapis);

        // エンチャント可能な情報を取得
        // enchantTable.enchantments は配列: [{level, expected?}]
        await actionDelay(this.bot, 500);
        log.info(`✨ エンチャント台スロット: target=${enchantTable.slots[0]?.name ?? 'empty'}, lapis=${enchantTable.slots[1]?.name ?? 'empty'}`);

        const enchantments = enchantTable.enchantments;
        if (!enchantments || enchantments.length === 0) {
          enchantTable.close();
          return {
            success: false,
            result: 'エンチャント可能なアイテムがありません。手にアイテムを持っていますか？',
            failureType: 'no_enchantments',
            recoverable: true,
          };
        }

        if (!enchantments[slot]) {
          enchantTable.close();
          const available = enchantments.map((e: any, i: number) => `スロット${i}: Lv${e?.level ?? '?'}`).join(', ');
          return {
            success: false,
            result: `スロット${slot}のエンチャントが利用できません（利用可能: ${available}）`,
            failureType: 'slot_unavailable',
            recoverable: true,
          };
        }

        const targetEnchant = enchantments[slot];
        const selectedLevel = targetEnchant.level;
        log.info(`✨ エンチャント実行: スロット${slot} (候補Lv${selectedLevel})`);

        // Mineflayer 4.35 waits specifically for updateSlot:0, but modern
        // servers can acknowledge this container action through a full window
        // update instead. Send the real button packet and verify the durable
        // XP/item state rather than hanging on one event shape.
        const xpBefore = this.bot.experience?.level ?? 0;
        (this.bot as any)._client.write('enchant_item', {
          windowId: enchantTable.id,
          enchantment: slot,
        });
        await actionDelay(this.bot, 750);
        const enchantedItem = enchantTable.slots[0];
        const xpAfter = this.bot.experience?.level ?? xpBefore;
        const hasEnchants = Array.isArray(enchantedItem?.enchants) && enchantedItem.enchants.length > 0;
        if (!hasEnchants && xpAfter >= xpBefore) {
          enchantTable.close();
          return {
            success: false,
            result: `エンチャントがサーバーに受理されませんでした（候補Lv${selectedLevel}）`,
            failureType: 'interaction_failed',
            recoverable: true,
          };
        }
        await enchantTable.takeTargetItem();
        enchantTable.close();

        return {
          success: true,
          result: `エンチャント成功！スロット${slot}（Lv${selectedLevel}）を適用しました`,
        };
      } catch (error: any) {
        try { enchantTable.close(); } catch { /* ignore */ }
        throw error;
      }
    } catch (error: any) {
      return {
        success: false,
        result: `エンチャントエラー: ${error.message}`,
        failureType: 'enchant_failed',
        recoverable: true,
      };
    }
  }

  private async transferToSlot(window: any, item: any, destination: number, count: number): Promise<void> {
    await this.bot.transfer({
      window,
      itemType: item.type,
      metadata: item.metadata,
      count,
      nbt: item.nbt,
      sourceStart: window.inventoryStart,
      sourceEnd: window.inventoryEnd,
      destStart: destination,
      destEnd: destination + 1,
    });
  }

}

export default EnchantItem;
