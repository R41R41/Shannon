import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:digBlockAt');

/**
 * 原子的スキル: 近くのブロックを掘る（座標指定版）
 */
class DigBlockAt extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'dig-block-at';
    this.description = '指定座標のブロックを掘ります。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標',
        required: true,
      },
      {
        name: 'collect',
        type: 'boolean',
        description: '掘削後にドロップアイテムを自動回収するか（デフォルト: true）。連続で複数ブロック掘る場合はfalseにして最後にpickup-nearest-itemで回収すると効率的',
        default: true,
      },
    ];
  }

  async runImpl(x: number, y: number, z: number, collect: boolean = true) {
    try {
      // パラメータチェック
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
          failureType: 'invalid_input',
          recoverable: false,
        };
      }

      const pos = new Vec3(x, y, z);

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 5) {
        return {
          success: false,
          result: `ブロックが遠すぎます（距離: ${distance.toFixed(
            1
          )}m、5m以内に近づいてください）`,
          failureType: 'distance_too_far',
          recoverable: true,
        };
      }

      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません（チャンク未ロードの可能性）`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      if (PROTECTED_UTILITY_BLOCKS.has(block.name)) {
        return {
          success: false,
          result: `${block.name}は重要設備なのでdig-block-atでは破壊しません`,
          failureType: 'protected_target',
          recoverable: true,
        };
      }

      // ブロックが掘れるかチェック
      if (block.diggable === false) {
        return {
          success: false,
          result: `${block.name}は掘れません（岩盤など）`,
          failureType: 'undiggable_block',
          recoverable: false,
        };
      }

      // 適切なツールを持っているかチェックし、装備する
      if (block.harvestTools) {
        const toolIds = Object.keys(block.harvestTools).map(Number);
        const tool = this.bot.inventory
          .items()
          .find((item) => toolIds.includes(item.type));

        if (!tool) {
          return {
            success: false,
            result: `${block.name}を掘るための適切なツールがありません`,
            failureType: 'missing_tool',
            recoverable: true,
          };
        }

        // ツールを装備
        try {
          await this.bot.equip(tool, 'hand');
          log.info(`🔧 ${tool.name}を装備しました`);
        } catch (equipError: any) {
          log.error(`ツール装備エラー: ${equipError.message}`, equipError);
        }
      } else {
        // harvestToolsがない場合でも、最適なツールを探して装備
        const bestTool = this.findBestToolForBlock(block);
        if (bestTool) {
          try {
            await this.bot.equip(bestTool, 'hand');
            log.info(`🔧 ${bestTool.name}を装備しました（効率化）`);
          } catch (equipError: any) {
            // 装備失敗しても続行（素手で掘れるブロックの場合）
          }
        }
      }

      const blockName = block.name;

      // 装備したツール名を記録（結果メッセージ用）
      const equippedTool = this.bot.heldItem?.name ?? '素手';

      const beforeItems = new Map<string, number>();
      if (collect) {
        for (const item of this.bot.inventory.items()) {
          beforeItems.set(item.name, (beforeItems.get(item.name) || 0) + item.count);
        }
      }

      const digStart = Date.now();
      await this.bot.dig(block);
      const digDurationMs = Date.now() - digStart;

      // 掘削完了を確認
      await new Promise(resolve => setTimeout(resolve, 200));
      const afterBlock = this.bot.blockAt(pos);

      if (afterBlock && afterBlock.name !== 'air' && afterBlock.name !== 'cave_air' && afterBlock.name === blockName) {
        return {
          success: false,
          result: `${blockName}を掘れませんでした（まだ存在しています）。適切なツールが必要かもしれません`,
          failureType: 'dig_failed',
          recoverable: true,
        };
      }

      // 掘削が遅い場合の警告（適切なツールを使っていない可能性）
      const SLOW_DIG_THRESHOLD_MS = 5000;
      const slowWarning = digDurationMs > SLOW_DIG_THRESHOLD_MS
        ? ` ⚠️ 掘削に${(digDurationMs / 1000).toFixed(1)}秒かかりました（使用: ${equippedTool}）。適切なツール（ツルハシ等）を装備すれば大幅に高速化できます`
        : '';

      if (digDurationMs > SLOW_DIG_THRESHOLD_MS) {
        log.warn(`⚠️ 掘削が遅い: ${blockName} を ${equippedTool} で ${(digDurationMs / 1000).toFixed(1)}秒`);
      }

      if (!collect) {
        return {
          success: true,
          result: `${blockName}を掘りました（回収スキップ）${slowWarning}`,
        };
      }

      const collected = await this.waitForCollection(beforeItems, 2000);

      if (collected.length > 0) {
        return {
          success: true,
          result: `${blockName}を掘りました。${collected.join(', ')}を回収${slowWarning}`,
        };
      }

      // ドロップ未回収 → 近くのアイテムエンティティを探して拾いに行く
      const retryResult = await this.tryPickupDroppedItem(pos, beforeItems);
      if (retryResult) {
        return {
          success: true,
          result: `${blockName}を掘りました。${retryResult}${slowWarning}`,
        };
      }

      return {
        success: true,
        result: `${blockName}を掘りました（ドロップ未回収 — 壁越しまたは消失の可能性）${slowWarning}`,
      };
    } catch (error: any) {
      // エラーメッセージを詳細化
      let errorDetail = error.message;
      if (error.message.includes('far away')) {
        errorDetail = 'ブロックが遠すぎます';
      } else if (error.message.includes("can't dig")) {
        errorDetail = 'このブロックは掘れません';
      } else if (error.message.includes('interrupted') || error.message.includes('aborted')) {
        errorDetail = '採掘が中断されました（パスファインダーとの競合の可能性）';
      }

      return {
        success: false,
        result: `掘削エラー: ${errorDetail}`,
        failureType: error.message.includes('far away')
          ? 'distance_too_far'
          : error.message.includes("can't dig")
            ? 'undiggable_block'
            : error.message.includes('interrupted') || error.message.includes('aborted')
              ? 'interrupted'
              : 'dig_failed',
        recoverable:
          error.message.includes('far away') ||
          error.message.includes('interrupted') ||
          error.message.includes('aborted'),
      };
    }
  }

  /**
   * インベントリの増分を最大 timeoutMs 待って検出する。
   * 200ms 間隔でポーリングし、増えた分を返す。
   */
  private async waitForCollection(
    beforeItems: Map<string, number>,
    timeoutMs: number,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const diff = this.inventoryDiff(beforeItems);
      if (diff.length > 0) return diff;
    }
    return [];
  }

  private inventoryDiff(beforeItems: Map<string, number>): string[] {
    const result: string[] = [];
    for (const item of this.bot.inventory.items()) {
      const before = beforeItems.get(item.name) || 0;
      const current = (this.bot.inventory.items()
        .filter(i => i.name === item.name)
        .reduce((sum, i) => sum + i.count, 0));
      if (current > before && !result.some(r => r.startsWith(item.name))) {
        result.push(`${item.name}x${current - before}`);
      }
    }
    return result;
  }

  /**
   * ブロックに最適なツールを探す
   */
  private findBestToolForBlock(block: any): any {
    const items = this.bot.inventory.items();

    // ブロックのマテリアルに基づいて最適なツールを選択
    const material = block.material;

    // ツールの優先順位（高い方が優先）
    const toolPriority: { [key: string]: string[] } = {
      'mineable/pickaxe': ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'],
      'mineable/axe': ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe'],
      'mineable/shovel': ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'golden_shovel', 'stone_shovel', 'wooden_shovel'],
      'mineable/hoe': ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'golden_hoe', 'stone_hoe', 'wooden_hoe'],
    };

    // ブロック名から適切なツールタイプを推測
    const blockName = block.name.toLowerCase();
    let toolType: string | null = null;

    if (blockName.includes('stone') || blockName.includes('ore') || blockName.includes('cobble') ||
      blockName.includes('brick') || blockName.includes('deepslate') || blockName.includes('obsidian') ||
      blockName.includes('concrete') || blockName.includes('terracotta')) {
      toolType = 'mineable/pickaxe';
    } else if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('plank') ||
      blockName.includes('fence') || blockName.includes('door') || blockName.includes('chest')) {
      toolType = 'mineable/axe';
    } else if (blockName.includes('dirt') || blockName.includes('sand') || blockName.includes('gravel') ||
      blockName.includes('clay') || blockName.includes('snow') || blockName.includes('soul')) {
      toolType = 'mineable/shovel';
    } else if (blockName.includes('leaves') || blockName.includes('hay') || blockName.includes('sponge')) {
      toolType = 'mineable/hoe';
    }

    // materialがある場合はそれを優先
    if (material && toolPriority[material]) {
      toolType = material;
    }

    if (!toolType) {
      return null;
    }

    const preferredTools = toolPriority[toolType] || [];

    // 優先順位の高いツールから探す
    for (const toolName of preferredTools) {
      const tool = items.find(item => item.name === toolName);
      if (tool) {
        return tool;
      }
    }

    return null;
  }

  /**
   * 掘削後のドロップアイテムを拾いに行く。
   * 近くのアイテムエンティティを探し、短いタイムアウトで移動→回収を試みる。
   * 失敗しても pathfinder を確実に停止して返す。
   */
  private async tryPickupDroppedItem(
    blockPos: Vec3,
    beforeItems: Map<string, number>,
  ): Promise<string | null> {
    try {
      // ブロック位置付近のアイテムエンティティを探す
      const itemEntity = this.bot.nearestEntity((entity) => {
        if (entity.name !== 'item') return false;
        const dist = entity.position.distanceTo(blockPos);
        return dist < 10;
      });

      if (!itemEntity) {
        log.info('📦 ドロップアイテムのエンティティが見つかりません');
        return null;
      }

      const itemPos = itemEntity.position;
      const distToItem = this.bot.entity.position.distanceTo(itemPos);
      log.info(`📦 ドロップ発見 → (${itemPos.x.toFixed(1)},${itemPos.y.toFixed(1)},${itemPos.z.toFixed(1)}) 距離${distToItem.toFixed(1)}m、移動して回収を試みます`);

      // 既に十分近い場合は少し待つだけ
      if (distToItem <= 2) {
        await new Promise(r => setTimeout(r, 500));
        const diff = this.inventoryDiff(beforeItems);
        if (diff.length > 0) return `移動後に${diff.join(', ')}を回収`;
      }

      // 短いタイムアウトで移動（最大5秒）
      const goal = new goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, 1);
      const moveTimeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5000),
      );

      try {
        await Promise.race([this.bot.pathfinder.goto(goal), moveTimeout]);
      } catch {
        // タイムアウトやパスファインダーエラー — 必ず停止
      } finally {
        this.bot.pathfinder.stop();
      }

      // 移動後に少し待って回収チェック
      await new Promise(r => setTimeout(r, 800));
      const diff = this.inventoryDiff(beforeItems);
      if (diff.length > 0) return `移動後に${diff.join(', ')}を回収`;

      // まだ拾えてない → アイテムがまだ存在するなら直接歩く
      const stillExists = this.bot.nearestEntity((e) => e === itemEntity);
      if (stillExists) {
        try {
          await this.bot.lookAt(stillExists.position);
          this.bot.setControlState('forward', true);
          await new Promise(r => setTimeout(r, 500));
          this.bot.setControlState('forward', false);
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // ignore
        } finally {
          this.bot.setControlState('forward', false);
        }
        const diff2 = this.inventoryDiff(beforeItems);
        if (diff2.length > 0) return `移動後に${diff2.join(', ')}を回収`;
      }

      return null;
    } catch (e: any) {
      log.warn(`📦 ドロップ回収エラー: ${e.message}`);
      try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
      try { this.bot.setControlState('forward', false); } catch { /* ignore */ }
      return null;
    }
  }
}

export default DigBlockAt;
