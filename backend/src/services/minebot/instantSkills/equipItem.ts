import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';

const log = createLogger('Minebot:EquipItem');

type EquipDestination = 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet';

const DESTINATION_MAP: Record<string, { dest: EquipDestination; label: string }> = {
  main: { dest: 'hand', label: 'メインハンド' },
  off: { dest: 'off-hand', label: 'オフハンド' },
  head: { dest: 'head', label: '頭' },
  torso: { dest: 'torso', label: '胴' },
  legs: { dest: 'legs', label: '脚' },
  feet: { dest: 'feet', label: '足' },
};

/**
 * 原子的スキル: アイテムを指定スロットに装備する
 */
class EquipItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'equip-item';
    this.description =
      'インベントリのアイテムを指定スロットに装備します。防具（ヘルメット・チェストプレート・レギンス・ブーツ）や手持ちアイテムの装備に使います。';
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: '装備するアイテム名（例: shield, diamond_helmet, iron_chestplate, golden_boots）',
        required: true,
      },
      {
        name: 'destination',
        type: 'string',
        description:
          '"main"=メインハンド, "off"=オフハンド, "head"=頭, "torso"=胴, "legs"=脚, "feet"=足（デフォルト: main）',
        default: 'main',
      },
    ];
  }

  private getEquippedItems(): { slot: string; item: any }[] {
    const equipped: { slot: string; item: any }[] = [];
    const slotNames: EquipDestination[] = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'];
    for (const slot of slotNames) {
      const slotIndex = this.bot.getEquipmentDestSlot(slot as any);
      const item = (this.bot.inventory as any).slots[slotIndex];
      if (item) equipped.push({ slot, item });
    }
    return equipped;
  }

  async runImpl(itemName: string, destination: string = 'main') {
    try {
      if (!itemName) {
        return { success: false, result: 'アイテム名を指定してください' };
      }

      const mapping = DESTINATION_MAP[destination];
      if (!mapping) {
        return {
          success: false,
          result: `不正なスロット "${destination}"。使用可能: main, off, head, torso, legs, feet`,
        };
      }

      const inventoryItems = this.bot.inventory.items();
      const equippedItems = this.getEquippedItems();

      const item = inventoryItems.find((i) => i.name === itemName)
        ?? inventoryItems.find((i) => i.name.includes(itemName) || itemName.includes(i.name));

      if (item) {
        await this.bot.equip(item, mapping.dest as any);
        return {
          success: true,
          result: `${itemName}を${mapping.label}に装備しました`,
        };
      }

      const equippedMatch = equippedItems.find((e) => e.item.name === itemName);
      if (equippedMatch) {
        if (equippedMatch.slot === mapping.dest) {
          return {
            success: true,
            result: `${itemName}は既に${mapping.label}に装備されています`,
          };
        }
        await this.bot.unequip(equippedMatch.slot as any);
        await new Promise((r) => setTimeout(r, 100));

        const movedItem = this.bot.inventory.items().find((i) => i.name === itemName);
        if (movedItem) {
          await this.bot.equip(movedItem, mapping.dest as any);
          return {
            success: true,
            result: `${itemName}を${equippedMatch.slot}から${mapping.label}に移動しました`,
          };
        }

        return {
          success: false,
          result: `${itemName}を${equippedMatch.slot}から外しましたが、再装備に失敗しました`,
        };
      }

      const invNames = inventoryItems.map((i) => `${i.name}(x${i.count})`).join(', ');
      const equipNames = equippedItems.map((e) => `${e.item.name}[${e.slot}]`).join(', ');
      log.warn(`equip-item失敗: "${itemName}"が見つからない。インベントリ: [${invNames}], 装備中: [${equipNames}]`);
      return {
        success: false,
        result: `インベントリに${itemName}がありません (所持: ${invNames || 'なし'}, 装備中: ${equipNames || 'なし'})`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `装備エラー: ${error.message}`,
      };
    }
  }
}

export default EquipItem;
