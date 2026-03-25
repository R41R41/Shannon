import { CustomBot, InstantSkill } from '../types.js';

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

      const item = this.bot.inventory
        .items()
        .find((i) => i.name === itemName);

      if (!item) {
        return {
          success: false,
          result: `インベントリに${itemName}がありません`,
        };
      }

      await this.bot.equip(item, mapping.dest as any);

      return {
        success: true,
        result: `${itemName}を${mapping.label}に装備しました`,
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
