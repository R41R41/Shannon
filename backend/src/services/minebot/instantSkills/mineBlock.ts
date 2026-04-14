import minecraftData from 'minecraft-data';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import {
  DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO,
  emptySlotCountSafe,
  INVENTORY_FULL_RECOVERY_HINT_JA,
  shouldPauseMiningForDeposit,
} from '../utils/inventorySpillDetection.js';
import { gotoSafe } from '../utils/gotoSafe.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:mineBlock');

class MineBlock extends InstantSkill {
  private mcData: any;

  /**
   * 通常鉱石と deepslate 対をまとめて探す（iron_ore と deepslate_iron_ore など）。
   */
  private static oreMiningFamily(mcData: any, blockName: string): string[] {
    const out = new Set<string>([blockName]);
    if (blockName.startsWith('deepslate_') && blockName.includes('ore')) {
      const rest = blockName.slice('deepslate_'.length);
      if (mcData.blocksByName[rest]) out.add(rest);
    } else if (!blockName.startsWith('deepslate_') && blockName.endsWith('_ore')) {
      const deep = `deepslate_${blockName}`;
      if (mcData.blocksByName[deep]) out.add(deep);
    }
    return [...out];
  }

  private static distSqToBlockCenter(
    botPos: { x: number; y: number; z: number },
    pos: { x: number; y: number; z: number },
  ): number {
    const cx = pos.x + 0.5;
    const cy = pos.y + 0.5;
    const cz = pos.z + 0.5;
    return (botPos.x - cx) ** 2 + (botPos.y - cy) ** 2 + (botPos.z - cz) ** 2;
  }

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'mine-block';
    this.description =
      '指定した種類のブロックを近くから探し、**都度いまの位置から最も近い候補**を選んで採掘します。手の届く範囲に複数あればまとめて掘って一括回収（バッチ採掘）するため効率的です。`*_ore` は通常石と深層（deepslate_*）をまとめて扱います。ブロック名は正式ID（例: iron_ore, coal_ore, hay_block, oak_log 等）を使用してください。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '採掘するブロック名（Minecraft正式ID: coal_ore, iron_ore, deepslate_iron_ore, diamond_ore, oak_log, stone 等。coalやironではなく_ore付きの正式名を使うこと）',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '採掘する個数（デフォルト: 1）',
        default: 1,
      },
      {
        name: 'searchRadius',
        type: 'number',
        description: '検索半径（デフォルト: 32）',
        default: 32,
      },
    ];
  }

  async runImpl(blockName: string, count: number = 1, searchRadius: number = 32) {
    const blockType = this.mcData.blocksByName[blockName];
    if (!blockType) {
      const allBlocks = Object.keys(this.mcData.blocksByName);
      const suggestions = allBlocks
        .filter((name: string) => name.includes(blockName.replace('_ore', '').replace('_log', '')))
        .slice(0, 5);
      return {
        success: false,
        result: `ブロック${blockName}が見つかりません${suggestions.length > 0 ? `。正しい名前: ${suggestions.join(', ')}` : ''}。鉱石は coal_ore, iron_ore 等の _ore 付きの名前を使ってください`,
        failureType: 'invalid_block',
        recoverable: false,
      };
    }

    const moveTo = this.bot.instantSkills.getSkill('move-to');
    const digBlockAt = this.bot.instantSkills.getSkill('dig-block-at');
    if (!moveTo || !digBlockAt) {
      return {
        success: false,
        result: '採掘に必要なスキル(move-to / dig-block-at)が見つかりません',
        failureType: 'missing_dependency',
        recoverable: false,
      };
    }

    const want = Math.max(1, count);
    // findBlocks の返却順は不定なので候補を多めに取り、ループ毎に「いまの位置」から近い順に選ぶ
    const scanCount = Math.min(384, Math.max(want * 12, want + 48));
    const familyNames = MineBlock.oreMiningFamily(this.mcData, blockName);
    const candidateKeySet = new Set<string>();
    const candidates: Array<{ x: number; y: number; z: number }> = [];

    const mergeTargetsFromWorld = (): void => {
      for (const name of familyNames) {
        const id = this.mcData.blocksByName[name]?.id;
        if (id === undefined) continue;
        const found = this.bot.findBlocks({
          matching: id,
          maxDistance: searchRadius,
          count: scanCount,
        });
        for (const p of found) {
          const k = `${p.x},${p.y},${p.z}`;
          if (candidateKeySet.has(k)) continue;
          const blk = this.bot.blockAt(new Vec3(p.x, p.y, p.z));
          if (!blk || !familyNames.includes(blk.name)) continue;
          candidateKeySet.add(k);
          candidates.push(p);
        }
      }
    };

    mergeTargetsFromWorld();

    if (candidates.length === 0) {
      return {
        success: false,
        result: `${searchRadius}ブロック以内に${blockName}が見つかりません`,
        failureType: 'target_not_found',
        recoverable: true,
      };
    }

    // ツルハシの有無・耐久を事前チェック
    const needsPickaxe = ['stone', 'ore', 'cobble', 'deepslate', 'brick', 'obsidian', 'concrete', 'terracotta', 'basalt', 'netherrack']
      .some(keyword => blockName.includes(keyword));
    const pickaxes = this.bot.inventory.items().filter(item => item.name.includes('pickaxe'));
    const hasPickaxe = pickaxes.length > 0;
    let toolWarning = '';

    if (needsPickaxe && !hasPickaxe) {
      return {
        success: false,
        failureType: 'missing_tool',
        recoverable: true,
        result:
          `ツルハシを所持していません。${blockName}の採掘にはツルハシが必要です。` +
          '先に craft-one で wooden_pickaxe / stone_pickaxe / iron_pickaxe 等をクラフトしてから再度 mine-block を実行してください。' +
          '（素材例: wooden_pickaxe = planks×3 + stick×2、stone_pickaxe = cobblestone×3 + stick×2）',
      };
    } else if (needsPickaxe && hasPickaxe) {
      // 全ツルハシの総残り耐久を算出
      let totalDurability = 0;
      let hasDurabilityInfo = false;
      for (const pick of pickaxes) {
        const max = (pick as any).maxDurability;
        const used = (pick as any).durabilityUsed;
        if (max != null && max > 0 && used != null && used >= 0) {
          totalDurability += Math.max(0, max - used);
          hasDurabilityInfo = true;
        } else {
          totalDurability += 100;
        }
      }

      if (hasDurabilityInfo && totalDurability < want) {
        return {
          success: false,
          failureType: 'tool_durability_low',
          recoverable: true,
          result:
            `ツルハシの総残り耐久（${totalDurability}）が採掘予定数（${want}個）に対して不足しています。` +
            `途中でツルハシが壊れる可能性が高いです。先に craft-one で予備のツルハシをクラフトしてから再度 mine-block を実行してください。` +
            `（所持ツルハシ: ${pickaxes.map(p => {
              const mx = (p as any).maxDurability;
              const us = (p as any).durabilityUsed;
              return mx != null && us != null ? `${p.name} 耐久${Math.max(0, mx - us)}/${mx}` : p.name;
            }).join(', ')}）`,
        };
      }

      const LOW_DURABILITY_THRESHOLD = 10;
      if (hasDurabilityInfo && totalDurability < want + LOW_DURABILITY_THRESHOLD) {
        toolWarning =
          ` ⚠️ ツルハシの総残り耐久（${totalDurability}）が残り少なめです（採掘予定: ${want}個）。` +
          `タスク完了後に予備のツルハシをクラフトすることを推奨します`;
      }
    }

    // 採掘前のインベントリをスナップショット（ドロップアイテム検出用）
    const beforeInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      beforeInventory.set(item.name, (beforeInventory.get(item.name) ?? 0) + item.count);
    }

    let mined = 0;
    const failures: string[] = [];
    let lastFailureType: string | undefined;
    let lastRecoverable = false;
    let stoppedForInventoryFull = false;
    let stoppedForInventoryTight = false;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    while (mined < count && candidates.length > 0) {
      if (this.shouldInterrupt()) break;

      const remainingToMine = want - mined;
      if (shouldPauseMiningForDeposit(this.bot, remainingToMine)) {
        if (mined > 0) {
          stoppedForInventoryTight = true;
          break;
        }
        return {
          success: false,
          failureType: 'inventory_full',
          recoverable: true,
          result:
            `インベントリの空きが${emptySlotCountSafe(this.bot)}スロットしかありません。満杯になる前に deposit-to-container で地上のチェストまたは樽に預けてから採掘してください（目安: 空きが約${DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO}以下で、これから掘る個数が空きを超えるときは先に預ける）。${INVENTORY_FULL_RECOVERY_HINT_JA}${toolWarning}`,
        };
      }

      const here = this.bot.entity.position;
      candidates.sort(
        (a, b) => MineBlock.distSqToBlockCenter(here, a) - MineBlock.distSqToBlockCenter(here, b),
      );

      const pos = candidates.shift()!;
      const target = new Vec3(pos.x, pos.y, pos.z);
      const block = this.bot.blockAt(target);
      if (!block || !familyNames.includes(block.name)) {
        continue;
      }

      const distance = this.bot.entity.position.distanceTo(target);
      if (distance > 4.5) {
        const moveResult = await moveTo.run(target.x, target.y, target.z, 1, 'near');
        if (!moveResult.success) {
          lastFailureType = moveResult.failureType ?? 'movement_failed';
          lastRecoverable = moveResult.recoverable ?? true;
          failures.push(
            `移動失敗(${target.x},${target.y},${target.z}): ${moveResult.failureType ?? moveResult.result}`,
          );
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で到達失敗 — これ以上の候補を試行しません`);
            break;
          }
          continue;
        }
      }

      // ── バッチ採掘: 手の届く範囲の同種ブロックをまとめて掘る ──
      const REACH = 4.5;
      const batchTargets: Vec3[] = [target];
      // candidates から手の届く範囲のブロックも集める
      const maxBatch = Math.min(remainingToMine, 16);
      const kept: Array<{ x: number; y: number; z: number }> = [];
      for (const c of candidates) {
        if (batchTargets.length >= maxBatch) { kept.push(c); continue; }
        const cv = new Vec3(c.x, c.y, c.z);
        const dFromBot = this.bot.entity.position.distanceTo(cv);
        if (dFromBot <= REACH) {
          const blk = this.bot.blockAt(cv);
          if (blk && familyNames.includes(blk.name)) {
            batchTargets.push(cv);
            continue;
          }
        }
        kept.push(c);
      }
      candidates.length = 0;
      candidates.push(...kept);

      if (batchTargets.length >= 2) {
        // ── 複数ブロックをまとめて掘り、後から一括回収 ──
        log.info(`⛏️ バッチ採掘: ${batchTargets.length}個の${blockName}を一括で掘削`);
        let batchDug = 0;
        let batchAbortReason: { type: string; result: string } | null = null;

        for (const bt of batchTargets) {
          if (this.shouldInterrupt()) break;
          const blk = this.bot.blockAt(bt);
          if (!blk || !familyNames.includes(blk.name)) continue;

          let digResult = await digBlockAt.run(bt.x, bt.y, bt.z, false);
          // 遮蔽物を除去した場合は同じブロックをリトライ
          if (digResult.failureType === 'obstruction_cleared') {
            digResult = await digBlockAt.run(bt.x, bt.y, bt.z, false);
          }
          if (digResult.failureType === 'missing_tool') {
            batchAbortReason = { type: 'missing_tool', result: digResult.result };
            break;
          }
          if (digResult.failureType === 'lava_danger') {
            batchAbortReason = { type: 'lava_danger', result: digResult.result };
            break;
          }
          if (digResult.success) {
            batchDug++;
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
            failures.push(`採掘失敗(${bt.x},${bt.y},${bt.z}): ${digResult.failureType ?? digResult.result}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          }
        }

        // 一括ドロップ回収
        if (batchDug > 0) {
          const collected = await this.collectAllNearbyDrops();
          if (collected.length > 0) {
            log.info(`📦 一括回収: ${collected.join(', ')}`, 'green');
          }
        }

        mined += batchDug;

        if (batchAbortReason) {
          lastFailureType = batchAbortReason.type;
          lastRecoverable = true;
          failures.push(`ツール不足: ${batchAbortReason.result}`);
          break;
        }

        // ツルハシ生存チェック
        if (needsPickaxe) {
          const toolCheck = this.checkToolSurvival(want, mined);
          if (toolCheck) return toolCheck;
        }

        // 掘削後に近傍を再スキャン
        mergeTargetsFromWorld();

      } else {
        // ── 単体採掘: 従来通り collect=true で1個ずつ ──
        let digResult = await digBlockAt.run(target.x, target.y, target.z, true);
        if (digResult.failureType === 'obstruction_cleared') {
          digResult = await digBlockAt.run(target.x, target.y, target.z, true);
        }
        if (digResult.failureType === 'missing_tool') {
          lastFailureType = 'missing_tool';
          lastRecoverable = true;
          failures.push(`ツール不足: ${digResult.result}`);
          break;
        }
        if (digResult.failureType === 'lava_danger') {
          lastFailureType = 'lava_danger';
          lastRecoverable = true;
          failures.push(`マグマ危険: ${digResult.result}`);
          break;
        }
        if (digResult.success) {
          mined += 1;
          consecutiveFailures = 0;

          if (needsPickaxe) {
            const toolCheck = this.checkToolSurvival(want, mined);
            if (toolCheck) return toolCheck;
          }

          mergeTargetsFromWorld();
        } else {
          lastFailureType = digResult.failureType ?? 'dig_failed';
          lastRecoverable = digResult.recoverable ?? true;
          failures.push(
            `採掘失敗(${target.x},${target.y},${target.z}): ${digResult.failureType ?? digResult.result}`,
          );
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で採掘失敗 — 別のアプローチを検討してください`);
            break;
          }
        }
      }
    }

    if (stoppedForInventoryFull) {
      return {
        success: mined > 0,
        failureType: 'inventory_full',
        recoverable: true,
        result:
          `${mined > 0 ? `${mined}個のブロックは掘削済みですが、` : ''}インベントリが満杯のため採掘を中断しました。` +
          'ドロップが地上に残っている可能性があります。deposit-to-container で預けて空きを作ってください。' +
          `${failures.length > 0 ? ` 詳細: ${failures.join(', ')}` : ''}${toolWarning}`,
      };
    }

    const tightNote = stoppedForInventoryTight
      ? ` 【満杯前整理】空きが少ないためここで中断しました。先に deposit-to-container で預けてから続行してください。${INVENTORY_FULL_RECOVERY_HINT_JA}`
      : '';

    if (mined === 0) {
      return {
        success: false,
        result: `${blockName}を採掘できませんでした${failures.length > 0 ? `: ${failures.join(', ')}` : ''}`,
        failureType: lastFailureType ?? 'mine_failed',
        recoverable: lastRecoverable || failures.length === 0,
      };
    }

    // 採掘後のインベントリ差分からドロップアイテムを検出
    const drops = this.detectDrops(beforeInventory);
    const totalDropCount = drops.reduce((sum, d) => sum + d.count, 0);

    if (totalDropCount === 0) {
      return {
        success: true,
        result: `${blockName}を${mined}個掘削しましたが、ドロップアイテムを回収できませんでした（消失・溶岩・落下等の可能性）。ブロック自体は破壊済みです。${toolWarning}`,
        failureType: 'drops_lost',
        recoverable: true,
      };
    }

    const dropsText = `（ドロップ回収: ${drops.map(d => `${d.item} x${d.count}`).join(', ')}）`;

    // ドロップアイテムの現在所持数を付記（LLMが過剰採掘しないようにする）
    const totalsText = this.formatDropTotals(drops);

    const isPartial = mined < count || stoppedForInventoryTight;
    return {
      success: !isPartial,
      result: isPartial
        ? `${blockName}を${count}個中${mined}個のみ採掘しました${dropsText}${totalsText}。残り${count - mined}個が不足しています。再度 mine-block を実行してください${tightNote}${failures.length > 0 ? `（失敗詳細: ${failures.join(', ')}）` : ''}${toolWarning}`
        : `${blockName}を${mined}個採掘しました${dropsText}${totalsText}${failures.length > 0 ? `（一部失敗: ${failures.join(', ')}）` : ''}${toolWarning}`,
      ...(isPartial && { failureType: stoppedForInventoryTight ? 'inventory_full' : 'partial_completion', recoverable: true }),
    };
  }

  /**
   * バッチ掘削後に周辺のドロップアイテムを一括回収する。
   * inventory 差分で確認しながら、近くの item エンティティに歩いて拾う。
   */
  private async collectAllNearbyDrops(): Promise<string[]> {
    const before = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      before.set(item.name, (before.get(item.name) ?? 0) + item.count);
    }

    // ドロップスポーン待ち
    await new Promise(r => setTimeout(r, 500));

    // 自動ピックアップ待ち（近くにいれば勝手に拾う）
    const autoDeadline = Date.now() + 1200;
    while (Date.now() < autoDeadline) {
      await new Promise(r => setTimeout(r, 150));
      const nearby = this.bot.nearestEntity(
        e => e.name === 'item' && e.position.distanceTo(this.bot.entity.position) < 2,
      );
      if (!nearby) break;
    }

    // まだ残ってるアイテムエンティティを拾いに行く（最大8パス）
    for (let pass = 0; pass < 8; pass++) {
      if (this.shouldInterrupt()) break;
      const item = this.bot.nearestEntity(
        e => e.name === 'item' && e.position.distanceTo(this.bot.entity.position) < 16,
      );
      if (!item) break;

      const d = item.position.distanceTo(this.bot.entity.position);
      if (d > 1.5) {
        const ip = item.position;
        try {
          await gotoSafe(this.bot, new goals.GoalNear(ip.x, ip.y, ip.z, 1), {
            timeoutMs: 4000,
            stuckAbortCount: 3,
            logStuck: false,
          });
        } catch { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, 400));
    }

    // 差分を返す
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of this.bot.inventory.items()) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      const beforeCount = before.get(item.name) ?? 0;
      const currentCount = this.bot.inventory.items()
        .filter(i => i.name === item.name)
        .reduce((sum, i) => sum + i.count, 0);
      if (currentCount > beforeCount) {
        result.push(`${item.name}x${currentCount - beforeCount}`);
      }
    }
    return result;
  }

  /**
   * ツルハシの生存・耐久チェック。問題があれば返却オブジェクトを返す。
   */
  private checkToolSurvival(want: number, mined: number): any {
    const pickaxesNow = this.bot.inventory.items().filter(item => item.name.includes('pickaxe'));
    if (pickaxesNow.length === 0) {
      const remaining = want - mined;
      return {
        success: mined > 0,
        failureType: 'missing_tool',
        recoverable: true,
        result:
          `採掘中にツルハシが壊れました（${mined}個掘削済み、残り${remaining}個未採掘）。` +
          'craft-one で新しいツルハシをクラフトしてから mine-block を再実行してください。',
      };
    }
    let minRemaining = Infinity;
    for (const p of pickaxesNow) {
      const mx = (p as any).maxDurability;
      const us = (p as any).durabilityUsed;
      if (mx != null && mx > 0 && us != null && us >= 0) {
        minRemaining = Math.min(minRemaining, mx - us);
      }
    }
    const remaining = want - mined;
    if (minRemaining !== Infinity && minRemaining <= 3 && remaining > 0) {
      return {
        success: mined > 0,
        failureType: 'tool_durability_low',
        recoverable: true,
        result:
          `${mined}個採掘しましたが、ツルハシの残り耐久が${minRemaining}しかありません（残り${remaining}個未採掘）。` +
          'craft-one で新しいツルハシをクラフトしてから mine-block を再実行してください。',
      };
    }
    return null;
  }

  /**
   * ドロップアイテムの現在インベントリ所持数をフォーマットする。
   */
  private formatDropTotals(drops: Array<{ item: string; count: number }>): string {
    if (drops.length === 0) return '';
    const currentInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      currentInventory.set(item.name, (currentInventory.get(item.name) ?? 0) + item.count);
    }
    const totals = drops
      .map(d => `${d.item}=${currentInventory.get(d.item) ?? 0}個`)
      .join(', ');
    return `（現在の所持数: ${totals}）`;
  }

  /**
   * 採掘前後のインベントリ差分からドロップアイテムを検出する。
   */
  private detectDrops(beforeInventory: Map<string, number>): Array<{ item: string; count: number }> {
    const afterInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      afterInventory.set(item.name, (afterInventory.get(item.name) ?? 0) + item.count);
    }

    const drops: Array<{ item: string; count: number }> = [];
    for (const [name, afterCount] of afterInventory) {
      const beforeCount = beforeInventory.get(name) ?? 0;
      if (afterCount > beforeCount) {
        drops.push({ item: name, count: afterCount - beforeCount });
      }
    }
    return drops;
  }
}

export default MineBlock;
