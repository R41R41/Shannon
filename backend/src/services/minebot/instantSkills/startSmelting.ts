import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

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

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 4.5) {
        return {
          success: false,
          result: `かまどが遠すぎます（距離: ${distance.toFixed(1)}m）`,
          failureType: 'distance_too_far',
          recoverable: true,
        };
      }

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
          return {
            success: false,
            result: `材料スロットに別のアイテムがあります: ${currentInput.name} x${currentInput.count}。先に取り出してください（withdraw-from-furnace slot="input"）`,
            failureType: 'slot_conflict',
            recoverable: true,
          };
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

        // 部分的に燃料が足りなくても、実際に進められる分を表示する。
        this.registerActiveFurnace(x, y, z, inputItem, fueledSmelts, estimatedSec, totalSmeltCount - fueledSmelts);

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
          return { success: true, result: resultMsg };
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
        resultMsg += `。精錬は独立して進むので、待たずに（wait-timeで待たずに）次の作業（採掘など）へ進み、終わった頃に同じかまどから取り出してください。get-background-jobsで推定残り時間を確認できます。withdraw-from-furnace は残りが約20秒以内なら完了を待ち、長ければ待たずに完成済みの分だけ回収して残り時間を返す（waitForCompletion=true で最後まで待つ）`;

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
  private registerActiveFurnace(
    x: number, y: number, z: number,
    item: string, count: number, estimatedSec: number, unfueledCount = 0,
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
    });
  }
}

export default StartSmelting;
