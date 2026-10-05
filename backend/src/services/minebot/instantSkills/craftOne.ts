import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { checkBlockLineOfSight, ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { blockCenterWithinUseReach } from '../utils/blockInteractionReach.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import {
  countItemInInventory,
  hasNearbyDroppedItemNamed,
  inventoryNoEmptySlots,
  INVENTORY_FULL_RECOVERY_HINT_JA,
} from '../utils/inventorySpillDetection.js';
import { actionDelay } from '../execution/observedWait.js';
import { resyncInventory } from '../utils/inventorySync.js';
const log = createLogger('Minebot:Skill:craftOne');

/**
 * 原子的スキル: アイテムを1個クラフト
 */
class CraftOne extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'craft-one';
    this.description = '指定アイテムをクラフトします。countで一度に複数個クラフトできます。';
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

  /**
   * `tableSearchRadius` is not a parameter the planner sees: a caller that makes a tool on the way (utils/toolStock)
   * uses a table only where it can be reached, and otherwise puts down the one it carries.
   */
  async runImpl(itemName: string, count: number = 1, tableSearchRadius: number = 32) {
    const tableRadius = Number.isFinite(tableSearchRadius) && tableSearchRadius > 0 ? Math.min(32, tableSearchRadius) : 32;
    let beforeCount = 0;
    let craftCount = Math.max(1, Math.min(count, 64));
    let craftingTable: ReturnType<typeof this.bot.findBlock> = null;
    let craftAttempted = false;
    try {
      // 開いているGUIを閉じる（activate-blockで開いたクラフトテーブルなど）
      if (this.bot.currentWindow) {
        log.debug('🔧 開いているウィンドウを閉じます');
        this.bot.closeWindow(this.bot.currentWindow);
        await actionDelay(this.bot, 100);
      }
      // Crafting works the pack by clicks on slots, from the body's copy of the pack. The copy is made the
      // server's first, and anything an earlier craft left in the pack's own grid is taken back out of it:
      // one item left there spoils every recipe made in that grid afterwards (see resyncInventory).
      await resyncInventory(this.bot as any);

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

      if (requiresCraftingTable) {
        craftingTable = this.bot.findBlock({
          matching: this.mcData.blocksByName.crafting_table?.id,
          maxDistance: tableRadius,
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

      // A table several blocks above/below may be within use reach, but an
      // intervening furnace or wall can still prevent the crafting window from
      // opening. Check both reach and line of sight *before* bot.craft: that
      // method waits for windowOpen when the server rejects activation.
      if (craftingTable) {
        let access = this.tableAccess(craftingTable);
        let movementFailure = '';

        if (!access.inReach) {
          const moveTo = this.bot.instantSkills?.getSkill('move-to');
          if (moveTo) {
            const moved = await moveTo.run(
              craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2, 'near',
            );
            if (!moved.success) movementFailure = moved.result;
          }
          access = this.tableAccess(craftingTable);
        }

        if (!access.ready && !this.shouldInterrupt()) {
          // A protected utility block must never be dug for a view. A nearby
          // safe ascent column can give a view above it without touching it.
          if ((access.obstruction && PROTECTED_UTILITY_BLOCKS.has(access.obstruction))
            || (!access.inReach && craftingTable.position.y > this.bot.entity.position.y + 1)) {
            await this.trySafeAscentToTable(craftingTable);
          } else if (access.inReach && access.obstruction) {
            await ensureLineOfSight(this.bot, craftingTable.position, 4.5);
          }
          access = this.tableAccess(craftingTable);
        }

        if (!access.ready && !this.shouldInterrupt()) {
          await this.tryVisibleTableStance(craftingTable);
          access = this.tableAccess(craftingTable);
        }

        if (!access.ready) {
          const carriedTable = this.bot.inventory.items().some(i => i.name === 'crafting_table');
          const localTable = !this.shouldInterrupt() && carriedTable ? await this.tryPlaceCraftingTable() : null;
          if (localTable && this.tableAccess(localTable).ready) {
            craftingTable = localTable;
          } else {
            const pos = craftingTable.position;
            const obstruction = access.obstruction ? `。視線の遮蔽物: ${access.obstruction}` : '';
            return {
              success: false,
              result: `crafting_table(${pos.x},${pos.y},${pos.z})を現在位置から安全に操作できません${obstruction}` +
                (movementFailure ? `。移動結果: ${movementFailure}` : '') +
                (carriedTable ? '。所持する作業台の近くへの設置も失敗しました' :
                  '。安全な別の立ち位置・上方への経路を作るか、材料があれば近くに別の作業台を製作・設置してください'),
              failureType: access.inReach ? 'line_of_sight_blocked' : 'distance_too_far',
              recoverable: true,
            };
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
        craftAttempted = true;
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

      await this.refreshIncompleteTableOutput(craftingTable, itemName, beforeCount, craftCount);
      return await this.finalizeCraftOutcome(itemName, beforeCount, craftCount);
    } catch (error: any) {
      // エラーでも部分的にクラフト成功している場合がある
      // （bot.craft が途中で例外を投げてもアイテムは増えている）
      await actionDelay(this.bot, 200);
      if (craftAttempted) await this.refreshIncompleteTableOutput(craftingTable, itemName, beforeCount, craftCount);
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

  private async refreshIncompleteTableOutput(
    table: ReturnType<CustomBot['findBlock']>, itemName: string, beforeCount: number, craftCount: number,
  ): Promise<void> {
    if (!table || this.shouldInterrupt() || countItemInInventory(this.bot, itemName) >= beforeCount + craftCount) return;
    // Mineflayer closes/copies the crafting window before all its final slot
    // packets necessarily arrive, then ignores packets for that closed ID.
    // Waiting on the stale copy cannot fix that. Reopening asks the server for
    // a fresh window snapshot through the normal game protocol (no OP commands).
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.bot.removeListener('windowOpen', onOpen); };
        const fail = (error: unknown) => { cleanup(); reject(error); };
        const onOpen = (window: NonNullable<CustomBot['currentWindow']>) => {
          cleanup();
          if (typeof window.type !== 'string' || !window.type.startsWith('minecraft:crafting') || this.bot.currentWindow !== window) {
            reject(new Error('作業台の最新在庫を取得できませんでした'));
            return;
          }
          this.bot.closeWindow(window); // copies the fresh player-inventory slots
          resolve();
        };
        const timer = setTimeout(() => fail(new Error('作業台の在庫同期がタイムアウトしました')), 2000);
        this.bot.once('windowOpen', onOpen);
        try { Promise.resolve(this.bot.activateBlock(table)).catch(fail); } catch (error) { fail(error); }
      });
      log.debug(`🔄 作業台在庫を再同期: ${itemName}=${countItemInInventory(this.bot, itemName)}`);
    } catch (error) {
      // Preserve genuine partial/inventory-full recovery outcomes below.
      log.warn(`作業台の在庫再同期を確認できません: ${error instanceof Error ? error.message : String(error)}`);
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
    const synchronizationDeadline = Date.now() + 2000;
    await actionDelay(this.bot, 400);
    // The count below is read from the body's copy of its pack. The library has written its own forecast
    // of the craft into that copy, so the server is asked what is really there.
    // Asked every time, not only when the count is short: the forecast can also say the output is there when
    // the server made none (paid run L74 "crafted" a chest it then could not place, eleven times).
    await resyncInventory(this.bot as any);
    let afterCount = countItemInInventory(this.bot, itemName);
    let crafted = afterCount - beforeCount;
    let onGround = hasNearbyDroppedItemNamed(this.bot, this.mcData, itemName, 10);

    // Window updates can deliver multi-craft output incrementally. A positive
    // partial count is not yet the final count. Retain partial/full-inventory
    // outcomes, but first allow a bounded interval for the requested output.
    while (crafted < craftCount && !onGround && !inventoryNoEmptySlots(this.bot)
      && Date.now() < synchronizationDeadline && !this.shouldInterrupt()) {
      await actionDelay(this.bot, 50);
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
      recoverable: true,
      result: `${itemName}のクラフトに失敗しました（サーバーが結果を出しませんでした。所持品はサーバーと照合済みで、材料は戻っています。現在: ${itemName}=${afterCount}個）`,
    };
  }

  private tableAccess(table: NonNullable<ReturnType<CustomBot['findBlock']>>): {
    ready: boolean; inReach: boolean; obstruction?: string;
  } {
    const inReach = blockCenterWithinUseReach(this.bot.entity.position, table.position);
    const los = checkBlockLineOfSight(this.bot, table.position, 4.5);
    return { ready: inReach && los.clear, inReach, obstruction: los.obstructionName };
  }

  private static readonly UNSAFE_STANCE_BLOCKS = new Set([
    'water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire',
    'powder_snow', 'cactus', 'sweet_berry_bush', 'magma_block',
  ]);
  private static readonly UNSAFE_OVERHEAD_BLOCKS = new Set([
    ...CraftOne.UNSAFE_STANCE_BLOCKS,
    'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
    'anvil', 'chipped_anvil', 'damaged_anvil', 'pointed_dripstone',
  ]);

  private isOpenStanceBlock(pos: Vec3): boolean {
    const block = this.bot.blockAt(pos);
    return !!block && block.boundingBox === 'empty'
      && !CraftOne.UNSAFE_STANCE_BLOCKS.has(block.name);
  }

  private isSafeStance(pos: Vec3): boolean {
    const support = this.bot.blockAt(pos.offset(0, -1, 0));
    return this.isOpenStanceBlock(pos) && this.isOpenStanceBlock(pos.offset(0, 1, 0))
      && !!support && support.boundingBox !== 'empty'
      && !CraftOne.UNSAFE_STANCE_BLOCKS.has(support.name);
  }

  private isSafeToClear(pos: Vec3): boolean {
    const block = this.bot.blockAt(pos);
    return !!block && !CraftOne.UNSAFE_OVERHEAD_BLOCKS.has(block.name)
      && !PROTECTED_UTILITY_BLOCKS.has(block.name)
      && (block.boundingBox === 'empty' || block.diggable === true);
  }

  /**
   * A small, already-open standing node can see a workstation which is hidden
   * from the present node. Never regard a pathfinder success as interaction
   * proof: re-check the bot's actual eye position after moving.
   */
  private async tryVisibleTableStance(table: NonNullable<ReturnType<CustomBot['findBlock']>>): Promise<boolean> {
    const move = this.bot.instantSkills?.getSkill('move-to');
    if (!move) return false;
    const origin = this.bot.entity.position;
    const base = origin.floored();
    const candidates: Array<{ feet: Vec3; score: number }> = [];
    for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > 4) continue;
          const cell = new Vec3(base.x + dx, base.y + dy, base.z + dz);
          if (!this.isSafeStance(cell)) continue;
          const feet = cell.offset(0.5, 0, 0.5);
          if (!blockCenterWithinUseReach(feet, table.position)) continue;
          if (!checkBlockLineOfSight(this.bot, table.position, 4.5, feet).clear) continue;
          if (origin.distanceTo(feet) < 0.45) continue;
          candidates.push({ feet, score: Math.hypot(dx, dz) + Math.abs(dy) * 2 });
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const { feet } of candidates.slice(0, 2)) {
      if (this.shouldInterrupt()) return false;
      await move.run(feet.x, feet.y, feet.z, 0.5, 'near');
      if (this.tableAccess(table).ready) return true;
    }
    return false;
  }

  /**
   * If a protected block is directly overhead in a mine, first step to an
   * adjacent safe column. The existing tower-up skill then performs its own
   * liquid/falling-block and diggability checks while ascending. This changes
   * only physical access to the chosen table, not the planner's goal.
   */
  private async trySafeAscentToTable(table: NonNullable<ReturnType<CustomBot['findBlock']>>): Promise<boolean> {
    const move = this.bot.instantSkills?.getSkill('move-to');
    const dig = this.bot.instantSkills?.getSkill('dig-block-at');
    const tower = this.bot.instantSkills?.getSkill('tower-up');
    if (!move || !tower) return false;
    const start = this.bot.entity.position.floored();
    const rise = table.position.y - start.y;
    if (rise < 1 || rise > 6) return false;

    const candidates: Array<{ feet: Vec3; score: number }> = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 2) continue;
        const cell = new Vec3(start.x + dx, start.y, start.z + dz);
        // The ideal neighbouring column may have one ordinary stone block at
        // foot level. Pathfinder can clear it while stepping there; rejecting
        // every non-air foot cell would leave an enclosed shaft stranded.
        const support = this.bot.blockAt(cell.offset(0, -1, 0));
        if (!support || support.boundingBox === 'empty'
          || CraftOne.UNSAFE_STANCE_BLOCKS.has(support.name)
          || !this.isSafeToClear(cell) || !this.isSafeToClear(cell.offset(0, 1, 0))) continue;
        let excavationCost = [cell, cell.offset(0, 1, 0)]
          .filter(pos => this.bot.blockAt(pos)?.boundingBox !== 'empty').length;
        let clearable = true;
        for (let y = start.y + 2; y <= table.position.y + 2; y++) {
          const pos = new Vec3(cell.x, y, cell.z);
          if (!this.isSafeToClear(pos)) {
            clearable = false;
            break;
          }
          if (this.bot.blockAt(pos)?.boundingBox !== 'empty') excavationCost++;
        }
        if (!clearable) continue;
        const feet = cell.offset(0.5, 0, 0.5);
        const topFeet = new Vec3(feet.x, table.position.y, feet.z);
        if (!blockCenterWithinUseReach(topFeet, table.position)
          || !checkBlockLineOfSight(this.bot, table.position, 4.5, topFeet).clear) continue;
        candidates.push({ feet, score: this.bot.entity.position.distanceTo(feet) + excavationCost * 3 });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const candidate = candidates[0];
    if (!candidate || this.shouldInterrupt()) return false;
    const { feet } = candidate;
    const cell = feet.floored();
    // Clear only the selected adjacent walking cell, never the protected
    // obstruction. Explicit dig-block-at preserves tool, lava and block
    // protection checks and avoids a long pathfinder detour for one stone.
    for (const pos of [cell, cell.offset(0, 1, 0)]) {
      if (this.isOpenStanceBlock(pos)) continue;
      if (!dig || this.shouldInterrupt()) return false;
      const cleared = await dig.run(pos.x, pos.y, pos.z, false);
      if (!cleared.success || !this.isOpenStanceBlock(pos)) return false;
    }
    // A local pathfinder success can precede a server position correction by
    // several ticks. Let both pathfinder and the server settle before jumping;
    // otherwise the tower may start below the protected block we just avoided.
    let settledInColumn = false;
    for (let attempt = 0; attempt < 2 && !this.shouldInterrupt(); attempt++) {
      if (this.bot.entity.position.distanceTo(feet) > 0.45) {
        const moved = await move.run(feet.x, feet.y, feet.z, 0.5, 'near');
        if (!moved.success) return false;
      }
      const pathfinder = this.bot.pathfinder as typeof this.bot.pathfinder & { goal?: unknown };
      const hadGoal = !!pathfinder.goal;
      const wasMoving = pathfinder.isMoving();
      if (hadGoal || wasMoving) {
        pathfinder.setGoal(null);
      }
      // A resolved goto may have no goal yet still leave a forward key or
      // residual horizontal velocity. Release those controls unconditionally
      // before the manual jump/placement sequence takes motor ownership.
      this.bot.clearControlStates();
      await actionDelay(this.bot, 600);
      const actual = this.bot.entity.position;
      const velocity = this.bot.entity.velocity;
      const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
      const horizontalControls = ['forward', 'back', 'left', 'right']
        .filter(name => this.bot.getControlState(name as any));
      settledInColumn = Math.floor(actual.x) === cell.x
        && Math.floor(actual.y) === cell.y && Math.floor(actual.z) === cell.z
        && horizontalSpeed < 0.05 && horizontalControls.length === 0;
      log.info(`作業列の安定確認 ${attempt + 1}/2: target=${cell.toArray().join(',')}` +
        ` actual=${actual.toArray().map(n => n.toFixed(2)).join(',')}` +
        ` speedXZ=${horizontalSpeed.toFixed(3)} controls=${horizontalControls.join(',') || 'none'}` +
        ` pathfinderGoal=${hadGoal} moving=${wasMoving} stable=${settledInColumn}`);
      if (settledInColumn) break;
    }
    if (!settledInColumn) return false;
    if (this.shouldInterrupt()) return false;
    await tower.run(rise);
    return this.tableAccess(table).ready;
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
            await actionDelay(this.bot, 200);
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
