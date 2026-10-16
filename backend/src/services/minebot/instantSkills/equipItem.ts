import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';
import { equipToHandVerified } from '../utils/equipVerified.js';

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

  /** bot.equip returned but the item is not in the hand, and moving it to the hotbar did not help either. */
  private notHeld(name: string, detail: string) {
    log.warn(`equip-item失敗: ${name} が手に入りません（${detail}）`);
    return {
      success: false,
      failureType: 'equip_failed',
      recoverable: true,
      result: `${name}をメインハンドに持てませんでした（装備しても手が変わらず、ホットバーへ移す再試行も効きませんでした）。`
        + 'ホットバー（クイックバー）の空きを作る（不要な物を捨てる・預ける）か、サーバーが枠の移動を拒否している可能性があります。空きを作ってからもう一度試してください',
    };
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

      // An exact item ID never falls back to a similar name: water_bucket must
      // not equip an empty bucket and report success.
      const exactId = !!(this.bot.registry as any)?.itemsByName?.[itemName];
      const item = inventoryItems.find((i) => i.name === itemName)
        ?? (exactId ? undefined : inventoryItems.find((i) => i.name.includes(itemName) || itemName.includes(i.name)));

      if (item) {
        if (mapping.dest === 'hand') {
          const outcome = await equipToHandVerified(this.bot, item);
          if (!outcome.held) return this.notHeld(item.name, outcome.detail);
          if (outcome.retried) log.info(`${item.name}: ホットバーへ移して手に持ちました（${outcome.detail}）`);
        } else {
          await this.bot.equip(item, mapping.dest as any);
        }
        return {
          success: true,
          result: `${item.name}を${mapping.label}に装備しました`,
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
        await actionDelay(this.bot, 100);

        const movedItem = this.bot.inventory.items().find((i) => i.name === itemName);
        if (movedItem) {
          if (mapping.dest === 'hand') {
            const outcome = await equipToHandVerified(this.bot, movedItem);
            if (!outcome.held) return this.notHeld(movedItem.name, outcome.detail);
          } else {
            await this.bot.equip(movedItem, mapping.dest as any);
          }
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
