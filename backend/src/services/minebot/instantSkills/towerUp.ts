import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

const log = createLogger('Minebot:Skill:towerUp');

const PLACEABLE_BLOCKS = [
  'cobblestone', 'dirt', 'stone', 'netherrack',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
  'deepslate', 'cobbled_deepslate', 'sandstone', 'andesite',
  'diorite', 'granite', 'tuff', 'sand', 'gravel',
];

function isEmptyBlock(block: any): boolean {
  return !block || block.boundingBox === 'empty';
}

/**
 * 原子的スキル: 直上登り（タワー）
 * ジャンプしながら足元にブロックを設置して垂直に登る。
 */
class TowerUp extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'tower-up';
    this.description = '真上に登ります（直上掘り対応）。頭上にブロックがあれば自動で掘削してから登るため、地下から地上へ垂直に脱出する「直上掘り」にも使えます。高さ1〜20を指定。';
    this.params = [
      {
        name: 'height',
        type: 'number',
        description: '登るブロック数（1〜20、デフォルト1）',
        required: false,
        default: 1,
      },
      {
        name: 'blockName',
        type: 'string',
        description: '使用するブロック名（省略時はインベントリから自動選択）',
        required: false,
      },
    ];
  }

  async runImpl(height?: number, blockName?: string) {
    const targetHeight = Math.max(1, Math.min(20, Math.round(height ?? 1)));
    log.info(`🗼 直上登り開始: 高さ ${targetHeight}ブロック`);

    const item = blockName
      ? this.bot.inventory.items().find(i => i.name === blockName)
      : this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));

    if (!item) {
      return {
        success: false,
        result: `インベントリに設置可能なブロックがありません。${blockName ? `${blockName}を入手してください。` : `必要: ${PLACEABLE_BLOCKS.slice(0, 5).join(', ')} など`}`,
        failureType: 'missing_item',
        recoverable: true,
      };
    }

    if (item.count < targetHeight) {
      return {
        success: false,
        result: `${item.name} が ${item.count}個しかなく、高さ${targetHeight}には足りません`,
        failureType: 'missing_item',
        recoverable: true,
      };
    }

    try {
      await this.bot.equip(item, 'hand');
    } catch (e) {
      return {
        success: false,
        result: `ブロック(${item.name})の装備に失敗: ${e instanceof Error ? e.message : e}`,
        failureType: 'equip_failed',
        recoverable: true,
      };
    }

    const startY = Math.floor(this.bot.entity.position.y);
    let placed = 0;

    for (let step = 0; step < targetHeight; step++) {
      if (this.shouldInterrupt()) break;

      // 設置用ブロックを装備し直す（掘削後にツールのままになっている可能性）
      const currentItem = this.bot.inventory.items().find(i => i.name === item.name);
      if (!currentItem) {
        const alt = this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));
        if (!alt) {
          log.warn(`⚠ 設置用ブロックが尽きた: ${placed}/${targetHeight}`);
          break;
        }
        try { await this.bot.equip(alt, 'hand'); } catch { /* ignore */ }
      } else if (this.bot.heldItem?.name !== currentItem.name) {
        try { await this.bot.equip(currentItem, 'hand'); } catch { /* ignore */ }
      }

      const ok = await this.tryTowerOneBlock();
      if (!ok) {
        log.warn(`⚠ 直上登り: ステップ ${step + 1}/${targetHeight} 失敗`);
        if (placed === 0) {
          return {
            success: false,
            result: `直上登り失敗: 1ブロック目に失敗（現在Y=${Math.floor(this.bot.entity.position.y)}）。頭上に掘削不可のブロックがあるか、設置用ブロックが不足している可能性`,
            failureType: 'place_failed',
            recoverable: true,
          };
        }
        break;
      }
      placed++;

      if (step + 1 < targetHeight) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    const finalY = Math.floor(this.bot.entity.position.y);
    const actualRise = finalY - startY;
    const pos = this.bot.entity.position;
    const posStr = `(${Math.floor(pos.x)}, ${finalY}, ${Math.floor(pos.z)})`;

    if (placed === targetHeight) {
      return {
        success: true,
        result: `直上登り完了: ${placed}ブロック上昇（Y: ${startY} → ${finalY}）現在位置: ${posStr}`,
      };
    }

    return {
      success: placed > 0,
      result: `直上登り: ${placed}/${targetHeight}ブロック設置成功（Y: ${startY} → ${finalY}）現在位置: ${posStr}。残り${targetHeight - placed}ブロックは失敗しました。`,
      failureType: placed === 0 ? 'place_failed' : undefined,
      recoverable: true,
    };
  }

  private static readonly DANGEROUS_BLOCKS = new Set([
    'water', 'flowing_water', 'lava', 'flowing_lava',
  ]);
  private static readonly GRAVITY_BLOCKS = new Set([
    'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
    'anvil', 'chipped_anvil', 'damaged_anvil',
    'dragon_egg', 'pointed_dripstone',
  ]);

  /**
   * 頭上のブロックを掘る（ジャンプ前に空間を確保する）。
   * 掘る前にその上のブロックが危険（水・溶岩）や落下ブロック（砂・砂利）でないか確認する。
   */
  private async clearAbove(): Promise<boolean> {
    const pos = this.bot.entity.position;
    // +2 = ジャンプ時の頭の位置、+3 = その上（着地時の頭の位置）
    for (const dy of [2, 3]) {
      const block = this.bot.blockAt(pos.offset(0, dy, 0));
      if (!block) continue;

      // そのブロック自体が液体なら中断
      if (TowerUp.DANGEROUS_BLOCKS.has(block.name)) {
        log.warn(`⚠ 頭上に ${block.name}(Y=${block.position.y}) — 直上掘り中断`);
        return false;
      }

      // 空気・草・花・松明など当たり判定のないブロックはスキップ
      if (isEmptyBlock(block)) continue;

      if (!block.diggable || PROTECTED_UTILITY_BLOCKS.has(block.name)) {
        log.warn(`⚠ 頭上の ${block.name}(Y=${block.position.y}) は${PROTECTED_UTILITY_BLOCKS.has(block.name) ? '保護対象' : '掘削不可'}`);
        return false;
      }

      // 掘った後に上から流れてくるもの・落ちてくるものをチェック
      const above = this.bot.blockAt(pos.offset(0, dy + 1, 0));
      if (above) {
        if (TowerUp.DANGEROUS_BLOCKS.has(above.name)) {
          log.warn(`⚠ ${block.name}(Y=${block.position.y}) の上に ${above.name} — 掘ると流入するため中断`);
          return false;
        }
        if (TowerUp.GRAVITY_BLOCKS.has(above.name)) {
          log.warn(`⚠ ${block.name}(Y=${block.position.y}) の上に ${above.name} — 掘ると落下するため中断`);
          return false;
        }
      }

      log.info(`⛏️ 頭上の ${block.name}(Y=${block.position.y}) を掘削`);

      const tool = this.findBestToolForBlock(block);
      if (tool) {
        try { await this.bot.equip(tool, 'hand'); } catch { /* ignore */ }
      }

      try {
        await this.bot.dig(block);
      } catch (e) {
        log.warn(`⚠ 頭上ブロック掘削失敗: ${e instanceof Error ? e.message : e}`);
        return false;
      }

      // 掘った後に設置用ブロックを再装備
      const placeItem = this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));
      if (placeItem) {
        try { await this.bot.equip(placeItem, 'hand'); } catch { /* ignore */ }
      }
    }
    return true;
  }

  private findBestToolForBlock(block: any): any {
    const items = this.bot.inventory.items();
    const name = block.name.toLowerCase();

    let toolNames: string[] = [];
    if (['stone', 'ore', 'cobble', 'deepslate', 'brick', 'obsidian', 'concrete',
         'terracotta', 'basalt', 'netherrack', 'granite', 'diorite', 'andesite', 'tuff']
        .some(kw => name.includes(kw))) {
      toolNames = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
    } else if (['dirt', 'sand', 'gravel', 'clay', 'snow', 'soul'].some(kw => name.includes(kw))) {
      toolNames = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'];
    } else if (['log', 'wood', 'plank', 'fence'].some(kw => name.includes(kw))) {
      toolNames = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
    }

    for (const tn of toolNames) {
      const t = items.find(i => i.name === tn);
      if (t) return t;
    }
    return null;
  }

  /**
   * 1ブロック分の直上登り: jump → apex付近で足元にplaceBlock
   * 成功なら true、失敗なら false
   */
  private async tryTowerOneBlock(): Promise<boolean> {
    // 頭上にブロックがあれば先に掘る
    if (!await this.clearAbove()) return false;

    const below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (!below || isEmptyBlock(below)) {
      log.warn(`⚠ 足元にブロックがありません（Y=${Math.floor(this.bot.entity.position.y)}）`);
      return false;
    }

    const minFeetY = below.position.y + 1 + 0.26;

    this.bot.setControlState('jump', true);

    let placed = false;
    const maxAttempts = 28;
    const retryMs = 35;

    for (let i = 0; i < maxAttempts && !placed; i++) {
      await new Promise(r => setTimeout(r, retryMs));

      const y = this.bot.entity.position.y;
      const vy = this.bot.entity.velocity.y;

      if (y < minFeetY) continue;
      if (vy > 0.14 || vy < -0.45) continue;

      const blockToPlaceOn = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (!blockToPlaceOn || !isEmptyBlock(blockToPlaceOn)) {
        continue;
      }

      const refBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -2, 0));
      if (!refBlock || isEmptyBlock(refBlock)) continue;

      try {
        await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        placed = true;
      } catch {
        /* retry next tick */
      }
    }

    this.bot.setControlState('jump', false);

    if (!placed) {
      await new Promise(r => setTimeout(r, 300));

      const belowRetry = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (!belowRetry || isEmptyBlock(belowRetry)) return false;

      const minFeetYRetry = belowRetry.position.y + 1 + 0.26;

      const itemNow = this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));
      if (itemNow) {
        try { await this.bot.equip(itemNow, 'hand'); } catch { /* ignore */ }
      }

      this.bot.setControlState('jump', true);
      for (let j = 0; j < maxAttempts && !placed; j++) {
        await new Promise(r => setTimeout(r, retryMs));
        const y2 = this.bot.entity.position.y;
        const vy2 = this.bot.entity.velocity.y;
        if (y2 < minFeetYRetry || vy2 > 0.14 || vy2 < -0.45) continue;

        const blockToPlaceOn2 = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
        if (!blockToPlaceOn2 || !isEmptyBlock(blockToPlaceOn2)) continue;

        const refBlock2 = this.bot.blockAt(this.bot.entity.position.offset(0, -2, 0));
        if (!refBlock2 || isEmptyBlock(refBlock2)) continue;

        try {
          await this.bot.placeBlock(refBlock2, new Vec3(0, 1, 0));
          placed = true;
        } catch { /* retry */ }
      }
      this.bot.setControlState('jump', false);
    }

    if (placed) {
      await new Promise(r => setTimeout(r, 200));
    }

    return placed;
  }
}

export default TowerUp;
