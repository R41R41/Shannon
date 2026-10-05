import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:useStonecutter');

/**
 * 石切台を使って石材を加工する。
 * クラフトテーブルよりも効率的に石系ブロックを加工できる（1:1変換）。
 */
class UseStonecutter extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-stonecutter';
    this.description = '石切台で石材を加工します（石レンガ、階段、ハーフブロック等）。クラフトテーブルより効率的です。';
    this.params = [
      { name: 'x', type: 'number', description: '石切台のX座標', required: true },
      { name: 'y', type: 'number', description: '石切台のY座標', required: true },
      { name: 'z', type: 'number', description: '石切台のZ座標', required: true },
      { name: 'inputItem', type: 'string', description: '入力アイテム名（例: stone, cobblestone, quartz_block）', required: true },
      { name: 'outputItem', type: 'string', description: '出力アイテム名（例: stone_bricks, stone_stairs, stone_slab）', required: true },
      { name: 'count', type: 'number', description: '加工数（デフォルト: 1）', default: 1 },
    ];
  }

  async runImpl(x: number, y: number, z: number, inputItem: string, outputItem: string, count: number = 1) {
    try {
      // ブロック検証
      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);
      if (!block || block.name !== 'stonecutter') {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})に石切台がありません${block ? `（${block.name}）` : ''}`,
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
            result: `石切台に近づけません（距離: ${distance.toFixed(1)}、${r.error}）`,
            failureType: r.error === 'stuck' ? 'stuck' : 'distance_too_far',
            recoverable: true,
          };
        }
      }

      // 入力アイテム確認
      const inputItems = this.bot.inventory.items().filter(i => i.name === inputItem);
      const inputCount = inputItems.reduce((sum, i) => sum + i.count, 0);
      if (inputCount < count) {
        return {
          success: false,
          result: `${inputItem}が不足（必要: ${count}個、所持: ${inputCount}個）`,
          failureType: 'material_missing',
          recoverable: true,
        };
      }

      log.info(`🪨 石切台を開きます: (${x}, ${y}, ${z})`);
      let stonecutterWindow: any;
      try {
        stonecutterWindow = await this.openStonecutter(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }
      if (!stonecutterWindow) {
        return {
          success: false,
          result: '石切台を開けませんでした',
          failureType: 'interaction_failed',
          recoverable: true,
        };
      }

      try {
        // 石切台のスロット:
        // 0 = 入力
        // 1 = 出力
        // レシピはボタン選択（protocol レベル）

        const initialOutputCount = stonecutterWindow.slots
          .filter((item: any) => item?.name === outputItem)
          .reduce((sum: number, item: any) => sum + item.count, 0);
        let processed = 0;

        for (let i = 0; i < count; i++) {
          // 入力アイテムをスロット0に入れる
          const currentInput = this.bot.inventory.items().find(it => it.name === inputItem);
          if (!currentInput) break;

          // 開いたコンテナではプレイヤー側スロット番号が通常 inventory
          // と異なるため、slot を直接クリックせず transfer で移す。
          await this.bot.transfer({
            window: stonecutterWindow,
            itemType: currentInput.type,
            metadata: currentInput.metadata,
            count: Math.min(count - processed, currentInput.count),
            nbt: currentInput.nbt,
            sourceStart: stonecutterWindow.inventoryStart,
            sourceEnd: stonecutterWindow.inventoryEnd,
            destStart: 0,
            destEnd: 1,
          });
          await actionDelay(this.bot, 200);
          log.info(`🪨 石切台入力: ${stonecutterWindow.slots[0]?.name ?? 'empty'} x${stonecutterWindow.slots[0]?.count ?? 0}`);

          // 石切台は入力だけでは出力されず、クライアントがレシピ番号を
          // select_trade パケットで選ぶ必要がある。Mineflayer 4.35には
          // 石切台APIがないため、実際の出力スロットを見ながら選択する。
          const output = await this.selectRecipe(stonecutterWindow, outputItem);
          if (output && output.name === outputItem) {
            // shift-clickで出力を回収。入力スタックが残る場合は次の
            // ループで同じレシピを選び直して1個ずつ確実に処理する。
            await this.bot.clickWindow(1, 0, 1);
            await actionDelay(this.bot, 300);
            processed = stonecutterWindow.slots
              .filter((item: any) => item?.name === outputItem)
              .reduce((sum: number, item: any) => sum + item.count, 0) - initialOutputCount;
            if (processed >= count || !stonecutterWindow.slots[0]) break;
          } else {
            // レシピが一致しない場合 — 入力を戻す
            log.warn(`⚠️ ${inputItem} → ${outputItem} のレシピが見つかりません`);
            // 入力スロットから取り出して戻す
            await this.bot.clickWindow(0, 0, 0);
            const returnSlot = this.bot.inventory.firstEmptyInventorySlot();
            if (returnSlot !== null) {
              await this.bot.clickWindow(returnSlot, 0, 0);
            }
            break;
          }

          await actionDelay(this.bot, 100);
        }

        stonecutterWindow.close();

        if (processed === 0) {
          return {
            success: false,
            result: `${inputItem} → ${outputItem} のレシピが石切台にありません。別の出力アイテム名を確認してください。`,
            failureType: 'invalid_recipe',
            recoverable: true,
          };
        }

        log.success(`🪨 石切台加工完了: ${inputItem} x${processed} → ${outputItem} x${processed}`);
        return {
          success: true,
          result: `石切台で${inputItem}から${outputItem}を${processed}個作成しました`,
        };
      } catch (error: any) {
        try { stonecutterWindow.close(); } catch { /* ignore */ }
        throw error;
      }
    } catch (error: any) {
      return {
        success: false,
        result: `石切台エラー: ${error.message}`,
        failureType: 'stonecutter_failed',
        recoverable: true,
      };
    }
  }

  private async selectRecipe(window: any, outputItem: string): Promise<any | null> {
    const observed = new Set<string>();
    for (let recipeIndex = 0; recipeIndex < 64; recipeIndex++) {
      // Stonecutter recipe buttons use the generic container-button packet
      // (named enchant_item by minecraft-protocol), not merchant select_trade.
      (this.bot as any)._client.write('enchant_item', {
        windowId: window.id,
        enchantment: recipeIndex,
      });
      const output = await this.waitForOutput(window, outputItem, 120);
      if (output?.name && !observed.has(output.name)) {
        observed.add(output.name);
        log.info(`🪨 石切台候補[${recipeIndex}]: ${output.name} x${output.count}`);
      }
      if (output?.name === outputItem) return output;
    }
    return null;
  }

  private async waitForOutput(window: any, outputItem: string, timeoutMs: number): Promise<any | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const output = window.slots[1];
      if (output?.name === outputItem) return output;
      await actionDelay(this.bot, 20);
    }
    return window.slots[1] ?? null;
  }

  /** 石切台を開く（windowOpen イベント経由） */
  private async openStonecutter(block: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bot.removeListener('windowOpen', onWindow);
        reject(new Error('石切台を開くのがタイムアウトしました'));
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
}

export default UseStonecutter;
