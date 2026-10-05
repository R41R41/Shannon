import { actionDelay } from '../execution/observedWait.js';
import { potionIn } from '../utils/potionContents.js';
import minecraftData from 'minecraft-data';
import { CustomBot, InstantSkill } from '../types.js';

/** What is drunk rather than eaten: used the same way (held until it is gone), whatever the hunger bar says. */
const DRINKS = new Set(['potion', 'milk_bucket', 'ominous_bottle']);

const CONSUMABLE_ITEMS = new Set([
  'apple', 'baked_potato', 'beef', 'beetroot', 'beetroot_soup', 'bread',
  'carrot', 'chicken', 'chorus_fruit', 'cod', 'cookie', 'cooked_beef',
  'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop',
  'cooked_rabbit', 'cooked_salmon', 'dried_kelp', 'enchanted_golden_apple',
  'glow_berries', 'golden_apple', 'golden_carrot', 'honey_bottle',
  'melon_slice', 'mushroom_stew', 'mutton', 'poisonous_potato', 'porkchop',
  'potato', 'pufferfish', 'pumpkin_pie', 'rabbit', 'rabbit_stew',
  'rotten_flesh', 'salmon', 'spider_eye', 'steak', 'suspicious_stew',
  'sweet_berries', 'tropical_fish',
]);

/**
 * 原子的スキル: アイテムを使用（右クリック）
 */
class UseItem extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-item';
    this.description = '指定したアイテムを装備して使用します（右クリック）。食べ物を食べる・ポーションを飲む場合にも使用します。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: 'アイテム名（例: bread, apple, potion）。空の場合は手に持っているアイテムを使用',
        default: null,
      },
      {
        name: 'contents',
        type: 'string',
        description: 'ポーションの中身（例: fire_resistance）。持ち物の観測の contents と同じ名前。指定すると、その中身のポーションを選んで使う（省略時は最初に見つかったもの）',
        default: null,
      },
    ];
  }

  async runImpl(itemName: string | null = null, contents: string | null = null) {
    try {
      // アイテム名が指定されている場合、装備する
      if (itemName) {
        const wanted = contents ? String(contents).replace(/^minecraft:/, '').trim() : '';
        const inventoryItem = this.bot.inventory.items().find(
          (item) => item.name === itemName && (!wanted || potionIn(item as any) === wanted)
        );

        if (!inventoryItem) {
          const kinds = [...new Set(this.bot.inventory.items().filter((item) => item.name === itemName).map((item) => potionIn(item as any) ?? '中身なし'))];
          return {
            success: false,
            result: wanted && kinds.length ? `${itemName}はありますが、中身が${wanted}のものはありません（持っているのは: ${kinds.join('、')}）` : `インベントリに${itemName}がありません`,
            failureType: 'missing_item', recoverable: true,
          };
        }

        await this.bot.equip(inventoryItem, 'hand');
      }

      const heldItem = this.bot.heldItem;

      if (!heldItem) {
        return {
          success: false,
          result: '手に何も持っていません',
        };
      }

      // アイテムが使用可能かチェック
      const item = this.mcData.itemsByName[heldItem.name];
      if (!item) {
        return {
          success: false,
          result: `${heldItem.name}は使用できません`,
        };
      }

      // activateItem() は「使用開始」だけで即時に戻る。食料はサーバーが
      // 消費を確定するまで押し続ける必要があるため consume() を使う。
      if (CONSUMABLE_ITEMS.has(heldItem.name)) {
        // Whether it was eaten is what the pack and the hunger bar say afterwards. The library's own answer is
        // a wait for one packet: when the eating reflex was already chewing the same item, the item went, the
        // bar rose, and the answer was "Promise timed out" (paid run L66; the planner's next action was dropped).
        const name = heldItem.name;
        const count = () => this.bot.inventory.items().filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
        const before = { count: count(), food: this.bot.food };
        let failure: string | null = null;
        try { await this.bot.consume(); } catch (error: any) { failure = String(error?.message ?? error); }
        const eaten = count() < before.count || this.bot.food > before.food;
        if (eaten) return { success: true, result: `${name}を食べました（満腹度 ${before.food}→${this.bot.food}/20、残り${count()}個）` };
        if (before.food >= 20) return { success: false, result: `満腹（20/20）のため${name}は食べられません`, failureType: 'not_hungry', recoverable: true };
        return { success: false, result: `${name}を食べられませんでした（${failure ?? '所持数も満腹度も変わっていません'}。満腹度 ${this.bot.food}/20）`, recoverable: true };
      } else if (DRINKS.has(heldItem.name)) {
        // A drink is held to the lips until it is gone, like food: begun and let go at once, the potion stayed
        // in the hand and nothing came of it (lab: "used", no effect, the bottle still full).
        const name = heldItem.name;
        const contents = potionIn(heldItem as any);
        const label = contents ? `${name}（${contents}）` : name;
        const count = () => this.bot.inventory.items().filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
        const before = count();
        let failure: string | null = null;
        try { await this.bot.consume(); } catch (error: any) { failure = String(error?.message ?? error); }
        // The pack is told of the empty bottle a moment after the drinking is done.
        for (const deadline = Date.now() + 1500; Date.now() < deadline && count() >= before;) await actionDelay(this.bot, 100);
        if (count() >= before) {
          return { success: false, result: `${label}を飲めませんでした（${failure ?? '所持数が変わっていません'}）`, failureType: 'not_consumed', recoverable: true };
        }
        await actionDelay(this.bot, 300);
        const effects = Object.values((this.bot.entity as any)?.effects ?? {}).map((effect: any) =>
          `${String((this.bot as any).registry?.effects?.[effect.id]?.name ?? `effect_${effect.id}`)}（残り約${Math.round((effect.duration ?? 0) / 20)}秒）`);
        return { success: true, result: `${label}を飲みました。いま付いている効果: ${effects.length ? effects.join('、') : 'なし'}` };
      } else if (heldItem.name === 'splash_potion' || heldItem.name === 'lingering_potion') {
        // Thrown where the body looks: at its own feet, so that what it is a potion of lands on the body.
        const contents = potionIn(heldItem as any);
        await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
        await this.bot.activateItem();
        await actionDelay(this.bot, 900);
        const effects = Object.values((this.bot.entity as any)?.effects ?? {}).map((effect: any) =>
          `${String((this.bot as any).registry?.effects?.[effect.id]?.name ?? `effect_${effect.id}`)}（残り約${Math.round((effect.duration ?? 0) / 20)}秒）`);
        return { success: true, result: `${heldItem.name}${contents ? `（${contents}）` : ''}を足元に投げました。いま付いている効果: ${effects.length ? effects.join('、') : 'なし'}` };
      } else {
        await this.bot.activateItem();
      }

      return {
        success: true,
        result: `${heldItem.name}を使用しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `アイテム使用エラー: ${error.message}`,
      };
    }
  }
}

export default UseItem;
