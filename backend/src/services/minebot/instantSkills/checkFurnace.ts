import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

/**
 * 原子的スキル: かまどの精錬状態を確認
 */
class CheckFurnace extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'check-furnace';
    this.description = 'かまどの精錬状態（完了したか）や各スロットの中身を確認します。';
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
    ];
  }

  /** 燃料1個あたりの精錬可能数 */
  private static getFuelSmelts(fuelName: string): number {
    const FUEL_SMELTS: Record<string, number> = {
      coal: 8, charcoal: 8, coal_block: 80, lava_bucket: 100,
      blaze_rod: 12, dried_kelp_block: 20, stick: 0.5, bamboo: 0.25,
      wooden_pickaxe: 1, wooden_sword: 1, wooden_axe: 1, wooden_shovel: 1, wooden_hoe: 1,
    };
    if (FUEL_SMELTS[fuelName]) return FUEL_SMELTS[fuelName];
    if (fuelName.endsWith('_planks') || fuelName.endsWith('_slab')) return 1.5;
    if (fuelName.endsWith('_log') || fuelName.endsWith('_wood')) return 1.5;
    // 木系アイテムのデフォルト
    return 0;
  }

  async runImpl(x: number, y: number, z: number) {
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

      if (
        !block.name.includes('furnace') &&
        !block.name.includes('smoker') &&
        !block.name.includes('blast_furnace')
      ) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にある${block.name}はかまどではありません`,
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
        // 全スロットを確認
        const outputItem = furnace.outputItem();
        const inputItem = furnace.inputItem();
        const fuelItem = furnace.fuelItem();
        const fuel = furnace.fuel; // 残り燃焼時間
        const progress = furnace.progress; // 精錬進捗

        furnace.close();

        // 各スロットの状態を構築
        const slots: string[] = [];

        if (inputItem) {
          slots.push(`材料: ${inputItem.name} x${inputItem.count}`);
        } else {
          slots.push('材料: なし');
        }

        if (fuelItem) {
          slots.push(`燃料: ${fuelItem.name} x${fuelItem.count}`);
        } else {
          slots.push('燃料: なし（石炭か木炭を入れてください）');
        }

        if (outputItem) {
          slots.push(`完成品: ${outputItem.name} x${outputItem.count}（取り出し可能）`);
        } else {
          slots.push('完成品: なし');
        }

        // 燃料残能力の見積もり
        if (fuelItem) {
          const smeltsPerUnit = CheckFurnace.getFuelSmelts(fuelItem.name);
          if (smeltsPerUnit > 0) {
            const remainingCapacity = Math.floor(fuelItem.count * smeltsPerUnit);
            slots.push(`燃料残能力: 約${remainingCapacity}個分精錬可能`);
          }
        }

        // 停止状態の検知
        if (inputItem && fuel === 0 && !outputItem) {
          slots.push('⚠️ 精錬停止中: 材料はあるが燃料がなく、完成品もない。燃料を追加してください');
        } else if (inputItem && fuel === 0 && outputItem) {
          slots.push('⚠️ 燃料切れ: 完成品を回収し、燃料を追加して再開してください');
        }

        // 精錬状態を判定
        let status = '';
        if (inputItem && fuel > 0) {
          const progressPercent = Math.round(progress * 100);
          status = `精錬中（進捗: ${progressPercent}%）`;
        } else if (outputItem && !inputItem) {
          status = '精錬完了';
        } else if (!inputItem && !fuelItem && !outputItem) {
          status = '空';
        } else if (inputItem && fuel === 0) {
          status = '燃料切れ';
        } else {
          status = '待機中';
        }

        return {
          success: true,
          result: `[${status}] ${slots.join(' | ')}`,
        };
      } catch (error: any) {
        furnace.close();
        throw error;
      }
    } catch (error: any) {
      const message = String(error?.message ?? '');
      return {
        success: false,
        result: `確認エラー: ${message}`,
        failureType: message.includes('Open did not fire')
          ? 'interaction_failed'
          : 'check_failed',
        recoverable: true,
      };
    }
  }
}

export default CheckFurnace;
