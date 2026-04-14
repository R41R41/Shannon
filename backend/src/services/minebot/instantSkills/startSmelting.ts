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
          '燃料。推奨: coal または charcoal（いずれも1個8回分）。インベントリに石炭系がある場合は板材・棒より自動で優先する。石炭・木炭も高効率燃料も無いときは失敗し、採掘を促す（板材だけで代用しない）',
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

  /**
   * 石炭・木炭・高効率燃料を優先。板材・棒・原木のみのときは代用せず失敗させる。
   */
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

    return {
      error:
        '石炭・木炭（または coal_block / lava_bucket / blaze_rod / dried_kelp_block）を持っていません。' +
        '板材・棒・原木だけで代用しません。coal_ore を mine-block や find-and-mine-ore で掘るか、原木を木炭に精錬してから再実行してください。',
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

      const resolved = this.resolveFuelItem(fuelItem);
      if ('error' in resolved) {
        const validFuels =
          'coal, charcoal, coal_block, lava_bucket, blaze_rod, dried_kelp_block（板材・原木・棒は不可：先に石炭を掘る）';
        const base = resolved.error.includes('有効な燃料ではありません')
          ? `${fuelItem}は有効な燃料ではありません。${validFuels}`
          : resolved.error;
        return {
          success: false,
          result: base,
          failureType: resolved.error.includes('有効な燃料ではありません') ? 'invalid_fuel' : 'material_missing',
          recoverable: true,
        };
      }

      fuelItem = resolved.fuelItem;
      const fuelSwitchNote = resolved.note;

      const fuelItems = this.bot.inventory
        .items()
        .filter((item) => item.name === fuelItem);

      if (fuelItems.length === 0) {
        return {
          success: false,
          result: `燃料${fuelItem}を持っていません`,
          failureType: 'material_missing',
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

        // 燃料スロットに別のアイテムが入っているかチェック
        if (currentFuel && currentFuel.name !== fuelItem) {
          furnace.close();
          return {
            success: false,
            result: `燃料スロットに別のアイテムがあります: ${currentFuel.name} x${currentFuel.count}。先に取り出してください（withdraw-from-furnace slot="fuel"）`,
            failureType: 'slot_conflict',
            recoverable: true,
          };
        }

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
        const smeltsPerFuel = this.getFuelSmelts(fuelItem);
        const existingFuelSmelts = currentFuel
          ? this.getFuelSmelts(currentFuel.name) * currentFuel.count
          : 0;
        const neededSmelts = Math.max(0, totalSmeltCount - existingFuelSmelts);
        const neededFuelCount = neededSmelts > 0
          ? Math.ceil(neededSmelts / smeltsPerFuel)
          : 0;

        // 燃料投入
        if (neededFuelCount > 0) {
          const fuelAvailable = fuelItems.reduce((sum, item) => sum + item.count, 0);
          const fuelToAdd = Math.min(neededFuelCount, fuelAvailable);

          if (fuelToAdd === 0) {
            furnace.close();
            return {
              success: false,
              result:
                `燃料${fuelItem}が不足しています（必要: ${neededFuelCount}個、所持: 0個）。` +
                '石炭・木炭を追加するか、coal_ore を採掘してください（板材・棒への切り替えはしません）。',
              failureType: 'material_missing',
              recoverable: true,
            };
          }

          await furnace.putFuel(fuelItems[0].type, null, fuelToAdd);

          if (fuelToAdd < neededFuelCount) {
            // 燃料が足りないが部分的に投入
            const partialSmelts = Math.floor(existingFuelSmelts + fuelToAdd * smeltsPerFuel);
            furnace.close();
            const isBlastOrSmoker =
              block!.name.includes('blast_furnace') ||
              block!.name.includes('smoker');
            const secPerItem = isBlastOrSmoker ? 5 : 10;
            let resultMsg = `${inputItem} x${totalSmeltCount}中、燃料が${fuelToAdd}個しかないため約${partialSmelts}個のみ精錬可能（約${partialSmelts * secPerItem}秒）。残りは燃料追加後に再度start-smeltingしてください`;
            if (withdrawnOutput) {
              resultMsg += `。※完成品スロットから${withdrawnOutput.name} x${withdrawnOutput.count}を自動回収しました`;
            }
            if (fuelSwitchNote) {
              resultMsg = `${fuelSwitchNote}。${resultMsg}`;
            }
            return {
              success: true,
              result: resultMsg,
            };
          }
        }

        furnace.close();

        // 精錬時間の見積もり（通常かまど: 10秒/個, ブラストファーネス/スモーカー: 5秒/個）
        const isBlastOrSmoker =
          block!.name.includes('blast_furnace') ||
          block!.name.includes('smoker');
        const secPerItem = isBlastOrSmoker ? 5 : 10;
        const estimatedSec = totalSmeltCount * secPerItem;

        // かまど追跡に登録
        this.registerActiveFurnace(x, y, z, inputItem, totalSmeltCount, estimatedSec);

        let resultMsg: string;
        if (isResumeMode) {
          resultMsg = `精錬を再開しました。かまど内${inputItem} x${alreadyInFurnace}`;
          if (newInputCount > 0) resultMsg += ` + 追加${newInputCount}`;
          resultMsg += `（計${totalSmeltCount}個、燃料: ${fuelItem}）。約${estimatedSec}秒で完了予定`;
        } else {
          resultMsg = `${inputItem} x${totalSmeltCount}の精錬を開始しました（燃料: ${fuelItem} x${neededFuelCount}）。約${estimatedSec}秒で完了予定`;
        }
        if (fuelSwitchNote) {
          resultMsg = `${fuelSwitchNote}。${resultMsg}`;
        }
        if (withdrawnOutput) {
          resultMsg += `。※完成品スロットから${withdrawnOutput.name} x${withdrawnOutput.count}を自動回収しインベントリに入れました`;
        }
        resultMsg += `。【重要】wait-time や check-furnace は不要。withdraw-from-furnace(slot="output") を呼べば精錬完了まで自動で待って取り出す`;

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
    item: string, count: number, estimatedSec: number,
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
    });
  }
}

export default StartSmelting;
