import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import {
  countItemInInventory,
  hasNearbyDroppedItemNamed,
  inventoryNoEmptySlots,
  INVENTORY_FULL_RECOVERY_HINT_JA,
} from '../utils/inventorySpillDetection.js';
const log = createLogger('Minebot:Skill:craftOne');

/**
 * 原子的スキル: アイテムを1個クラフト
 */
class CraftOne extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'craft-one';
    this.description =
      '指定アイテムをクラフトします。countで一度に複数個クラフトできます。' +
      'クラフト前にequip-itemで装備を試み、既に所持していないか確認することを推奨。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: 'クラフトするアイテム名',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: 'クラフトする個数（デフォルト: 1）',
        default: 1,
      },
    ];
  }

  /**
   * 材料IDを名前に変換（配列の場合は全選択肢を表示、木材系は任意表記）
   */
  private getIngredientName(ingredientId: any): string | null {
    if (ingredientId === null || ingredientId === -1) {
      return null;
    }

    if (Array.isArray(ingredientId)) {
      const names = ingredientId
        .filter((id: any) => id !== null && id !== -1)
        .map((id: any) => this.mcData.items[id]?.name)
        .filter((name: string | undefined) => name);

      if (names.length === 0) return null;
      if (names.length === 1) {
        return this.addWoodNote(names[0]);
      }
      if (names.length > 3) {
        return `${names.slice(0, 3).join('/')}等`;
      }
      return names.join('/');
    }

    const item = this.mcData.items[ingredientId];
    if (!item) return null;
    return this.addWoodNote(item.name);
  }

  /**
   * 木材系アイテムに注釈を追加
   */
  /**
   * 材料不足時に「製錬が必要」ヒントを生成する。
   * 例: iron_ingot が必要だが raw_iron を持っている → 「炉で製錬してください」
   */
  private suggestSmeltingHint(requiredMaterials: string, inventoryItems: any[]): string | null {
    const smeltMap: Record<string, string> = {
      iron_ingot: 'raw_iron',
      gold_ingot: 'raw_gold',
      copper_ingot: 'raw_copper',
    };
    const hints: string[] = [];
    for (const [ingot, raw] of Object.entries(smeltMap)) {
      if (requiredMaterials.includes(ingot)) {
        const rawItem = inventoryItems.find((i: any) => i.name === raw);
        if (rawItem) {
          hints.push(`${ingot}が必要ですが${raw}(x${rawItem.count})があります。start-smeltingで炉に入れてから製錬してください`);
        }
      }
    }
    return hints.length > 0 ? hints.join('; ') : null;
  }

  /**
   * planks が必要だがログを持っている場合のヒント生成
   */
  private suggestPlanksHint(requiredMaterials: string, inventoryItems: any[]): string | null {
    if (!requiredMaterials.includes('planks')) return null;

    const logs = inventoryItems.filter((i: any) =>
      i.name.endsWith('_log') || i.name.endsWith('_wood') || i.name.endsWith('_stem'),
    );
    if (logs.length === 0) return null;

    const hints: string[] = [];
    for (const log of logs) {
      const woodType = log.name.replace(/_log$|_wood$|_stem$/, '');
      const planksName = `${woodType}_planks`;
      if (this.mcData.itemsByName[planksName]) {
        hints.push(`${log.name}(x${log.count})からcraft-one(${planksName})で木材を作れる`);
      }
    }
    return hints.length > 0 ? hints.slice(0, 2).join('; ') : null;
  }

  /**
   * 材料不足時に、インベントリの素材で作れる代替アイテムを提案する
   */
  private suggestAlternatives(itemName: string, inventoryItems: any[]): string | null {
    const woodTypes = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak'];
    const woodSuffixes = ['_planks', '_slab', '_stairs', '_fence', '_door', '_button', '_pressure_plate', '_sign', '_boat'];

    for (const suffix of woodSuffixes) {
      if (!itemName.endsWith(suffix)) continue;

      const availableLogs = inventoryItems
        .filter((i: any) => i.name.endsWith('_log') || i.name.endsWith('_wood') || i.name.endsWith('_stem'))
        .map((i: any) => {
          const woodType = woodTypes.find(wt => i.name.startsWith(wt)) || i.name.replace(/_log$|_wood$|_stem$/, '');
          return { logName: i.name, count: i.count, woodType };
        });

      const availablePlanks = inventoryItems
        .filter((i: any) => i.name.endsWith('_planks'))
        .map((i: any) => ({ name: i.name, count: i.count }));

      const suggestions: string[] = [];

      for (const plank of availablePlanks) {
        const altName = plank.name.replace('_planks', '') + suffix;
        if (this.mcData.itemsByName[altName] && altName !== itemName) {
          suggestions.push(`${altName}（${plank.name} x${plank.count} あり）`);
        }
      }

      for (const log of availableLogs) {
        const plankName = `${log.woodType}_planks`;
        const altName = log.woodType + suffix;
        if (this.mcData.itemsByName[altName] && altName !== itemName) {
          suggestions.push(`${altName}（${log.logName} x${log.count} から ${plankName} を作成可能）`);
        }
      }

      if (suggestions.length > 0) return suggestions.slice(0, 3).join(', ');
    }

    return null;
  }

  private addWoodNote(name: string): string {
    const woodTypes = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak'];
    const woodSuffixes = ['_planks', '_log', '_wood', '_slab', '_stairs'];

    for (const suffix of woodSuffixes) {
      if (name.endsWith(suffix)) {
        for (const woodType of woodTypes) {
          if (name.startsWith(woodType)) {
            return `${name}(任意の${suffix.slice(1)}可)`;
          }
        }
      }
    }
    return name;
  }

  async runImpl(itemName: string, count: number = 1) {
    let beforeCount = 0;
    let craftCount = Math.max(1, Math.min(count, 64));
    try {
      // 開いているGUIを閉じる（activate-blockで開いたクラフトテーブルなど）
      if (this.bot.currentWindow) {
        log.debug('🔧 開いているウィンドウを閉じます');
        this.bot.closeWindow(this.bot.currentWindow);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const item = this.mcData.itemsByName[itemName];
      if (!item) {
        const allItems = Object.keys(this.mcData.itemsByName);
        const suggestions = allItems
          .filter((name: string) => name.includes(itemName.replace('wooden_', '').replace('_planks', '')))
          .slice(0, 5);

        let hint = '';
        if (itemName.includes('plank')) {
          hint = ' ヒント: planksは木の種類を指定する必要があります（例: oak_planks, birch_planks, spruce_planks）';
        }

        return {
          success: false,
          result: `アイテム${itemName}が見つかりません。${suggestions.length > 0 ? `類似: ${suggestions.join(', ')}` : ''}${hint}`,
        };
      }

      // minecraft-dataからレシピを確認
      const allRecipes = this.mcData.recipes[item.id];
      let requiresCraftingTable = false;

      if (allRecipes && allRecipes.length > 0) {
        const recipe = allRecipes[0];
        if (recipe.inShape) {
          if (recipe.inShape.length > 2 || (recipe.inShape[0] && recipe.inShape[0].length > 2)) {
            requiresCraftingTable = true;
          }
        } else if (recipe.ingredients && recipe.ingredients.length > 4) {
          requiresCraftingTable = true;
        }
      }

      let craftingTable: ReturnType<typeof this.bot.findBlock> = null;

      if (requiresCraftingTable) {
        craftingTable = this.bot.findBlock({
          matching: this.mcData.blocksByName.crafting_table?.id,
          maxDistance: 32,
        });
      }

      if (requiresCraftingTable && !craftingTable) {
        // インベントリにcrafting_tableがあれば自動設置を試みる
        const tableInInventory = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (tableInInventory) {
          craftingTable = await this.tryPlaceCraftingTable();
          if (!craftingTable) {
            return {
              success: false,
              result: `${itemName}のクラフトにはクラフトテーブルが必要です。crafting_tableをインベントリに持っていますが、設置に失敗しました。place-block-atで手動設置してください`,
              failureType: 'crafting_table_placement_failed',
              recoverable: true,
            };
          }
          log.info(`🔧 crafting_tableを自動設置しました`);
        } else {
          return {
            success: false,
            result: `${itemName}のクラフトにはクラフトテーブルが必要です。crafting_tableをクラフトして設置してください`,
            failureType: 'crafting_table_missing',
            recoverable: true,
          };
        }
      }

      // crafting_table が遠い場合は近づく
      if (craftingTable) {
        const dist = this.bot.entity.position.distanceTo(craftingTable.position);
        if (dist > 4) {
          const moveTo = this.bot.instantSkills?.getSkill('move-to');
          if (moveTo) {
            const moveResult = await moveTo.run(
              craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2, 'near',
            );
            if (!moveResult.success) {
              return {
                success: false,
                result: `crafting_tableが遠すぎます（${dist.toFixed(1)}m）。近づけませんでした: ${moveResult.result}`,
                failureType: 'distance_too_far',
                recoverable: true,
              };
            }
          }
        }
      }

      craftCount = Math.max(1, Math.min(count, 64));

      let recipes = this.bot.recipesFor(item.id, null, craftCount, craftingTable);

      if (recipes.length === 0) {
        if (allRecipes && allRecipes.length > 0) {
          const inventory = this.bot.inventory.items()
            .map((i: any) => `${i.name}x${i.count}`)
            .join(', ') || 'なし';

          // 全レシピの材料パターンを取得
          const recipePatterns: string[] = [];

          for (const recipe of allRecipes) {
            const ingredientCounts: { [key: string]: number } = {};

            if (recipe.inShape) {
              for (const row of recipe.inShape) {
                for (const id of row) {
                  const name = this.getIngredientName(id);
                  if (name) {
                    ingredientCounts[name] = (ingredientCounts[name] || 0) + 1;
                  }
                }
              }
            } else if (recipe.ingredients) {
              for (const id of recipe.ingredients) {
                const name = this.getIngredientName(id);
                if (name) {
                  ingredientCounts[name] = (ingredientCounts[name] || 0) + 1;
                }
              }
            }

            const pattern = Object.entries(ingredientCounts)
              .map(([n, c]) => `${n} x${c}`)
              .join(' + ');

            if (pattern && !recipePatterns.includes(pattern)) {
              recipePatterns.push(pattern);
            }
          }

          const requiredMaterials = recipePatterns.length > 0
            ? recipePatterns.join(' or ')
            : '不明';

          const inventoryItemsList = this.bot.inventory.items();
          const alternatives = this.suggestAlternatives(itemName, inventoryItemsList);
          const smeltHint = this.suggestSmeltingHint(requiredMaterials, inventoryItemsList);
          const planksHint = this.suggestPlanksHint(requiredMaterials, inventoryItemsList);
          return {
            success: false,
            result: `${itemName}のクラフトに必要な材料が不足。` +
              `必要: ${requiredMaterials}。` +
              `現在のインベントリ: ${inventory}。` +
              (smeltHint ? ` ⚠️ 製錬ヒント: ${smeltHint}。` : '') +
              (planksHint ? ` 💡 木材ヒント: ${planksHint}。` : '') +
              (alternatives ? ` 代替案: ${alternatives}` : ''),
          };
        }
        return {
          success: false,
          result: `${itemName}のクラフトレシピが存在しません`,
        };
      }

      const recipe = recipes[0];

      // レシピ1回あたりの出力数を考慮してクラフト回数を算出
      // count=4, 1回で4個産出 → craftOps=1 (oak_planks等)
      // count=4, 1回で2個産出 → craftOps=2 (stick等)
      const resultPerCraft = recipe.result?.count ?? 1;
      const craftOps = Math.ceil(craftCount / resultPerCraft);

      // クラフト前のアイテム数を記録
      beforeCount = this.bot.inventory.items()
        .filter((i: any) => i.name === itemName)
        .reduce((sum: number, i: any) => sum + i.count, 0);

      // クラフト実行
      try {
        await this.bot.craft(recipe, craftOps, craftingTable || undefined);
      } catch (actionError: any) {
        if (craftingTable) {
          const los = await ensureLineOfSight(this.bot, craftingTable.position);
          if (!los.clear) {
            const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
            return { success: false, result: los.message!, failureType: failType, recoverable: true };
          }
        }
        throw actionError;
      }

      return await this.finalizeCraftOutcome(itemName, beforeCount, craftCount);
    } catch (error: any) {
      // エラーでも部分的にクラフト成功している場合がある
      // （bot.craft が途中で例外を投げてもアイテムは増えている）
      await new Promise(resolve => setTimeout(resolve, 200));
      const afterQuick = countItemInInventory(this.bot, itemName);
      if (afterQuick > beforeCount) {
        return await this.finalizeCraftOutcome(itemName, beforeCount, craftCount);
      }

      let errorDetail = error.message;
      if (error.message.includes('missing')) {
        errorDetail = '必要な材料が不足しています';
      } else if (error.message.includes('table')) {
        errorDetail = 'クラフトテーブルが必要です';
      }

      return {
        success: false,
        result: `クラフトエラー: ${errorDetail}`,
      };
    }
  }

  /**
   * クラフト後のインベントリ・地上ドロップを踏まえて結果を組み立てる。
   * 満杯で出力が地上に落ちた場合は inventory_full を付与する。
   */
  private async finalizeCraftOutcome(
    itemName: string,
    beforeCount: number,
    craftCount: number,
  ): Promise<{ success: boolean; result: string; failureType?: string; recoverable?: boolean }> {
    await new Promise(r => setTimeout(r, 400));
    let afterCount = countItemInInventory(this.bot, itemName);
    let crafted = afterCount - beforeCount;
    let onGround = hasNearbyDroppedItemNamed(this.bot, this.mcData, itemName, 10);

    if (crafted === 0 && !onGround) {
      await new Promise(r => setTimeout(r, 450));
      afterCount = countItemInInventory(this.bot, itemName);
      crafted = afterCount - beforeCount;
      onGround = hasNearbyDroppedItemNamed(this.bot, this.mcData, itemName, 10);
    }

    const noSlots = inventoryNoEmptySlots(this.bot);

    const invFullHint = INVENTORY_FULL_RECOVERY_HINT_JA;

    if (crafted >= craftCount) {
      return {
        success: true,
        result: `${itemName}を${crafted}個クラフトしました（${beforeCount}→${afterCount}個）`,
      };
    }

    if (onGround && noSlots && crafted < craftCount) {
      if (crafted > 0) {
        return {
          success: true,
          failureType: 'inventory_full',
          recoverable: true,
          result:
            `${itemName}を${crafted}個だけインベントリに収められました（要求${craftCount}個）。満杯のため残りは地上に落ちている可能性が高いです。${invFullHint}`,
        };
      }
      return {
        success: true,
        failureType: 'inventory_full',
        recoverable: true,
        result:
          `${itemName}のクラフト結果がインベントリに入らず地上に落ちています（満杯）。材料は消費された可能性があります。${invFullHint}`,
      };
    }

    if (crafted > 0) {
      return {
        success: true,
        result:
          `${itemName}を${crafted}個クラフトしました（要求${craftCount}個より少ない可能性：材料不足など）（${beforeCount}→${afterCount}個）`,
      };
    }

    if (onGround && !noSlots) {
      return {
        success: false,
        recoverable: true,
        result:
          `${itemName}が地上に落ちていますがインベントリに入っていません（空きスロットはあるため同期遅延の可能性）。pickup-nearest-itemで回収してください。`,
      };
    }

    return {
      success: false,
      result: `${itemName}のクラフトに失敗しました（インベントリに追加されていません）`,
    };
  }

  /**
   * crafting_table をボットの足元付近に自動設置する。
   * 成功したら設置されたブロックを返す。失敗したら null。
   */
  private async tryPlaceCraftingTable(): Promise<any> {
    try {
      const placeSkill = this.bot.instantSkills?.getSkill('place-block-at');
      if (!placeSkill) return null;

      const pos = this.bot.entity.position;
      // ボットの前方に設置を試みる（複数候補）
      const candidates = [
        { x: Math.floor(pos.x) + 1, y: Math.floor(pos.y), z: Math.floor(pos.z) },
        { x: Math.floor(pos.x) - 1, y: Math.floor(pos.y), z: Math.floor(pos.z) },
        { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) + 1 },
        { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) - 1 },
      ];

      for (const c of candidates) {
        const block = this.bot.blockAt(new Vec3(c.x, c.y, c.z));
        if (block && (block.name === 'air' || block.name === 'cave_air')) {
          const result = await placeSkill.run('crafting_table', c.x, c.y, c.z);
          if (result.success) {
            await new Promise(r => setTimeout(r, 200));
            return this.bot.findBlock({
              matching: this.mcData.blocksByName.crafting_table?.id,
              maxDistance: 4,
            });
          }
        }
      }
      return null;
    } catch (e: any) {
      log.warn(`crafting_table自動設置エラー: ${e.message}`);
      return null;
    }
  }
}

export default CraftOne;
