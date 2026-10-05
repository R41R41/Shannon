import { findLoadedBlocks } from '../utils/loadedBlockScan.js';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import {
  DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO,
  emptySlotCountSafe,
  INVENTORY_FULL_RECOVERY_HINT_JA,
  shouldPauseMiningForDeposit,
} from '../utils/inventorySpillDetection.js';
import { assertActionActive, reportActionProgress } from '../execution/ActionExecution.js';
import { collectDrops, expectedBlockDrops, inventoryCounts, type CollectionPolicy } from '../execution/collectDrops.js';
import { canDigFromHere, DIG_REACH } from '../utils/blockInteractionReach.js';
import { estimateBlockApproachCost } from '../utils/blockApproachCost.js';
import { dropBurnsIn } from '../utils/dropFate.js';
import { digMsWithBestTool as bestToolDigMs } from '../utils/bestToolDigTime.js';

const log = createLogger('Minebot:Skill:mineBlock');

/**
 * Targets the approach failed to reach, per bot. A paid run asked for the same
 * two cliff-top logs again and again; each call re-picked the nearest ones and
 * timed out. They go to the back of the list for a while, not out of it.
 */
const UNREACHABLE_MEMORY_MS = 10 * 60_000;
const unreachableTargets = new WeakMap<object, Map<string, number>>();
function recentlyUnreachable(bot: object): Map<string, number> {
  let memory = unreachableTargets.get(bot);
  if (!memory) { memory = new Map(); unreachableTargets.set(bot, memory); }
  const now = Date.now();
  for (const [key, at] of memory) if (now - at > UNREACHABLE_MEMORY_MS) memory.delete(key);
  return memory;
}

class MineBlock extends InstantSkill {
  private mcData: any;

  /**
   * Only defer pickup when each block has a solid floor and the whole batch is
   * level. Tree trunks, cliff faces and mixed-height veins still need pickup
   * after every dig: their drops can fall to a different ledge before the bot
   * returns. Keep the deferred group small so collectDrops can reach every
   * spawned item within its bounded pickup passes.
   */
  private canDeferBatchCollection(blockName: string, targets: Vec3[]): boolean {
    if (targets.length < 2 || !(['stone', 'cobblestone', 'deepslate'].includes(blockName)
      || blockName.endsWith('_ore'))) return false;
    const level = targets[0].y;
    return targets.every(target => target.y === level
      && this.bot.blockAt(new Vec3(target.x, target.y - 1, target.z))?.boundingBox === 'block');
  }

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

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'mine-block';
    // Longer than the approach it calls (a move ends by itself at 110 seconds and says how far it got): with
    // the same two minutes for both, the order ran out first and all the planner was told was "timeout".
    // A tunnel towards diamonds ended that way twice running, and wore out the pickaxe on the way (paid run L81).
    this.maxDurationMs = 180_000;
    this.description =
      '指定した種類のブロックを近くから探し、都度いまの位置から高低差と露出を含む到達コスト概算が低い候補を選んで採掘します。実経路は移動時に検証し、深い候補も除外しません。手の届く範囲に複数あればまとめて掘って一括回収（バッチ採掘）するため効率的です。`*_ore` は通常石と深層（deepslate_*）をまとめて扱います。ブロック名は正式ID（例: iron_ore, coal_ore, hay_block, oak_log 等）を使用してください。';
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
      { name: 'collectionPolicy', type: 'string', description: 'target=採掘対象のドロップを優先（既定）、all=周辺ドロップも回収', default: 'target' },
    ];
  }

  async runImpl(blockName: string, count: number = 1, searchRadius: number = 32, collectionPolicy: CollectionPolicy = 'target') {
    assertActionActive(this.bot);
    reportActionProgress(this.bot, 'precondition', { blockName, count, searchRadius });
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(searchRadius) || searchRadius <= 0
      || !['target', 'all'].includes(collectionPolicy)) return { success: false,
        failureType: 'invalid_input', recoverable: false, result: '個数は正の整数、検索半径は正の数、回収方針は target / all を指定してください' };
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
    const candidates: Array<{ x: number; y: number; z: number; exposed?: boolean }> = [];
    // Ore on a lake floor or in a flooded cave pulled paid runs under water,
    // where mining is ~25x slower and two bots drowned. Skip blocks touching a
    // water source; dry ore is plentiful.
    const submergedKeys = new Set<string>();
    const touchesWaterSource = (p: { x: number; y: number; z: number }) => [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1)].some(offset => {
      const neighbor = this.bot.blockAt(new Vec3(p.x + offset.x, p.y + offset.y, p.z + offset.z));
      return neighbor?.name === 'water' && (neighbor.metadata === 0 || (neighbor as any).getProperties?.().level === 0);
    });

    const mergeTargetsFromWorld = (): void => {
      reportActionProgress(this.bot, 'search', { blockName, searchRadius, queuedTargets: candidates.length });
      const queuedKeys = new Set(candidates.map(p => `${p.x},${p.y},${p.z}`));
      for (const name of familyNames) {
        const id = this.mcData.blocksByName[name]?.id;
        if (id === undefined) continue;
        const found = typeof (this.bot.world as any)?.getColumns === 'function'
          ? findLoadedBlocks(this.bot as any, [name], searchRadius, scanCount)
          : this.bot.findBlocks({ matching: id, maxDistance: searchRadius, count: scanCount });
        for (const p of found) {
          const k = `${p.x},${p.y},${p.z}`;
          if (queuedKeys.has(k)) continue;
          const blk = this.bot.blockAt(new Vec3(p.x, p.y, p.z));
          if (!blk || !familyNames.includes(blk.name)) continue;
          if (touchesWaterSource(p)) { submergedKeys.add(k); continue; }
          candidateKeySet.add(k);
          queuedKeys.add(k);
          const exposed = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
            new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
            .some(offset => ['air', 'cave_air', 'void_air'].includes(this.bot.blockAt(new Vec3(p.x + offset.x, p.y + offset.y, p.z + offset.z))?.name ?? ''));
          candidates.push({ x: p.x, y: p.y, z: p.z, exposed });
        }
      }
    };

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

    // Cheap prerequisites precede the synchronous, radius-dependent scan.
    if (blockType.harvestTools && !this.bot.inventory.items().some(item =>
      Object.keys(blockType.harvestTools).map(Number).includes(item.type))) {
      return { success: false, failureType: 'missing_tool', recoverable: true,
        result: `${blockName}を回収できる適切なツールがありません。先に必要な道具を用意してください` };
    }
    reportActionProgress(this.bot, 'search', { blockName, searchRadius });
    mergeTargetsFromWorld();
    assertActionActive(this.bot);
    if (candidates.length === 0) return { success: false, failureType: 'target_not_found', recoverable: true,
      result: `${searchRadius}ブロック以内に${blockName}が見つかりません`
        + (submergedKeys.size ? `（水源に接する${submergedKeys.size}個は水中作業になるため除外。水の無い場所を探してください）` : '') };
    const beforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
    const expectedItems = expectedBlockDrops(this.bot, blockType);
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
    // One action has a fixed time (two minutes). Obsidian is nine seconds a block with a diamond pickaxe and
    // more over lava: ten of it ran the action out with a block half dug, the water it had poured left
    // standing and two drops lying uncollected (lab, 2026-10-02). A block that cannot be finished and
    // picked up in what is left is not started; what was done is reported and the rest is asked for again.
    const actionStartedAt = Date.now();
    const timeLeftMs = () => (this.maxDurationMs || 120_000) - (Date.now() - actionStartedAt);
    const COLLECT_RESERVE_MS = 8000;
    const OVER_LAVA_EXTRA_MS = 5000;
    const digMsWithBestTool = (block: any): number => bestToolDigMs(this.bot as any, block);
    const noTimeFor = (block: any, at: Vec3) => mined > 0
      && timeLeftMs() < digMsWithBestTool(block) + (dropBurnsIn(this.bot as any, at) ? OVER_LAVA_EXTRA_MS : 0) + COLLECT_RESERVE_MS;
    let stoppedForTime = false;
    /** The least time worth starting a walk to a block with, and what is said when an action ends on the way to one. */
    const APPROACH_MIN_MS = 45_000;
    let approachNote = '';
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    // Nested movement/drop collection can mine another target through the
    // pathfinder. Count actual completed digs, not just direct skill calls.
    const completedTargets = new Set<string>();
    const targetKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
    const onDiggingCompleted = (dug: any) => {
      // Mineflayer emits the new AIR block, not the original material.
      if (dug?.position && candidateKeySet.has(targetKey(dug.position))) {
        completedTargets.add(targetKey(dug.position));
        mined = completedTargets.size;
      }
    };
    this.bot.on('diggingCompleted', onDiggingCompleted);

    try {

    while (mined < count) {
      if (this.shouldInterrupt()) break;
      if (candidates.length === 0) {
        mergeTargetsFromWorld();
        if (candidates.length === 0) break;
      }

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
            `インベントリの空きが${emptySlotCountSafe(this.bot)}スロットしかなく、これから掘る分が入りません。先に空きを作ってください。${INVENTORY_FULL_RECOVERY_HINT_JA}${toolWarning}`,
        };
      }

      const here = this.bot.entity.position;
      // Geometric nearness alone made a 13m-deeper ore win over a similarly
      // distant ore 2m below, then spent the action budget tunnelling toward
      // it. Estimate vertical travel and excavation cost, but retain every
      // lower/buried candidate as a fallback if the easier route fails. A
      // block already diggable from here needs no approach at all.
      const reachable = new Set(candidates.filter(candidate => {
        const target = new Vec3(candidate.x, candidate.y, candidate.z);
        const block = this.bot.blockAt(target);
        return block && canDigFromHere(this.bot, block, target);
      }).map(candidate => targetKey(candidate)));
      const unreachable = recentlyUnreachable(this.bot);
      // A block whose drop would burn (lava under or beside it) takes water and a foothold to mine; one of
      // the same kind that needs neither comes first.
      const burning = new Set(candidates.filter(candidate => dropBurnsIn(this.bot as any, new Vec3(candidate.x, candidate.y, candidate.z)))
        .map(candidate => targetKey(candidate)));
      candidates.sort((a, b) => Number(reachable.has(targetKey(b))) - Number(reachable.has(targetKey(a)))
        || Number(unreachable.has(targetKey(a))) - Number(unreachable.has(targetKey(b)))
        || Number(burning.has(targetKey(a))) - Number(burning.has(targetKey(b)))
        || estimateBlockApproachCost(here, a, a.exposed) - estimateBlockApproachCost(here, b, b.exposed));

      const pos = candidates.shift()!;
      const target = new Vec3(pos.x, pos.y, pos.z);
      const block = this.bot.blockAt(target);
      if (!block || !familyNames.includes(block.name)) {
        continue;
      }
      if (noTimeFor(block, target)) { stoppedForTime = true; break; }

      if (!canDigFromHere(this.bot, block, target)) {
        // The pathfinder rarely plans a dig several blocks straight down to a
        // buried ore and gives up at once; descend by stairs toward it first,
        // as a player would, then approach.
        const stairMine = this.bot.instantSkills.getSkill('stair-mine');
        const here = this.bot.entity.position;
        if (stairMine && target.y < here.y - 3) {
          const dx = target.x + 0.5 - here.x, dz = target.z + 0.5 - here.z;
          const direction = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north');
          await stairMine.run(target.y + 1, direction, 'cobblestone');
        }
        // Not enough of the action left for the walk: said, with where the body is now, instead of a timeout.
        if (timeLeftMs() < APPROACH_MIN_MS) {
          approachNote = `${blockName}(${target.x}, ${target.y}, ${target.z})へ向かう途中で1回の行動の時間が尽きました（いま ${this.bot.entity.position.floored()}、あと約${Math.round(this.bot.entity.position.distanceTo(target))}m）。もう一度 mine-block を呼べば続きから進みます`;
          stoppedForTime = true;
          break;
        }
        const moveResult = await moveTo.run(target.x, target.y, target.z, DIG_REACH, 'block');
        if (!moveResult.success) {
          lastFailureType = moveResult.failureType ?? 'movement_failed';
          lastRecoverable = moveResult.recoverable ?? true;
          const closer = moveResult.failureType === 'movement_incomplete';
          failures.push(`移動失敗(${target.x},${target.y},${target.z}): ${moveResult.failureType ?? 'movement_failed'} — ${String(moveResult.result).slice(0, 200)}`);
          // A walk that ran out of time while getting nearer is not a place that cannot be reached: it is
          // gone on with at the next call, not put behind every other candidate.
          if (!closer) recentlyUnreachable(this.bot).set(targetKey(target), Date.now());
          if (closer || timeLeftMs() < APPROACH_MIN_MS) {
            approachNote = `${blockName}(${target.x}, ${target.y}, ${target.z})へ向かう途中です（いま ${this.bot.entity.position.floored()}、あと約${Math.round(this.bot.entity.position.distanceTo(target))}m）。もう一度 mine-block を呼べば続きから進みます`;
            stoppedForTime = true;
            break;
          }
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で到達失敗 — これ以上の候補を試行しません`);
            break;
          }
          continue;
        }
      }

      // ── バッチ採掘: 手の届く範囲の同種ブロックをまとめて掘る ──
      const batchTargets: Vec3[] = [target];
      // candidates から手の届く範囲のブロックも集める
      const maxBatch = Math.min(remainingToMine, 16);
      const kept: Array<{ x: number; y: number; z: number }> = [];
      for (const c of candidates) {
        if (batchTargets.length >= maxBatch) { kept.push(c); continue; }
        const cv = new Vec3(c.x, c.y, c.z);
        const blk = this.bot.blockAt(cv);
        if (blk && canDigFromHere(this.bot, blk, cv)) {
          if (familyNames.includes(blk.name)) {
            batchTargets.push(cv);
            continue;
          }
        }
        kept.push(c);
      }
      candidates.length = 0;
      candidates.push(...kept);

      if (batchTargets.length >= 2) {
        // ── 複数ブロックをまとめて掘る。安全な水平面だけ小分けで回収 ──
        log.info(`⛏️ バッチ採掘: ${batchTargets.length}個の${blockName}を一括で掘削`);
        let batchDug = 0;
        let batchAbortReason: { type: string; result: string } | null = null;
        const deferCollection = this.canDeferBatchCollection(blockName, batchTargets);
        let pendingOrigins: Vec3[] = [];
        let pendingBeforeInventory = inventoryCounts(this.bot);
        let pendingBeforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
        const flushPendingDrops = async () => {
          if (pendingOrigins.length === 0) return;
          const collected = await this.collectAllNearbyDrops(
            pendingOrigins, expectedItems, pendingBeforeEntityIds, collectionPolicy, pendingBeforeInventory,
          );
          if (collected.length > 0) log.info(`📦 小バッチ回収: ${collected.join(', ')}`, 'green');
          pendingOrigins = [];
        };

        for (const bt of batchTargets) {
          if (this.shouldInterrupt() || mined >= want) break;
          const blk = this.bot.blockAt(bt);
          if (!blk || !familyNames.includes(blk.name)) continue;
          if (noTimeFor(blk, bt)) { stoppedForTime = true; break; }

          // Collecting the previous block's drop may move the bot. A batch
          // selected in reach is not guaranteed to remain in reach afterwards.
          if (!canDigFromHere(this.bot, blk, bt)) {
            // Collect already-dug blocks before any movement can strand their
            // drops, then re-evaluate reach from the new position.
            await flushPendingDrops();
            const movement = await moveTo.run(bt.x, bt.y, bt.z, DIG_REACH, 'block');
            if (!movement.success) {
              lastFailureType = movement.failureType ?? 'movement_failed';
              lastRecoverable = movement.recoverable ?? true;
              consecutiveFailures++;
              failures.push(`移動失敗(${bt.x},${bt.y},${bt.z}): ${movement.result}`);
              recentlyUnreachable(this.bot).set(targetKey(bt), Date.now());
              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
              continue;
            }
            if (!familyNames.includes(this.bot.blockAt(bt)?.name ?? '')) continue;
          }

          // A block over lava is dug from a foothold with water over it, and its drop is left lying on the
          // floor the water makes under it. Walking down for each one would mean a new foothold each time:
          // those drops are gathered a few at a time too.
          const overLava = !!dropBurnsIn(this.bot as any, bt);
          let collectImmediately = !deferCollection && !overLava;
          if (!collectImmediately && pendingOrigins.length === 0) {
            pendingBeforeInventory = inventoryCounts(this.bot);
            pendingBeforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
          }
          let digResult = await digBlockAt.run(bt.x, bt.y, bt.z, collectImmediately, collectionPolicy, false, true);
          // 遮蔽物を除去した場合は同じブロックをリトライ
          if (digResult.failureType === 'obstruction_cleared') {
            await flushPendingDrops();
            collectImmediately = true;
            digResult = await digBlockAt.run(bt.x, bt.y, bt.z, true, collectionPolicy);
          }
          if (!digResult.success) await flushPendingDrops();
          if (digResult.failureType === 'missing_tool') {
            batchAbortReason = { type: 'missing_tool', result: digResult.result };
            break;
          }
          // Judged block by block: the one under the feet, or one with lava beside it, says nothing of the
          // next. Ending the whole order at the first of them left a body standing on the obsidian it had
          // made with every other piece of it in reach and untouched (lab, 2026-10-02).
          if (digResult.failureType === 'lava_danger' || digResult.failureType === 'drop_would_burn') {
            recentlyUnreachable(this.bot).set(targetKey(bt), Date.now());
          }
          // The body is under water and cannot dig there for want of air: no other block of the batch differs.
          if (digResult.failureType === 'air_short') { batchAbortReason = { type: 'air_short', result: digResult.result }; break; }
          if (digResult.success) {
            completedTargets.add(targetKey(bt));
            batchDug++;
            consecutiveFailures = 0;
            if (!collectImmediately) {
              pendingOrigins.push(bt);
              if (pendingOrigins.length >= 4) await flushPendingDrops();
            }
          } else {
            lastFailureType = digResult.failureType ?? 'dig_failed';
            lastRecoverable = digResult.recoverable ?? true;
            consecutiveFailures++;
            const failure = `採掘失敗(${bt.x},${bt.y},${bt.z}): ${digResult.failureType ?? 'dig_failed'} — ${digResult.result}`;
            if (failures.at(-1) !== failure) failures.push(failure);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          }
        }

        await flushPendingDrops();

        // Fortune can yield several items from one ore, so a batch inventory
        // total cannot prove that every dug block's drop was retrieved. Always
        // make a final sweep; deferred batches also allow the last drop time
        // to spawn before leaving the area.
        if (batchDug > 0) {
          const collected = await this.collectAllNearbyDrops(batchTargets, expectedItems, beforeEntityIds,
            collectionPolicy, inventoryCounts(this.bot), deferCollection ? 1200 : 0);
          if (collected.length > 0) {
            log.info(`📦 一括回収: ${collected.join(', ')}`, 'green');
          }
        }

        mined = completedTargets.size;
        if (stoppedForTime) break;

        if (batchAbortReason) {
          lastFailureType = batchAbortReason.type;
          lastRecoverable = true;
          failures.push(`${batchAbortReason.type === 'missing_tool' ? 'ツール不足' : '中止'}: ${batchAbortReason.result}`);
          break;
        }

        // ツルハシ生存チェック
        if (needsPickaxe) {
          const toolCheck = this.checkToolSurvival(want, mined);
          if (toolCheck) return toolCheck;
        }

        // Rescanning can now requeue failed targets. Preserve the existing
        // failure bound across batches instead of looping forever on them.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で採掘失敗 — 別のアプローチを検討してください`);
          break;
        }

        // Revalidate queued blocks cheaply before each dig. Rescan only when
        // the queue is exhausted; never scan after the requested count is met.

      } else {
        // ── 単体採掘: 従来通り collect=true で1個ずつ ──
        let digResult = await digBlockAt.run(target.x, target.y, target.z, true, collectionPolicy);
        if (digResult.failureType === 'obstruction_cleared') {
          digResult = await digBlockAt.run(target.x, target.y, target.z, true, collectionPolicy);
        }
        if (digResult.failureType === 'missing_tool') {
          lastFailureType = 'missing_tool';
          lastRecoverable = true;
          failures.push(`ツール不足: ${digResult.result}`);
          break;
        }
        if (digResult.failureType === 'lava_danger' || digResult.failureType === 'drop_would_burn') {
          recentlyUnreachable(this.bot).set(targetKey(target), Date.now());
        }
        if (digResult.failureType === 'air_short') {
          lastFailureType = 'air_short'; lastRecoverable = true;
          failures.push(`中止: ${digResult.result}`);
          break;
        }
        if (digResult.success) {
          completedTargets.add(targetKey(target));
          mined = completedTargets.size;
          consecutiveFailures = 0;

          if (needsPickaxe) {
            const toolCheck = this.checkToolSurvival(want, mined);
            if (toolCheck) return toolCheck;
          }

          reportActionProgress(this.bot, 'confirm', { completed: mined, requested: want }, true);
        } else {
          lastFailureType = digResult.failureType ?? 'dig_failed';
          lastRecoverable = digResult.recoverable ?? true;
          const failure = `採掘失敗(${target.x},${target.y},${target.z}): ${digResult.failureType ?? 'dig_failed'} — ${digResult.result}`;
          if (failures.at(-1) !== failure) failures.push(failure);
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
      ? ` 【満杯前整理】空きが少ないためここで中断しました。先に空きを作ってから続行してください。${INVENTORY_FULL_RECOVERY_HINT_JA}`
      : '';

    if (mined === 0) {
      if (approachNote) {
        return { success: false, failureType: 'movement_incomplete', recoverable: true,
          result: `まだ${blockName}を掘っていません。${approachNote}${toolWarning}` };
      }
      return {
        success: false,
        result: `${blockName}を採掘できませんでした${failures.length > 0 ? `: ${failures.join(', ')}` : ''}`
          + (failures.some(failure => failure.startsWith('移動失敗')) ? '。到達できなかった位置は次回から後回しにします（崖の上などは別の場所の同じ資源を探す）' : ''),
        failureType: lastFailureType ?? 'mine_failed',
        recoverable: lastRecoverable || failures.length === 0,
      };
    }

    // 採掘後のインベントリ差分からドロップアイテムを検出
    const drops = this.detectDrops(beforeInventory).filter(drop => collectionPolicy === 'all'
      || expectedItems.length === 0 || expectedItems.includes(drop.item));
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
    const timeNote = stoppedForTime && mined < count
      ? `1回の行動の時間（${Math.round((this.maxDurationMs || 120_000) / 1000)}秒）を使い切る前に区切りました。掘った分は回収済みです。`
      : '';
    // Flint is a 10% gravel drop; without the hint a planner keeps searching for more gravel.
    const flintNote = blockName === 'gravel' && !drops.some(drop => drop.item === 'flint')
      ? '。flint（火打石）は砂利1個あたり約10%で落ちる。必要なら所持した砂利をplace-block-atで置き直してdig-block-atで掘り直せる'
      : '';
    return {
      success: !isPartial,
      result: isPartial
        ? `${blockName}を${count}個中${mined}個${timeNote ? '' : 'のみ'}採掘しました${dropsText}${totalsText}。${timeNote}残り${count - mined}個${timeNote ? 'は、' : 'が不足しています。'}再度 mine-block を実行してください${tightNote}${failures.length > 0 ? `（失敗詳細: ${failures.join(', ')}）` : ''}${toolWarning}`
        : `${blockName}を${mined}個採掘しました${dropsText}${totalsText}${failures.length > 0 ? `（一部失敗: ${failures.join(', ')}）` : ''}${toolWarning}${flintNote}`,
      ...(isPartial && { failureType: stoppedForInventoryTight ? 'inventory_full' : 'partial_completion', recoverable: true }),
    };
    } finally {
      this.bot.removeListener('diggingCompleted', onDiggingCompleted);
    }
  }

  /**
   * バッチ掘削後に周辺のドロップアイテムを一括回収する。
   * inventory 差分で確認しながら、近くの item エンティティに歩いて拾う。
   */
  private async collectAllNearbyDrops(origins: Vec3[], expectedItems: string[],
    beforeEntityIds: Set<number>, policy: CollectionPolicy,
    beforeInventory = inventoryCounts(this.bot), spawnWaitMs = 0): Promise<string[]> {
    return collectDrops(this.bot, { origins, expectedItems, beforeEntityIds, policy,
      beforeInventory, spawnWaitMs, radius: 16 });
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
