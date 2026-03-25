import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoEat');

const FALLBACK_FOOD_POINTS: Record<string, number> = {
  baked_potato: 5,
  bread: 5,
  cooked_beef: 8,
  steak: 8,
  cooked_porkchop: 8,
  cooked_mutton: 6,
  cooked_chicken: 6,
  cooked_rabbit: 5,
  cooked_cod: 5,
  cooked_salmon: 6,
  golden_carrot: 6,
  golden_apple: 4,
  enchanted_golden_apple: 4,
  carrot: 3,
  potato: 1,
  beetroot: 1,
  beetroot_soup: 6,
  mushroom_stew: 6,
  rabbit_stew: 10,
  suspicious_stew: 6,
  dried_kelp: 1,
  apple: 4,
  melon_slice: 2,
  sweet_berries: 2,
  glow_berries: 2,
  chorus_fruit: 4,
  cookie: 2,
  pumpkin_pie: 8,
  honey_bottle: 6,
  tropical_fish: 1,
  cod: 2,
  salmon: 2,
  pufferfish: 1,
  porkchop: 3,
  beef: 3,
  mutton: 2,
  chicken: 2,
  rabbit: 3,
  rotten_flesh: 4,
};

/**
 * 自動食事スキル
 * 体力または満腹度が低い時に自動で食べ物を食べる
 */
class AutoEat extends ConstantSkill {
  /** ログスロットル: 食べ物なし警告を30秒に1回に抑制 */
  private lastNoFoodWarnAt = 0;
  private static readonly NO_FOOD_WARN_INTERVAL_MS = 30_000;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-eat';
    this.description = '体力または満腹度が低い時に自動で食べ物を食べます';
    this.interval = 1000;
    this.isLocked = false;
    this.status = true;
    this.priority = 5;
  }

  async runImpl() {
    // 体力または満腹度が低い場合に食べる
    const health = this.bot.health ?? 20;
    const food = this.bot.food ?? 20;

    // 満腹度が18未満、または体力が18未満（ダメージ後の回復促進）で食べ物がある場合
    // Minecraftでは満腹度が18以上で自然回復するため、HPが減っていたら積極的に食べる
    if (food < 18 || (health < 18 && food < 20)) {
      // 食べられるアイテムを探す。mineflayer-auto-eat plugin が無い環境でも動くように
      // 名前ベースのフォールバック食料表を使う。
      const foodItems = this.bot.inventory
        .items()
        .filter((item) => {
          return this.getFoodPoints(item.name) > 0;
        })
        .sort((a, b) => {
          const aFood = this.getFoodPoints(a.name);
          const bFood = this.getFoodPoints(b.name);
          return bFood - aFood;
        });

      if (foodItems.length === 0) {
        const now = Date.now();
        if (now - this.lastNoFoodWarnAt >= AutoEat.NO_FOOD_WARN_INTERVAL_MS) {
          log.warn(`⚠ 食べ物が見つかりません: food=${food}/20 health=${health}/20`);
          this.lastNoFoodWarnAt = now;
        }
        return;
      }

      try {
        // 最も満腹度が高い食べ物を選択
        const foodItem = foodItems[0];

        // 既に手に持っている場合
        if (this.bot.heldItem?.name === foodItem.name) {
          await this.bot.consume();
          log.success(`✓ ${foodItem.name}を食べました (food=${food}/20 health=${health}/20)`);
          return;
        }

        // 手に持つ
        await this.bot.equip(foodItem, 'hand');

        // 食べる
        await this.bot.consume();
        log.success(`✓ ${foodItem.name}を食べました (food=${food}/20 health=${health}/20)`);
      } catch (error) {
        log.warn(`⚠ 食事に失敗: ${error instanceof Error ? error.message : '不明なエラー'}`);
      }
    }
  }

  private getFoodPoints(itemName: string): number {
    const pluginFoodPoints = (this.bot as any).autoEat?.foodData?.[itemName]?.foodPoints;
    if (typeof pluginFoodPoints === 'number' && pluginFoodPoints > 0) {
      return pluginFoodPoints;
    }
    return FALLBACK_FOOD_POINTS[itemName] ?? 0;
  }
}

export default AutoEat;
