import { CustomBot, InstantSkill } from '../types.js';

/**
 * 原子的スキル: インベントリ内の特定アイテムの数を確認（複数同時対応）
 */
class CheckInventoryItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'check-inventory-item';
    this.description =
      'インベントリ内の特定アイテムの数を確認します。カンマ区切りで複数アイテムを同時に確認できます（例: "iron_ingot,stick,cobblestone"）。複数確認したい場合は必ずカンマ区切りで1回で呼んでください。';
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description:
          'アイテム名（カンマ区切りで複数指定可能。例: "iron_ingot,stick,cobblestone"）',
        required: true,
      },
    ];
  }

  async runImpl(itemName: string) {
    try {
      const names = itemName
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);

      const allItems = this.bot.inventory.items();
      const results: string[] = [];

      for (const name of names) {
        const matched = allItems.filter((item) => item.name === name);
        if (matched.length === 0) {
          results.push(`${name}: 0個`);
        } else {
          const total = matched.reduce((sum, item) => sum + item.count, 0);
          results.push(`${name}: ${total}個`);
        }
      }

      return {
        success: true,
        result: results.join(', '),
      };
    } catch (error: any) {
      return {
        success: false,
        result: `確認エラー: ${error.message}`,
      };
    }
  }
}

export default CheckInventoryItem;
