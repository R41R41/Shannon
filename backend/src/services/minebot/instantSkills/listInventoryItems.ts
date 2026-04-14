import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { prismarineItemToInventoryEntry } from '../utils/inventorySnapshot.js';
const log = createLogger('Minebot:Skill:listInventoryItems');

/**
 * 原子的スキル: インベントリの全アイテムをリスト表示
 */
class ListInventoryItems extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'list-inventory-items';
    this.description = 'インベントリ内の全アイテムをリスト表示します。';
    this.params = [];
  }

  async runImpl() {
    try {
      const items = this.bot.inventory.items();

      if (items.length === 0) {
        return {
          success: true,
          result: 'インベントリは空です',
        };
      }

      const lines = items.map((raw) => {
        const e = prismarineItemToInventoryEntry(raw as any);
        let s = `${e.name} x${e.count}`;
        if (e.durabilityRemaining != null && e.durabilityMax != null) {
          s += ` 耐久${e.durabilityRemaining}/${e.durabilityMax}`;
        }
        return s;
      });
      const itemList = lines.join(', ');

      const totalSlots = items.length;
      const emptySlots = 36 - totalSlots; // 通常36スロット

      return {
        success: true,
        result: `インベントリ(${totalSlots}/36スロット使用): ${itemList}`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `取得エラー: ${error.message}`,
      };
    }
  }
}

export default ListInventoryItems;
