import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';

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
        try {
          await this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
        } catch {
          return {
            success: false,
            result: `エンチャントテーブルに近づけません（距離: ${distance.toFixed(1)}）`,
            failureType: 'distance_too_far',
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
        // エンチャント可能な情報を取得
        // enchantTable.enchantments は配列: [{level, expected?}]
        await new Promise(resolve => setTimeout(resolve, 300)); // UI反映待ち

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
        log.info(`✨ エンチャント実行: スロット${slot} (Lv${targetEnchant.level})`);

        // エンチャント実行
        await enchantTable.enchant(slot);
        enchantTable.close();

        return {
          success: true,
          result: `エンチャント成功！スロット${slot}（Lv${targetEnchant.level}）を適用しました`,
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
}

export default EnchantItem;
