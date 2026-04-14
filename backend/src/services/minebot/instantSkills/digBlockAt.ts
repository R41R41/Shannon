import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

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
      let durabilityWarning = '';
      if (block.harvestTools) {
        const toolIds = Object.keys(block.harvestTools).map(Number);
        const validTools = this.bot.inventory
          .items()
          .filter((item) => toolIds.includes(item.type));

        if (validTools.length === 0) {
          return {
            success: false,
            result: `${block.name}を掘るための適切なツールがありません`,
            failureType: 'missing_tool',
            recoverable: true,
          };
        }

        // 耐久が多い順に選ぶ
        const tool = this.pickHighestDurability(validTools);

        // ツールを装備
        try {
          await this.bot.equip(tool, 'hand');
          log.info(`🔧 ${tool.name}を装備しました`);
        } catch (equipError: any) {
          log.error(`ツール装備エラー: ${equipError.message}`, equipError);
        }

        durabilityWarning = this.checkToolDurabilityWarning(tool);
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
          durabilityWarning = this.checkToolDurabilityWarning(bestTool);
        }
      }

      // マグマ隣接安全チェック: 掘削後の空洞にマグマが流入する危険がないか
      const lavaDanger = this.checkLavaAdjacentDanger(pos);
      if (lavaDanger) {
        return {
          success: false,
          result: lavaDanger,
          failureType: 'lava_danger',
          recoverable: true,
        };
      }

      const blockName = block.name;

      const equippedTool = this.bot.heldItem?.name ?? '素手';

      const beforeItems = new Map<string, number>();
      if (collect) {
        for (const item of this.bot.inventory.items()) {
          beforeItems.set(item.name, (beforeItems.get(item.name) || 0) + item.count);
        }
      }

      let digDurationMs: number;
      try {
        const digStart = Date.now();
        await this.bot.dig(block);
        digDurationMs = Date.now() - digStart;
      } catch (digError: any) {
        // 掘削失敗 → LOS遮蔽が原因かを診断
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        return { success: false, result: `掘削エラー: ${digError.message}`, failureType: 'dig_failed', recoverable: true };
      }

      // 掘削完了を確認（ドロップエンティティ生成の猶予）
      await new Promise(resolve => setTimeout(resolve, 280));
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

      const warnings = [slowWarning, durabilityWarning].filter(Boolean).join('');

      // インベントリに空きがない場合は回収を試みない
      const noEmptySlots = typeof this.bot.inventory.emptySlotCount === 'function'
        && this.bot.inventory.emptySlotCount() === 0;

      if (!collect || noEmptySlots) {
        const note = noEmptySlots && collect
          ? '（インベントリ満杯のため回収スキップ — pickup-nearest-item で後から回収可能）'
          : '（回収スキップ）';
        return {
          success: true,
          result: `${blockName}を掘りました${note}${warnings}`,
        };
      }

      const collected = await this.waitForCollection(beforeItems, 4500);

      if (collected.length > 0) {
        return {
          success: true,
          result: `${blockName}を掘りました。${collected.join(', ')}を回収${warnings}`,
        };
      }

      // ドロップ未回収 → 近くのアイテムエンティティを探して拾いに行く
      const retryResult = await this.tryPickupDroppedItem(pos, beforeItems);
      if (retryResult) {
        return {
          success: true,
          result: `${blockName}を掘りました。${retryResult}${warnings}`,
        };
      }

      return {
        success: true,
        result: `${blockName}を掘りました（ドロップ未回収 — 壁越しまたは消失の可能性）${warnings}`,
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
   * 複数ドロップ・連続ピックアップに対応するため、一度増えたあと
   * インベントリ合計がしばらく変化しなくなるまで待ってから返す。
   */
  private async waitForCollection(
    beforeItems: Map<string, number>,
    timeoutMs: number,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const STABLE_MS = 550;
    const POLL_MS = 160;
    let prevSig = this.inventorySnapshotString();
    let stableSince = Date.now();
    let sawPickup = false;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const diff = this.inventoryDiff(beforeItems);
      if (diff.length > 0) sawPickup = true;

      const sig = this.inventorySnapshotString();
      if (sig !== prevSig) {
        prevSig = sig;
        stableSince = Date.now();
      } else if (sawPickup && Date.now() - stableSince >= STABLE_MS) {
        return this.inventoryDiff(beforeItems);
      }
    }
    return sawPickup ? this.inventoryDiff(beforeItems) : [];
  }

  /** 安定判定用（スタック合併・複数種をまとめて見る） */
  private inventorySnapshotString(): string {
    return this.bot.inventory
      .items()
      .map(i => `${i.name}:${i.count}`)
      .sort()
      .join(',');
  }

  /** 掘削地点付近にまだアイテムエンティティがあるか */
  private hasNearbyItemEntityNear(origin: Vec3, radius: number): boolean {
    const e = this.bot.nearestEntity((entity) => {
      if (entity.name !== 'item') return false;
      return entity.position.distanceTo(origin) < radius;
    });
    return !!e;
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
  /** 同種ツールが複数ある場合、耐久が多いものを優先して返す */
  private pickHighestDurability(tools: any[]): any {
    if (tools.length <= 1) return tools[0];
    return tools.reduce((best, cur) => {
      const bestRemaining = this.getToolDurabilityRemaining(best);
      const curRemaining = this.getToolDurabilityRemaining(cur);
      return curRemaining > bestRemaining ? cur : best;
    });
  }

  private getToolDurabilityRemaining(item: any): number {
    const max = item.maxDurability;
    const used = item.durabilityUsed;
    if (max != null && max > 0 && used != null && used >= 0) {
      return Math.max(0, max - used);
    }
    return Infinity;
  }

  /** 装備中のツールの耐久が危険水準なら警告文を返す */
  private checkToolDurabilityWarning(tool: any): string {
    const LOW_DURABILITY_WARN = 10;
    const remaining = this.getToolDurabilityRemaining(tool);
    if (remaining !== Infinity && remaining <= LOW_DURABILITY_WARN) {
      return ` ⚠️ ${tool.name}の残り耐久が${remaining}です。もうすぐ壊れます。予備のツールを craft-one でクラフトしてください`;
    }
    return '';
  }

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

    // 優先順位の高いツールから探す（同名ツールが複数あれば耐久が多いものを優先）
    for (const toolName of preferredTools) {
      const matching = items.filter(item => item.name === toolName);
      if (matching.length > 0) {
        return this.pickHighestDurability(matching);
      }
    }

    return null;
  }

  /**
   * 掘削後のドロップアイテムを拾いに行く。
   * 同一地点付近に複数エンティティがあっても、なくなるか上限まで繰り返す。
   */
  private async tryPickupDroppedItem(
    blockPos: Vec3,
    beforeItems: Map<string, number>,
  ): Promise<string | null> {
    const maxPasses = 6;
    const roundDeadline = Date.now() + 10000;
    let loggedNone = false;

    try {
      for (let pass = 0; pass < maxPasses && Date.now() < roundDeadline; pass++) {
        const itemEntity = this.bot.nearestEntity((entity) => {
          if (entity.name !== 'item') return false;
          return entity.position.distanceTo(blockPos) < 10;
        });

        if (!itemEntity) {
          if (!loggedNone) {
            log.info('📦 ドロップアイテムのエンティティが見つかりません');
            loggedNone = true;
          }
          break;
        }

        const itemPos = itemEntity.position;
        const distToItem = this.bot.entity.position.distanceTo(itemPos);
        log.info(
          `📦 ドロップ発見(pass ${pass + 1}) → (${itemPos.x.toFixed(1)},${itemPos.y.toFixed(1)},${itemPos.z.toFixed(1)}) 距離${distToItem.toFixed(1)}m`,
        );

        if (distToItem <= 2) {
          await new Promise(r => setTimeout(r, 400));
        } else {
          const goal = new goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, 1);
          try {
            await gotoSafe(this.bot, goal, { timeoutMs: 6500, stuckAbortCount: 4 });
          } catch {
            // エラーは無視してアイテム回収を試みる
          } finally {
            try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
          }
          await new Promise(r => setTimeout(r, 500));
        }

        try {
          if (this.bot.collectBlock) {
            await this.bot.collectBlock.collect(itemEntity);
          } else {
            await gotoSafe(this.bot, new goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, 0.5), {
              timeoutMs: 3000,
              stuckAbortCount: 2,
              logStuck: false,
            });
          }
        } catch {
          // 消えた・届かない等
        }

        await new Promise(r => setTimeout(r, 380));
      }

      const diff = this.inventoryDiff(beforeItems);
      if (diff.length > 0) return `移動後に${diff.join(', ')}を回収`;
      return null;
    } catch (e: any) {
      log.warn(`📦 ドロップ回収エラー: ${e.message}`);
      try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * 掘削対象ブロックの6面隣接にマグマがある場合の危険度を判定。
   * 掘ると空洞にマグマが流入してボットが焼け死ぬケースを防ぐ。
   */
  private checkLavaAdjacentDanger(targetPos: Vec3): string | null {
    const offsets = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 1, 0), new Vec3(0, -1, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];

    const lavaPositions: Vec3[] = [];
    for (const off of offsets) {
      const neighbor = targetPos.plus(off);
      const block = this.bot.blockAt(neighbor);
      if (block && block.name === 'lava') {
        lavaPositions.push(neighbor);
      }
    }

    if (lavaPositions.length === 0) return null;

    const botFeetY = Math.floor(this.bot.entity.position.y);
    const isUnderBot = targetPos.y <= botFeetY;

    if (isUnderBot) {
      const lavaCoords = lavaPositions.map(p => `(${p.x},${p.y},${p.z})`).join(', ');
      return `⚠️ 危険: このブロック(${targetPos.x},${targetPos.y},${targetPos.z})の隣にマグマ${lavaCoords}があり、`
        + `掘削するとマグマが流入して致命的です（ボットの足元以下のブロック）。`
        + `マグマを黒曜石にするには water_bucket を lava ブロックに直接 use-item-on-block してください。`;
    }

    const lavaCoords = lavaPositions.map(p => `(${p.x},${p.y},${p.z})`).join(', ');
    return `⚠️ 危険: このブロック(${targetPos.x},${targetPos.y},${targetPos.z})の隣にマグマ${lavaCoords}があります。`
      + `掘削するとマグマが空洞に流入する危険があります。`
      + `マグマを黒曜石にするには water_bucket を lava ブロックに直接 use-item-on-block してください。`;
  }
}

export default DigBlockAt;
