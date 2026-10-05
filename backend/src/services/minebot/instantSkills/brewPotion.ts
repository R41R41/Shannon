import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:brewPotion');

/**
 * 醸造台でポーションを醸造する。
 * ガラス瓶（水入り）、材料、ブレイズパウダーが必要。
 */
class BrewPotion extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'brew-potion';
    this.description = '醸造台でポーションを醸造します。水入り瓶(potion)、材料、ブレイズパウダーが必要です。20秒かかります。';
    this.maxDurationMs = 30_000;
    this.params = [
      { name: 'x', type: 'number', description: '醸造台のX座標', required: true },
      { name: 'y', type: 'number', description: '醸造台のY座標', required: true },
      { name: 'z', type: 'number', description: '醸造台のZ座標', required: true },
      { name: 'ingredient', type: 'string', description: '材料アイテム名（例: nether_wart, redstone, glowstone_dust, fermented_spider_eye）', required: true },
    ];
  }

  async runImpl(x: number, y: number, z: number, ingredient: string) {
    try {
      // ブロック検証
      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);
      if (!block || block.name !== 'brewing_stand') {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})に醸造台がありません${block ? `（${block.name}）` : ''}`,
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
            result: `醸造台に近づけません（距離: ${distance.toFixed(1)}、${r.error}）`,
            failureType: r.error === 'stuck' ? 'stuck' : 'distance_too_far',
            recoverable: true,
          };
        }
      }

      // 材料確認
      const ingredientItem = this.bot.inventory.items().find(i => i.name === ingredient);
      if (!ingredientItem) {
        return {
          success: false,
          result: `材料${ingredient}を持っていません`,
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      // ブレイズパウダー確認
      const blazePowder = this.bot.inventory.items().find(i => i.name === 'blaze_powder');
      if (!blazePowder) {
        return {
          success: false,
          result: 'ブレイズパウダーを持っていません（醸造の燃料として必要）',
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      // 水入り瓶確認
      const potions = this.bot.inventory.items().filter(i => i.name === 'potion');
      if (potions.length === 0) {
        return {
          success: false,
          result: '水入り瓶(potion)を持っていません。ガラス瓶に水を入れてください。',
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      log.info(`🧪 醸造台を開きます: (${x}, ${y}, ${z})`);
      let brewingStand: any;
      try {
        brewingStand = await this.openBrewingStand(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }
      if (!brewingStand) {
        return {
          success: false,
          result: '醸造台を開けませんでした',
          failureType: 'interaction_failed',
          recoverable: true,
        };
      }

      try {
        // スロット配置:
        // 0, 1, 2 = ポーション瓶（下段）
        // 3 = 材料（上段）
        // 4 = ブレイズパウダー（燃料）

        // 燃料スロットが空ならブレイズパウダーを入れる
        const fuelSlot = brewingStand.slots[4];
        if (!fuelSlot) {
          await this.clickWindowItem(brewingStand, blazePowder, 4);
          await actionDelay(this.bot, 200);
        }

        // ポーション瓶を下段に入れる（最大3本）
        const bottlesToAdd = Math.min(potions.length, 3);
        for (let i = 0; i < bottlesToAdd; i++) {
          const bottleSlot = brewingStand.slots[i];
          if (!bottleSlot) {
            const currentPotions = this.bot.inventory.items().filter(it => it.name === 'potion');
            if (currentPotions.length > 0) {
              await this.clickWindowItem(brewingStand, currentPotions[0], i);
              await actionDelay(this.bot, 200);
            }
          }
        }

        // 材料を上段に入れる
        const currentIngredient = this.bot.inventory.items().find(i => i.name === ingredient);
        if (currentIngredient) {
          await this.clickWindowItem(brewingStand, currentIngredient, 3);
          await actionDelay(this.bot, 200);
        }

        await actionDelay(this.bot, 500);
        log.info(`🧪 醸造台スロット: ${brewingStand.slots.slice(0, 5).map((item: any) => item ? `${item.name}x${item.count}` : 'empty').join(', ')}`);
        const loadedBottles = brewingStand.slots.slice(0, 3).filter((item: any) => item?.name === 'potion').length;
        // Fuel may already have been consumed into the stand's internal fuel
        // meter, in which case slot 4 is legitimately empty.
        if (!brewingStand.slots[3] || loadedBottles === 0) {
          brewingStand.close();
          return {
            success: false,
            result: '醸造台へ材料・水入り瓶・燃料を正しく配置できませんでした',
            failureType: 'interaction_failed',
            recoverable: true,
          };
        }

        log.info(`🧪 醸造開始: ${ingredient} x ${loadedBottles}本`);

        // 醸造完了（材料スロットの消費）をサーバー状態で確認する。
        await this.waitUntil(() => !brewingStand.slots[3], 25_000);

        brewingStand.close();

        return {
          success: true,
          result: `醸造完了！${ingredient}を使って${loadedBottles}本のポーションを醸造しました。醸造台から回収してください。`,
        };
      } catch (error: any) {
        try { brewingStand.close(); } catch { /* ignore */ }
        throw error;
      }
    } catch (error: any) {
      return {
        success: false,
        result: `醸造エラー: ${error.message}`,
        failureType: 'brew_failed',
        recoverable: true,
      };
    }
  }

  /** 醸造台を開く（windowOpen イベント経由） */
  private async openBrewingStand(block: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bot.removeListener('windowOpen', onWindow);
        reject(new Error('醸造台を開くのがタイムアウトしました'));
      }, 5000);

      const onWindow = (window: any) => {
        clearTimeout(timeout);
        resolve(window);
      };

      this.bot.once('windowOpen', onWindow);
      this.bot.activateBlock(block).catch((err: any) => {
        clearTimeout(timeout);
        this.bot.removeListener('windowOpen', onWindow);
        reject(err);
      });
    });
  }

  /** windowにアイテムを入れる */
  private async clickWindowItem(window: any, item: any, destSlot: number): Promise<void> {
    await this.bot.transfer({
      window,
      itemType: item.type,
      metadata: item.metadata,
      count: 1,
      nbt: item.nbt,
      sourceStart: window.inventoryStart,
      sourceEnd: window.inventoryEnd,
      destStart: destSlot,
      destEnd: destSlot + 1,
    });
  }

  private async waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt >= timeoutMs) throw new Error('醸造完了の待機がタイムアウトしました');
      await actionDelay(this.bot, 250);
    }
  }
}

export default BrewPotion;
