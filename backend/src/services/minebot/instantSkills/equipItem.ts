import { CustomBot, InstantSkill } from '../types.js';

/**
 * 原子的スキル: アイテムを手（メインハンド or オフハンド）に装備する
 */
class EquipItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'equip-item';
    this.description =
      'インベントリのアイテムをメインハンドまたはオフハンドに装備します。盾や松明をオフハンドに持つ場合などに使います。';
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: '装備するアイテム名（例: shield, torch, totem_of_undying）',
        required: true,
      },
      {
        name: 'hand',
        type: 'string',
        description: '"main" でメインハンド、"off" でオフハンド（デフォルト: main）',
        default: 'main',
      },
    ];
  }

  async runImpl(itemName: string, hand: string = 'main') {
    try {
      if (!itemName) {
        return { success: false, result: 'アイテム名を指定してください' };
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

      const destination = hand === 'off' ? 'off-hand' : 'hand';
      await this.bot.equip(item, destination as any);

      const handLabel = hand === 'off' ? 'オフハンド' : 'メインハンド';
      return {
        success: true,
        result: `${itemName}を${handLabel}に装備しました`,
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
