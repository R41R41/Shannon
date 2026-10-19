import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { approachFurnace } from '../utils/furnaceReach.js';
import { FALLBACK_FOOD_POINTS, RAW_FOOD } from '../constantSkills/autoEat.js';
import { nearestOres, scanLoadedBlocks } from '../utils/loadedBlockScan.js';
import type { SkillResult } from '../types/skillParams.js';

/** How far a free furnace is looked for when the one asked for is busy. */
const FREE_FURNACE_RANGE = 24;
/** How far ores worth mining while a batch smelts are looked for. */
const MEANWHILE_RANGE = 24;

/**
 * 原子的スキル: かまどで精錬を開始
 *
 * かまどに材料が既に入っている場合は燃料追加のみで精錬を再開できる。
 */
class StartSmelting extends InstantSkill {
  private mcData: any;

  /** 燃料1個あたりの精錬回数 */
  private static readonly FUEL_SMELTS: Record<string, number> = {
    coal: 8,
    charcoal: 8,
    coal_block: 80,
    lava_bucket: 100,
    blaze_rod: 12,
    dried_kelp_block: 20,
    // 木系燃料
    oak_planks: 1.5, bamboo_planks: 1.5, spruce_planks: 1.5, birch_planks: 1.5,
    jungle_planks: 1.5, acacia_planks: 1.5, dark_oak_planks: 1.5, cherry_planks: 1.5,
    mangrove_planks: 1.5, crimson_planks: 1.5, warped_planks: 1.5,
    oak_log: 1.5, spruce_log: 1.5, birch_log: 1.5, jungle_log: 1.5,
    acacia_log: 1.5, dark_oak_log: 1.5, cherry_log: 1.5, mangrove_log: 1.5,
    stick: 0.5,
    bamboo: 0.25,
    // 木製ツール・その他
    wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1, wooden_shovel: 1, wooden_hoe: 1,
    bow: 1.5, fishing_rod: 1.5, crossbow: 1.5,
  };

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'start-smelting';
    this.description = 'かまどに材料と燃料を入れて精錬を開始します。かまどに材料が既に入っている場合は燃料追加のみで再開します。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'かまどのX座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'かまどのY座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'かまどのZ座標',
        required: true,
      },
      {
        name: 'inputItem',
        type: 'string',
        description: '精錬する材料（例: raw_iron, raw_gold）',
        required: true,
      },
      {
        name: 'fuelItem',
        type: 'string',
        description:
          '燃料。推奨: coal または charcoal（いずれも1個8回分）。インベントリに高効率燃料がある場合は板材・棒より自動で優先する。無い場合は所持する木材などの有効な燃料で精錬できる',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '精錬する個数',
        default: 1,
      },
    ];
  }

  /** 燃料の精錬能力を返す。無効な燃料は 0 を返す */
  private getFuelSmelts(fuelName: string): number {
    // 完全一致
    if (StartSmelting.FUEL_SMELTS[fuelName] !== undefined) {
      return StartSmelting.FUEL_SMELTS[fuelName];
    }
    // _planks / _log サフィックスで部分一致（木系燃料）
    if (fuelName.endsWith('_planks')) return 1.5;
    if (fuelName.endsWith('_log') || fuelName.endsWith('_wood') || fuelName.endsWith('_stem')) return 1.5;
    // 未知のアイテムは燃料として無効
    return 0;
  }

  /** 有効な燃料かどうかを判定する */
  private isValidFuel(fuelName: string): boolean {
    return this.getFuelSmelts(fuelName) > 0;
  }

  /** Burnable, but needed for work: never chosen automatically or suggested as fuel. */
  private static readonly EQUIPMENT_FUELS = new Set([
    'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe', 'bow', 'fishing_rod', 'crossbow',
  ]);

  private isExpendableFuel(fuelName: string): boolean {
    return this.isValidFuel(fuelName) && !StartSmelting.EQUIPMENT_FUELS.has(fuelName);
  }

  /** The fuel slot excludes fuel already burning, so include its remaining time. */
  private remainingBurningSmelts(furnace: Awaited<ReturnType<CustomBot['openFurnace']>>, secPerItem: number): number {
    const live = furnace as typeof furnace & { fuelSeconds?: number | null; totalFuelSeconds?: number | null };
    const seconds = typeof live.fuelSeconds === 'number' ? live.fuelSeconds
      : typeof live.totalFuelSeconds === 'number' && typeof furnace.fuel === 'number'
        ? live.totalFuelSeconds * furnace.fuel : 0;
    const progress = typeof furnace.progress === 'number' ? Math.max(0, Math.min(1, furnace.progress)) : 0;
    return Math.max(0, Math.floor((seconds + progress * secPerItem) / secPerItem));
  }

  /** 1個あたり最低これ以上の「精錬回数」がある燃料を優先（石炭・木炭と同等以上） */
  private static readonly PREFERRED_MIN_SMELTS = 8;

  private static readonly PREFERRED_FUEL_ORDER = [
    'coal',
    'charcoal',
    'coal_block',
    'lava_bucket',
    'blaze_rod',
    'dried_kelp_block',
  ] as const;

  private inventoryCount(itemName: string): number {
    return this.bot.inventory
      .items()
      .filter((i) => i.name === itemName)
      .reduce((s, i) => s + i.count, 0);
  }

  private isPreferredFuel(fuelName: string): boolean {
    return this.getFuelSmelts(fuelName) >= StartSmelting.PREFERRED_MIN_SMELTS;
  }

  /** 高効率燃料を優先し、無ければ所持する有効な燃料を使う。 */
  private resolveFuelItem(requested: string): { fuelItem: string; note?: string } | { error: string } {
    const reqSmelts = this.getFuelSmelts(requested);
    if (reqSmelts <= 0) {
      return { error: `${requested}は有効な燃料ではありません` };
    }

    if (this.inventoryCount(requested) > 0 && this.isPreferredFuel(requested)) {
      return { fuelItem: requested };
    }

    for (const name of StartSmelting.PREFERRED_FUEL_ORDER) {
      if (this.inventoryCount(name) > 0) {
        if (name !== requested) {
          return {
            fuelItem: name,
            note: `燃料は${requested}の指定でしたが、効率のため${name}を使用しました`,
          };
        }
        return { fuelItem: name };
      }
    }

    const lastTool = StartSmelting.EQUIPMENT_FUELS.has(requested) && this.inventoryCount(requested) <= 1;
    if (this.inventoryCount(requested) > 0 && !lastTool) {
      return { fuelItem: requested };
    }

    const fallback = this.bot.inventory
      .items()
      .filter((item) => item.count > 0 && this.isExpendableFuel(item.name))
      .sort((a, b) => this.getFuelSmelts(b.name) - this.getFuelSmelts(a.name))[0];
    if (fallback) {
      return {
        fuelItem: fallback.name,
        note: lastTool
          ? `${requested}は作業に必要な最後の道具のため燃料にせず、所持する${fallback.name}を使用しました`
          : `燃料${requested}を持っていないため、所持する${fallback.name}を使用しました`,
      };
    }

    return {
      error: lastTool
        ? `${requested}は作業に必要な最後の道具のため燃料にしません。石炭・木炭を採掘するか、板材・原木・棒などを用意してください。`
        : '燃料として使えるアイテムを持っていません。石炭・木炭を採掘するか、板材・原木・棒などを用意してください。',
    };
  }

  async runImpl(
    x: number,
    y: number,
    z: number,
    inputItem: string,
    fuelItem: string,
    count: number = 1
  ) {
    try {
      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      // かまどかチェック
      if (
        !block.name.includes('furnace') &&
        !block.name.includes('smoker') &&
        !block.name.includes('blast_furnace')
      ) {
        return {
          success: false,
          result: `${block.name}はかまどではありません`,
          failureType: 'invalid_target_type',
          recoverable: true,
        };
      }

      // Out of reach: walk to a stand it can be opened from first (utils/furnaceReach).
      const approach = await approachFurnace(this.bot, pos, (...args) => this.callSkill('move-to', ...args));
      if (approach) return approach;

      if (!this.isValidFuel(fuelItem)) {
        return {
          success: false,
          result: `${fuelItem}は有効な燃料ではありません。coal, charcoal, coal_block, lava_bucket, blaze_rod, dried_kelp_block, 板材, 原木, 棒など`,
          failureType: 'invalid_fuel',
          recoverable: true,
        };
      }

      let furnace;
      try {
        furnace = await this.bot.openFurnace(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }
      if (!furnace) {
        return {
          success: false,
          result: 'かまどを開けませんでした',
          failureType: 'interaction_failed',
          recoverable: true,
        };
      }

      try {
        // スロットの状態を確認
        const currentInput = furnace.inputItem();
        const currentFuel = furnace.fuelItem();
        const currentOutput = furnace.outputItem();
        const isBlastOrSmoker = block.name.includes('blast_furnace') || block.name.includes('smoker');
        const secPerItem = isBlastOrSmoker ? 5 : 10;
        const burningSmelts = this.remainingBurningSmelts(furnace, secPerItem);

        // 材料スロットに別のアイテムが入っているかチェック
        if (currentInput && currentInput.name !== inputItem) {
          furnace.close();
          // Busy with something else: another furnace within reach takes this batch (iron in one, meat in the other); else
          // where one is, or how to make one, and raw food is queued behind the batch here.
          const elsewhere = await this.otherFurnace(pos, inputItem, fuelItem, count, currentInput);
          return { ...elsewhere, result: `${elsewhere.result}（このかまどを空けるなら withdraw-from-furnace slot="input"）` };
        }

        // 既存燃料はプレイヤーの所持品に無くても使用できる。異なる
        // 燃料を重ねて投入できないので、まずかまど内の燃料を使う。
        if (currentFuel && !this.isValidFuel(currentFuel.name)) {
          furnace.close();
          return {
            success: false,
            result: `燃料スロットに別のアイテムがあります: ${currentFuel.name} x${currentFuel.count}。先に取り出してください（withdraw-from-furnace slot="fuel"）`,
            failureType: 'slot_conflict',
            recoverable: true,
          };
        }
        const resolved = this.resolveFuelItem(fuelItem);
        let fuelSwitchNote: string | undefined;
        if (currentFuel) {
          fuelSwitchNote = currentFuel.name !== fuelItem
            ? `かまど内の${currentFuel.name}を先に使用します` : undefined;
          fuelItem = currentFuel.name;
        } else if ('error' in resolved && burningSmelts < 1) {
          furnace.close();
          return {
            success: false,
            result: resolved.error,
            failureType: 'material_missing',
            recoverable: true,
          };
        } else if (!('error' in resolved)) {
          fuelItem = resolved.fuelItem;
          fuelSwitchNote = resolved.note;
        } else {
          fuelSwitchNote = 'かまど内で燃焼中の燃料を使用します';
        }
        let fuelItems = this.bot.inventory.items().filter((item) => item.name === fuelItem);

        // 出力スロットにアイテムがあれば自動回収
        let withdrawnOutput: { name: string; count: number } | null = null;
        if (currentOutput) {
          try {
            await furnace.takeOutput();
            withdrawnOutput = {
              name: currentOutput.name,
              count: currentOutput.count,
            };
          } catch {
            furnace.close();
            return {
              success: false,
              result: `完成品スロットにアイテムがあります: ${currentOutput.name} x${currentOutput.count}。取り出しに失敗しました（withdraw-from-furnace slot="output"で手動取り出し）`,
              failureType: 'slot_conflict',
              recoverable: true,
            };
          }
        }

        // かまどに同じ材料が既にある場合は「再開モード」（燃料追加のみ）
        const alreadyInFurnace = currentInput?.name === inputItem ? currentInput.count : 0;
        const isResumeMode = alreadyInFurnace > 0;

        // 精錬対象数: かまど内の分 + 新規投入分
        let totalSmeltCount: number;
        let newInputCount = 0;

        if (isResumeMode) {
          // 再開モード: かまど内の材料を精錬する。追加分があればインベントリからも投入
          const inputItems = this.bot.inventory
            .items()
            .filter((item) => item.name === inputItem);
          const inventoryCount = inputItems.reduce((sum, item) => sum + item.count, 0);
          const wantToAdd = Math.max(0, count - alreadyInFurnace);
          newInputCount = Math.min(wantToAdd, inventoryCount);

          // 材料スロットの空き容量チェック
          const maxStack = 64;
          const availableSpace = maxStack - alreadyInFurnace;
          newInputCount = Math.min(newInputCount, availableSpace);

          totalSmeltCount = Math.min(count, alreadyInFurnace + newInputCount);

          if (newInputCount > 0) {
            await furnace.putInput(inputItems[0].type, null, newInputCount);
          }
        } else {
          // 新規モード: インベントリから材料を投入
          const inputItems = this.bot.inventory
            .items()
            .filter((item) => item.name === inputItem);

          if (inputItems.length === 0) {
            furnace.close();
            return {
              success: false,
              result: `${inputItem}を持っていません`,
              failureType: 'material_missing',
              recoverable: true,
            };
          }

          const inventoryCount = inputItems.reduce((sum, item) => sum + item.count, 0);
          if (inventoryCount < count) {
            furnace.close();
            return {
              success: false,
              result: `${inputItem}が不足しています（必要: ${count}個、所持: ${inventoryCount}個）`,
              failureType: 'material_missing',
              recoverable: true,
            };
          }

          totalSmeltCount = count;
          newInputCount = count;
          await furnace.putInput(inputItems[0].type, null, count);
        }

        // 必要な燃料数を計算（既存燃料の残り精錬能力を考慮）
        const existingFuelSmelts = burningSmelts + (currentFuel
          ? this.getFuelSmelts(currentFuel.name) * currentFuel.count
          : 0);
        const neededSmelts = Math.max(0, totalSmeltCount - existingFuelSmelts);
        // The fuel slot holds one item type. When the chosen type cannot cover
        // the batch, use the held type that smelts the most instead of leaving
        // input that silently never finishes.
        if (!currentFuel && neededSmelts > 0) {
          const capacity = (name: string) => this.getFuelSmelts(name) * this.bot.inventory.items()
            .filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
          if (capacity(fuelItem) < neededSmelts) {
            const best = [...new Set(this.bot.inventory.items().map(item => item.name))]
              .filter(name => name !== inputItem && this.isExpendableFuel(name))
              .sort((left, right) => capacity(right) - capacity(left))[0];
            if (best && capacity(best) > capacity(fuelItem)) {
              fuelSwitchNote = `${fuelItem}では約${Math.floor(capacity(fuelItem))}個分のため、より多く精錬できる所持燃料${best}を使用しました`;
              fuelItem = best;
              fuelItems = this.bot.inventory.items().filter((item) => item.name === fuelItem);
            }
          }
        }
        const smeltsPerFuel = this.getFuelSmelts(fuelItem);
        const neededFuelCount = neededSmelts > 0
          ? Math.ceil(neededSmelts / smeltsPerFuel)
          : 0;

        // 燃料投入。足りない場合も、投入済みの燃料で進む分を追跡する。
        let fuelToAdd = 0;
        if (neededFuelCount > 0) {
          // An explicitly requested tool may be burned, but never the last one.
          const fuelAvailable = fuelItems.reduce((sum, item) => sum + item.count, 0)
            - (StartSmelting.EQUIPMENT_FUELS.has(fuelItem) ? 1 : 0);
          fuelToAdd = Math.min(neededFuelCount, fuelAvailable);
          if (fuelToAdd > 0) await furnace.putFuel(fuelItems[0].type, null, fuelToAdd);
        }

        furnace.close();

        // 精錬時間の見積もり（通常かまど: 10秒/個, ブラストファーネス/スモーカー: 5秒/個）
        const fueledSmelts = Math.min(totalSmeltCount,
          Math.floor(existingFuelSmelts + fuelToAdd * smeltsPerFuel));
        if (fueledSmelts < 1) {
          return {
            success: false,
            result: `材料はかまどにありますが、燃料${fuelItem}が不足しています。石炭・木炭、板材、原木、棒などの有効な燃料を追加してください`,
            failureType: 'material_missing',
            recoverable: true,
          };
        }
        const estimatedSec = fueledSmelts * secPerItem;

        // Raw meat carried is cooked next in the same furnace: queued behind this batch, put in when the batch is taken out
        // (withdraw-from-furnace). Run 16 smelted iron twice with raw mutton and chicken in the pack and ate them raw (a third of
        // the food). Not in a blast furnace (it smelts no food); a smoker takes nothing but food anyway.
        const queued = block.name.includes('blast_furnace') ? []
          : [...new Set(this.bot.inventory.items().filter(item => RAW_FOOD.has(item.name) && item.name !== inputItem).map(item => item.name))];
        // A second furnace within reach: say it can cook now, in one call (the queue stays as the fallback).
        const besideFree = queued.length ? this.freeFurnaces(pos, queued[0]).find(spot => spot.distance <= 4.5) : undefined;
        const queuedNote = queued.length
          ? `。手持ちの生の食べ物（${queued.map(name => `${name}×${this.inventoryCount(name)}`).join('、')}）は、この精錬の後に同じかまどで焼くよう並べました（withdraw-from-furnace で取り出す時に自動で入れます。燃料は手持ちから）`
            + (besideFree ? `。隣の空いている${besideFree.name}(${besideFree.position.x}, ${besideFree.position.y}, ${besideFree.position.z})なら今すぐ焼けます: start-smelting inputItem=${queued[0]}` : '')
          : '';

        // 部分的に燃料が足りなくても、実際に進められる分を表示する。
        this.registerActiveFurnace(x, y, z, inputItem, fueledSmelts, estimatedSec, totalSmeltCount - fueledSmelts, queued);

        if (fueledSmelts < totalSmeltCount) {
          const otherFuels = [...new Set(this.bot.inventory.items().map(item => item.name))]
            .filter(name => name !== inputItem && name !== fuelItem && this.isExpendableFuel(name))
            .map(name => `${name} x${this.bot.inventory.items().filter(item => item.name === name)
              .reduce((sum, item) => sum + item.count, 0)}`);
          let resultMsg = `${inputItem} x${totalSmeltCount}中、かまど内と追加の${fuelItem}で約${fueledSmelts}個のみ精錬可能（約${estimatedSec}秒）。残り${totalSmeltCount - fueledSmelts}個には燃料追加が必要です（燃料なしでは精錬されません）。`
            + (otherFuels.length
              ? `所持中の別燃料 ${otherFuels.join(', ')} は、燃料スロットが空いた後に同じかまどでstart-smelting（燃料追加の再開）すれば投入できます`
              : '石炭・木炭・木材などの燃料を入手して同じかまどで再開してください')
            + `。完成した分はwithdraw-from-furnace(slot:"output", waitForCompletion:false)で回収できます`;
          if (withdrawnOutput) {
            resultMsg += `。※完成品スロットから${withdrawnOutput.name} x${withdrawnOutput.count}を自動回収しました`;
          }
          if (fuelSwitchNote) resultMsg = `${fuelSwitchNote}。${resultMsg}`;
          return { success: true, result: resultMsg + queuedNote + this.meanwhileNote() };
        }

        let resultMsg: string;
        if (isResumeMode) {
          resultMsg = `精錬を再開しました。かまど内${inputItem} x${alreadyInFurnace}`;
          if (newInputCount > 0) resultMsg += ` + 追加${newInputCount}`;
          resultMsg += `（計${totalSmeltCount}個、燃料: ${fuelItem}）。約${estimatedSec}秒で完了予定`;
        } else {
          resultMsg = `${inputItem} x${totalSmeltCount}の精錬を開始しました（燃料: ${fuelItem}、追加${fuelToAdd}個）。約${estimatedSec}秒で完了予定`;
        }
        if (fuelSwitchNote) {
          resultMsg = `${fuelSwitchNote}。${resultMsg}`;
        }
        if (withdrawnOutput) {
          resultMsg += `。※完成品スロットから${withdrawnOutput.name} x${withdrawnOutput.count}を自動回収しインベントリに入れました`;
        }
        resultMsg += `。精錬は独立して進むので、待たずに（wait-timeで待たずに）次の作業（採掘など）へ進み、終わった頃に同じかまどから取り出してください。${process.env.MINEBOT_COMMON_FCA === 'on' ? '' : 'get-background-jobsで推定残り時間を確認できます。'}withdraw-from-furnace は残りが約20秒以内なら完了を待ち、長ければ待たずに完成済みの分だけ回収して残り時間を返す（waitForCompletion=true で最後まで待つ）${queuedNote}${this.meanwhileNote()}`;

        return {
          success: true,
          result: resultMsg,
        };
      } catch (error: any) {
        furnace.close();
        throw error;
      }
    } catch (error: any) {
      return {
        success: false,
        result: `精錬開始エラー: ${error.message}`,
        failureType: 'smelting_failed',
        recoverable: true,
      };
    }
  }
  /** Set while a busy furnace's batch is being put into the one beside it (`otherFurnace`). */
  private hopping = false;

  /** Furnaces that take this input: any furnace; a smoker for food only; a blast furnace for ores and metal only. */
  private furnaceKindsFor(inputItem: string): string[] {
    const food = RAW_FOOD.has(inputItem) || (FALLBACK_FOOD_POINTS[inputItem] ?? 0) > 0;
    return ['furnace', ...(food ? ['smoker'] : ['blast_furnace'])];
  }

  /** A furnace that is not working on a batch the body put in (`activeFurnaces`), other than the one at `except`, nearest first. */
  private freeFurnaces(except: Vec3, inputItem: string): Array<{ position: Vec3; name: string; distance: number }> {
    const now = Date.now();
    const busy = (p: Vec3) => (this.bot.activeFurnaces ?? []).some(f => f.pos.x === p.x && f.pos.y === p.y && f.pos.z === p.z && f.readyAt > now);
    let hits: Array<{ name: string; position: Vec3; distance: number }> = [];
    try { hits = scanLoadedBlocks(this.bot as any, this.furnaceKindsFor(inputItem), { maxDistance: FREE_FURNACE_RANGE, maxHits: 8 }).hits; } catch { hits = []; }
    const here = this.bot.entity.position;
    return hits.filter(hit => !hit.position.equals(except) && !busy(hit.position))
      .map(hit => ({ ...hit, distance: hit.position.offset(0.5, 0.5, 0.5).distanceTo(here) }))
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * The furnace asked for is busy with something else. Within reach, another furnace takes the batch at once (iron in one and meat
   * in the other: the owner's two furnaces, 2026-10-20). Further off, where it is. None: raw food is queued behind the batch here,
   * and how to set down a second furnace is said. Null only when there is nothing to say beyond the plain conflict.
   */
  private async otherFurnace(pos: Vec3, inputItem: string, fuelItem: string, count: number,
    busyWith: { name: string; count: number }): Promise<SkillResult> {
    const free = this.freeFurnaces(pos, inputItem);
    // One hop only: a furnace someone else filled is not in `activeFurnaces`, and two of those would send the call back and forth.
    const reachable = this.hopping ? undefined : free.find(spot => spot.distance <= 4.5);
    const busyNote = `かまど(${pos.x}, ${pos.y}, ${pos.z})は ${busyWith.name}×${busyWith.count} を精錬中`;
    if (reachable) {
      this.hopping = true;
      let result: SkillResult;
      try { result = await this.runImpl(reachable.position.x, reachable.position.y, reachable.position.z, inputItem, fuelItem, count); }
      finally { this.hopping = false; }
      return { ...result, result: `${busyNote}のため、隣の空いている${reachable.name}(${reachable.position.x}, ${reachable.position.y}, ${reachable.position.z})を使いました。${result.result}` };
    }
    const far = free[0];
    let queued = '';
    if (RAW_FOOD.has(inputItem)) {
      const job = (this.bot.activeFurnaces ?? []).find(f => f.pos.x === pos.x && f.pos.y === pos.y && f.pos.z === pos.z);
      if (job && !(job.then ?? []).includes(inputItem)) { job.then = [...(job.then ?? []), inputItem]; queued = `。${inputItem}はこの精錬の後に同じかまどで焼くよう並べました`; }
      else if (job) queued = `。${inputItem}はこの精錬の後に焼くよう並んでいます`;
    }
    const cobble = this.inventoryCount('cobblestone') + this.inventoryCount('cobbled_deepslate') + this.inventoryCount('blackstone');
    const advice = far
      ? `空いている${far.name}が(${far.position.x}, ${far.position.y}, ${far.position.z})、約${Math.round(far.distance)}mにあります。move-to で近づいてから start-smelting`
      : `2個目のかまどを置けば並行して焼けます（丸石8個で craft-one furnace → place-block-at。手持ちの丸石${cobble}個）`;
    return { success: false, failureType: 'slot_conflict', recoverable: true, result: `${busyNote}です。${advice}${queued}` };
  }

  /** What could be done while the furnace works: the nearest ores in the loaded chunks, said as places to mine. */
  private meanwhileNote(): string {
    const ores = nearestOres(this.bot as any, MEANWHILE_RANGE);
    return ores.length ? `。待たずにできること: ${ores.map(ore => `近くの${ore}`).join('・')} を mine-block で掘る` : '';
  }

  private registerActiveFurnace(
    x: number, y: number, z: number,
    item: string, count: number, estimatedSec: number, unfueledCount = 0, then: string[] = [],
  ): void {
    if (!this.bot.activeFurnaces) this.bot.activeFurnaces = [];
    // 同一座標の古いエントリを置換
    this.bot.activeFurnaces = this.bot.activeFurnaces.filter(
      f => !(f.pos.x === x && f.pos.y === y && f.pos.z === z),
    );
    this.bot.activeFurnaces.push({
      pos: { x, y, z },
      item,
      count,
      readyAt: Date.now() + estimatedSec * 1000,
      startedAt: Date.now(),
      dimension: String(this.bot.game?.dimension ?? 'unknown'),
      ...(unfueledCount > 0 ? { unfueledCount } : {}),
      ...(then.length ? { then } : {}),
    });
  }
}

export default StartSmelting;
